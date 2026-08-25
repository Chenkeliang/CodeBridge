import fs from "node:fs/promises";
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
        description: expect.stringContaining("明确"),
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
