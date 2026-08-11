import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityRegistry, CapabilityRuntime } from "@codebridge/policy";
import {
  McpRuntime,
  SdkMcpClientFactory,
  McpServerRegistry,
  type McpClient,
  type McpClientFactory,
  type McpTool,
} from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("MCP runtime", () => {
  it("connects to a standard MCP stdio server with the official SDK", async () => {
    const factory = new SdkMcpClientFactory();
    const client = await factory.connect({
      id: "fixture",
      transport: "stdio",
      command: process.execPath,
      args: [path.join(import.meta.dirname, "test-server.mjs")],
    });
    await expect(client.health()).resolves.toBeUndefined();
    await expect(client.listTools()).resolves.toEqual([
      expect.objectContaining({ name: "echo", description: "Echo a value" }),
    ]);
    await expect(client.callTool("echo", { value: "hello" }, {})).resolves.toMatchObject({
      content: [{ type: "text", text: "hello" }],
    });
    await client.close?.();
  });

  it("persists server definitions and health without embedding credential values", async () => {
    const directory = temporaryDirectory();
    const databasePath = path.join(directory, "mcp.sqlite");
    const first = new McpServerRegistry(databasePath);
    first.registerServer({
      id: "observability",
      transport: "stdio",
      command: "npx",
      args: ["observability-mcp"],
      env: ["OBSERVABILITY_TOKEN"],
      revision: "config:1",
    });
    first.recordHealth("observability", "healthy");
    first.close();

    const reopened = new McpServerRegistry(databasePath);
    expect(reopened.getServer("observability")).toMatchObject({
      command: "npx",
      args: ["observability-mcp"],
      env: ["OBSERVABILITY_TOKEN"],
      revision: "config:1",
      health: { status: "healthy", error: null },
    });
    reopened.close();
  });

  it("discovers tools as candidates without granting execution", async () => {
    const registry = new McpServerRegistry(":memory:");
    registry.registerServer({ id: "logs", transport: "http", url: "https://mcp.example.test", revision: "config:2" });
    const capabilities = new CapabilityRegistry();
    const adapters = new CapabilityRuntime();
    const runtime = new McpRuntime(registry, fakeFactory([
      { name: "search", description: "Search logs", inputSchema: { type: "object" } },
    ]), capabilities, adapters);

    const candidates = await runtime.discover("logs");
    expect(candidates).toEqual([
      expect.objectContaining({
        serverId: "logs",
        toolName: "search",
        suggestedCapabilityId: "mcp.logs.search",
        adapterId: "mcp:logs/search",
        status: "candidate",
      }),
    ]);
    expect(capabilities.list()).toEqual([]);
    expect(adapters.has("mcp:logs/search")).toBe(false);
    expect(registry.getServer("logs")?.health.status).toBe("healthy");
    await runtime.close();
    capabilities.close();
    registry.close();
  });

  it("binds an approved candidate to the shared capability runtime", async () => {
    const calls: unknown[] = [];
    const registry = new McpServerRegistry(":memory:");
    registry.registerServer({ id: "catalog", transport: "stdio", command: "catalog-mcp", revision: "config:3" });
    const capabilities = new CapabilityRegistry();
    const adapters = new CapabilityRuntime();
    const runtime = new McpRuntime(registry, fakeFactory([
      { name: "lookup", description: "Lookup catalog", inputSchema: { type: "object" } },
    ], calls), capabilities, adapters);
    const [candidate] = await runtime.discover("catalog");

    const accepted = await runtime.approveCandidate(candidate!.id, {
      capabilityId: "catalog.lookup",
      risk: "read_only",
      environments: ["local"],
    });
    expect(accepted.status).toBe("accepted");
    expect(capabilities.get("catalog.lookup")).toMatchObject({
      adapter: "mcp:catalog/lookup",
      source: {
        kind: "mcp",
        ref: "catalog/lookup",
        version: "config:3",
        revision: candidate!.revision,
      },
    });
    await expect(adapters.execute("mcp:catalog/lookup", {
      input: { id: "sku-1" },
      context: { runId: "run_1" },
    })).resolves.toMatchObject({ output: { found: true } });
    expect(calls).toEqual([["lookup", { id: "sku-1" }, { runId: "run_1" }]]);
    await runtime.close();
    capabilities.close();
    registry.close();
  });

  it("marks removed tools stale and records failed health checks", async () => {
    const registry = new McpServerRegistry(":memory:");
    registry.registerServer({ id: "dynamic", transport: "stdio", command: "dynamic-mcp" });
    let tools: McpTool[] = [{ name: "old_tool", inputSchema: {} }];
    const client: McpClient = {
      health: async () => undefined,
      listTools: async () => tools,
      callTool: async () => null,
    };
    const runtime = new McpRuntime(
      registry,
      { connect: async () => client },
      new CapabilityRegistry(),
      new CapabilityRuntime(),
    );
    const [candidate] = await runtime.discover("dynamic");
    tools = [];
    await runtime.discover("dynamic");
    expect(registry.getCandidate(candidate!.id)?.status).toBe("stale");
    client.health = async () => { throw new Error("offline"); };
    await expect(runtime.refreshHealth("dynamic")).rejects.toThrow("offline");
    expect(registry.getServer("dynamic")?.health).toMatchObject({ status: "unavailable", error: "offline" });
    await runtime.close();
    registry.close();
  });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-mcp-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeFactory(tools: McpTool[], calls: unknown[] = []): McpClientFactory {
  return {
    connect: async () => ({
      health: async () => undefined,
      listTools: async () => tools,
      callTool: async (tool, input, context) => {
        calls.push([tool, input, context]);
        return { found: true };
      },
    }),
  };
}
