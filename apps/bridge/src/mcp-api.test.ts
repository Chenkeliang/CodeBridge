import { describe, expect, it } from "vitest";
import { CapabilityRegistry, CapabilityRuntime } from "@codebridge/policy";
import { McpRuntime, McpServerRegistry } from "@codebridge/mcp-runtime";
import { createMcpApp } from "./mcp-api.js";

const TOKEN = "mcp-api-token";

describe("MCP API", () => {
  it("discovers and explicitly approves a capability candidate", async () => {
    const registry = new McpServerRegistry(":memory:");
    registry.registerServer({ id: "catalog", transport: "stdio", command: "catalog-mcp", revision: "config:1" });
    const capabilities = new CapabilityRegistry();
    const runtime = new McpRuntime(
      registry,
      {
        connect: async () => ({
          health: async () => undefined,
          listTools: async () => [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
          callTool: async () => ({ ok: true }),
        }),
      },
      capabilities,
      new CapabilityRuntime(),
    );
    const app = createMcpApp(registry, runtime, TOKEN);

    const discovery = await app.request("/v1/mcp/servers/catalog/discover", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(discovery.status).toBe(200);
    const candidates = await app.request("/v1/mcp/candidates", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = await candidates.json() as { candidates: Array<{ id: string; status: string }> };
    expect(body.candidates).toEqual([expect.objectContaining({ status: "candidate" })]);

    const approved = await app.request(`/v1/mcp/candidates/${body.candidates[0]!.id}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ capability_id: "catalog.lookup", risk: "read_only", environments: ["local"] }),
    });
    expect(approved.status).toBe(200);
    expect(capabilities.get("catalog.lookup")?.adapter).toBe("mcp:catalog/lookup");
    await runtime.close();
    capabilities.close();
    registry.close();
  });

  it("does not expose MCP state without the shared bearer token", async () => {
    const registry = new McpServerRegistry(":memory:");
    const runtime = new McpRuntime(registry, { connect: async () => { throw new Error("unused"); } }, new CapabilityRegistry(), new CapabilityRuntime());
    const app = createMcpApp(registry, runtime, TOKEN);
    expect((await app.request("/v1/mcp/servers")).status).toBe(401);
    await runtime.close();
    registry.close();
  });
});
