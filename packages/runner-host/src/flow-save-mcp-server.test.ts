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
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  FLOW_SAVE_NO_SOURCE_MESSAGE,
  FLOW_SAVE_TOOL_MARKER,
  FLOW_SAVE_TOOL_NAME,
} from "@codebridge/core";
import {
  createFlowSaveMcpServer,
  createFlowSaveMcpServerConfig,
  readFlowSaveAvailabilityFromEnv,
} from "./flow-save-mcp-server.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
let childFixtureDir = "";
let builtServerPath = "";

beforeAll(async () => {
  childFixtureDir = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "codebridge-flow-save-mcp-child-",
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
  const coreSourcePath = path.join(repoRoot, "packages/core/src/flow-save-tool.ts");
  const serverSourcePath = path.join(
    repoRoot,
    "packages/runner-host/src/flow-save-mcp-server.ts",
  );
  const coreSource = await fs.readFile(coreSourcePath, "utf8");
  const rawServerSource = await fs.readFile(serverSourcePath, "utf8");
  const serverSource = rawServerSource
    .replace('from "@codebridge/core";', 'from "./flow-save-tool.mjs";');
  if (serverSource === rawServerSource) {
    throw new Error("Flow save MCP child fixture did not replace the core import");
  }
  await fs.writeFile(
    path.join(childFixtureDir, "flow-save-tool.mjs"),
    compile(coreSource, coreSourcePath),
  );
  builtServerPath = path.join(childFixtureDir, "flow-save-mcp-server.mjs");
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

async function connectedClient(available: boolean) {
  const server = createFlowSaveMcpServer(available
    ? { available: true }
    : {
        available: false,
        code: "no_extractable_previous_run",
        message: FLOW_SAVE_NO_SOURCE_MESSAGE,
      });
  const client = new Client({ name: "flow-save-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("CodeBridge internal Flow save MCP server", () => {
  it("registers exactly one explicit-intent read-only tool", async () => {
    const { client, server } = await connectedClient(true);
    try {
      const result = await client.listTools();
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]).toMatchObject({
        name: FLOW_SAVE_TOOL_NAME,
        description: expect.stringMatching(/明确.*确认入口由客户端展示/s),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["source_scope"],
        },
      });
      expect(result.tools[0]?.description).not.toContain("已保存");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns the canonical accepted marker without HTTP or shell execution", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { client, server } = await connectedClient(true);
    try {
      const result = await client.callTool({
        name: FLOW_SAVE_TOOL_NAME,
        arguments: { source_scope: "previous_completed_run" },
      });
      expect(result.structuredContent).toEqual({
        codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
        accepted: true,
        source_scope: "previous_completed_run",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns the fixed fallback for an unavailable dispatch snapshot", async () => {
    const { client, server } = await connectedClient(false);
    try {
      const result = await client.callTool({
        name: FLOW_SAVE_TOOL_NAME,
        arguments: { source_scope: "previous_completed_run" },
      });
      expect(result.structuredContent).toEqual({
        codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
        accepted: false,
        source_scope: "previous_completed_run",
        code: "no_extractable_previous_run",
        message: FLOW_SAVE_NO_SOURCE_MESSAGE,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects arbitrary source identifiers instead of stripping them", async () => {
    const { client, server } = await connectedClient(true);
    try {
      const result = await client.callTool({
        name: FLOW_SAVE_TOOL_NAME,
        arguments: {
          source_scope: "previous_completed_run",
          run_id: "run_forbidden",
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("run_id"),
        }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("parses only the non-sensitive availability environment contract", () => {
    expect(readFlowSaveAvailabilityFromEnv({
      CODEBRIDGE_FLOW_SAVE_SOURCE_AVAILABILITY: "true",
    })).toEqual({ available: true });
    expect(readFlowSaveAvailabilityFromEnv({
      CODEBRIDGE_FLOW_SAVE_SOURCE_AVAILABILITY: "false",
    })).toEqual({
      available: false,
      code: "no_extractable_previous_run",
      message: FLOW_SAVE_NO_SOURCE_MESSAGE,
    });
  });

  it.each([
    ["true", true],
    ["false", false],
  ] as const)("serves %s over a real stdio child with protocol-only stdout", async (raw, accepted) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [builtServerPath],
      env: { CODEBRIDGE_FLOW_SAVE_SOURCE_AVAILABILITY: raw },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const protocolErrors: Error[] = [];
    const client = new Client({ name: "flow-save-child-test", version: "1.0.0" });
    client.onerror = (error) => protocolErrors.push(error);
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name))
        .toEqual([FLOW_SAVE_TOOL_NAME]);
      const result = await client.callTool({
        name: FLOW_SAVE_TOOL_NAME,
        arguments: { source_scope: "previous_completed_run" },
      });
      expect(result.structuredContent).toMatchObject({
        codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
        accepted,
        source_scope: "previous_completed_run",
      });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nchild stderr: ${stderr}`,
      );
    } finally {
      await client.close();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(protocolErrors).toEqual([]);
    expect(stderr).toBe("");
  }, 15_000);
});


describe("deployment MCP transport", () => {
  it("binds each server config to a distinct run even without flow availability", () => {
    const first = createFlowSaveMcpServerConfig("/tmp/server.js", undefined, { api: "http://127.0.0.1:19790", token: "private", runId: "run_one" });
    const second = createFlowSaveMcpServerConfig("/tmp/server.js", undefined, { api: "http://127.0.0.1:19790", token: "private", runId: "run_two" });
    expect(first.env.FCB_RUN_ID).toBe("run_one");
    expect(second.env.FCB_RUN_ID).toBe("run_two");
    expect(JSON.stringify(first.env)).not.toBe(JSON.stringify(second.env));
    expect(first.env.CODEBRIDGE_FLOW_SAVE_SOURCE_AVAILABILITY).toBeUndefined();
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
