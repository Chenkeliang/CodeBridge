import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  ModuleKind,
  ScriptTarget,
  transpileModule,
} from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createDeploymentMcpServerConfig,
} from "./deployment-mcp-server.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
let childFixtureDir = "";
let builtServerPath = "";

beforeAll(async () => {
  childFixtureDir = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "codebridge-deploy-mcp-child-",
  ));
  childFixtureDir = await fs.realpath(childFixtureDir);
  const compile = (source: string, fileName: string) =>
    transpileModule(source, {
      fileName,
      compilerOptions: {
        module: ModuleKind.ESNext,
        target: ScriptTarget.ES2022,
      },
    }).outputText;
  const serverSourcePath = path.join(
    repoRoot,
    "packages/runner-host/src/deployment-mcp-server.ts",
  );
  const serverSource = await fs.readFile(serverSourcePath, "utf8");
  builtServerPath = path.join(childFixtureDir, "deployment-mcp-server.mjs");
  await fs.writeFile(
    builtServerPath,
    compile(serverSource, serverSourcePath),
  );
  const fixtureNodeModules = path.join(childFixtureDir, "node_modules");
  await fs.mkdir(fixtureNodeModules);
  const requireFromCore = createRequire(path.join(repoRoot, "packages/core/package.json"));
  const zodDir = path.dirname(requireFromCore.resolve("zod/package.json"));
  await fs.symlink(zodDir, path.join(fixtureNodeModules, "zod"), "dir");
  const requireFromRunner = createRequire(path.join(
    repoRoot,
    "packages/runner-host/package.json",
  ));
  const mcpSdkDir = path.dirname(requireFromRunner.resolve(
    "@modelcontextprotocol/sdk/package.json",
  ));
  const mcpScopeDir = path.join(fixtureNodeModules, "@modelcontextprotocol");
  await fs.mkdir(mcpScopeDir);
  await fs.symlink(mcpSdkDir, path.join(mcpScopeDir, "sdk"), "dir");
});

afterAll(async () => {
  if (childFixtureDir) {
    await fs.rm(childFixtureDir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deployment MCP transport", () => {
  it("binds each server config to a distinct run", () => {
    const first = createDeploymentMcpServerConfig("/tmp/server.js", { api: "http://127.0.0.1:19790", token: "private", runId: "run_one" });
    const second = createDeploymentMcpServerConfig("/tmp/server.js", { api: "http://127.0.0.1:19790", token: "private", runId: "run_two" });
    expect(first.env.FCB_RUN_ID).toBe("run_one");
    expect(second.env.FCB_RUN_ID).toBe("run_two");
    expect(JSON.stringify(first.env)).not.toBe(JSON.stringify(second.env));
    expect(first.env.CODEBRIDGE_SAMPLE_FLAG).toBeUndefined();
  });
  it("serves a strict deployment tool over stdio using only its trusted environment identity", async () => {
    const requests: { body: unknown; auth?: string }[] = [];
    let status = 200;
    const httpServer = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()), auth: req.headers.authorization });
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ message: status === 200 ? "准备完成" : "explicit_publish_intent_required" }));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address() as { port: number };
    const client = new Client({ name: "deployment-test", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [builtServerPath], env: {
      FCB_API: `http://127.0.0.1:${address.port}`, FCB_TOKEN: "private-token", FCB_RUN_ID: "run_native",
    }, stderr: "pipe" });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual(["codebridge_deploy"]);
      expect(tools[0]?.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys(tools[0]?.inputSchema.properties ?? {})).toEqual(["action", "ref", "releaseId", "publishAfterPrepare"]);
      const spoof = await client.callTool({ name: "codebridge_deploy", arguments: { action: "status", runId: "forged" } });
      expect(spoof.isError).toBe(true); expect(requests).toHaveLength(0);
      const result = await client.callTool({ name: "codebridge_deploy", arguments: { action: "prepare", publishAfterPrepare: true, ref: "HEAD" } });
      expect(result.isError).toBe(false);
      expect(requests).toEqual([{ body: { action: "prepare", publishAfterPrepare: true, ref: "HEAD", runId: "run_native" }, auth: "Bearer private-token" }]);
      status = 403;
      const rejected = await client.callTool({ name: "codebridge_deploy", arguments: { action: "publish" } });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected.content)).toContain("explicit_publish_intent_required");
    } finally {
      await client.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
  it("rejects missing run identity before any HTTP request", async () => {
    const client = new Client({ name: "deployment-missing-run-test", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [builtServerPath], env: {
      FCB_API: "http://127.0.0.1:1", FCB_TOKEN: "private-token", FCB_RUN_ID: "",
    }, stderr: "pipe" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "codebridge_deploy", arguments: { action: "status" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("缺少当前任务身份");
    } finally { await client.close(); }
  });
});
