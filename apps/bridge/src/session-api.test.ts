import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionCatalogStore, type AgentProfile } from "@codebridge/session-catalog";
import { createSessionApp } from "./session-api.js";

const TOKEN = "session-token";
const agents: AgentProfile[] = [
  {
    agentId: "codex",
    displayName: "Codex",
    adapter: "acp",
    status: "healthy",
    capabilities: ["session"],
    models: [],
    sessionFeatures: ["resume"],
  },
  {
    agentId: "pi",
    displayName: "Pi",
    adapter: "sdk",
    status: "healthy",
    capabilities: ["session"],
    models: [],
    sessionFeatures: ["resume"],
  },
];

describe("session API", () => {
  it("creates a session fixed to an Agent and maps messages to a TaskRecord", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);

    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "pi" }),
    });
    expect(create.status).toBe(201);
    const session = (await create.json()) as { session_id: string; agent_id: string };
    expect(session.agent_id).toBe("pi");

    const message = await app.request(`/v1/sessions/${session.session_id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "检查当前上下文", flow_id: "flow-a" }),
    });
    expect(message.status).toBe(202);
    const accepted = (await message.json()) as { task_record_id: string };
    expect(accepted.task_record_id).toMatch(/^wi_/);

    const current = await app.request(`/v1/sessions/${session.session_id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await current.json()).toMatchObject({ task_record_id: accepted.task_record_id, flow_id: "flow-a" });
    expect(workItems.listEvents(accepted.task_record_id).map((event) => event.type)).toContain("MESSAGE_RECEIVED");
    catalog.close();
    workItems.close();
  });

  it("groups sessions through the Agent registry and protects the API", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    expect((await app.request("/v1/agents")).status).toBe(401);
    catalog.createSession({ agentId: "codex", title: "会话" });

    const response = await app.request("/v1/sessions?agent_id=codex", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { sessions: unknown[] }).sessions).toHaveLength(1);
    catalog.close();
    workItems.close();
  });
});
