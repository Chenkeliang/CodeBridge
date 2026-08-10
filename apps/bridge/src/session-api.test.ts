import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionCatalogStore, type AgentProfile } from "@codebridge/session-catalog";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import { createSessionApp } from "./session-api.js";
import type { RunnerClient } from "@codebridge/runner-client";

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
      body: JSON.stringify({ agent_id: "pi", model: "pi-model" }),
    });
    expect(create.status).toBe(201);
    const session = (await create.json()) as { session_id: string; agent_id: string; model: string | null };
    expect(session.agent_id).toBe("pi");
    expect(session.model).toBe("pi-model");

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

  it("imports provider sessions into the Session Catalog on demand", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      listSessions: async () => ({ sessions: [{ id: "provider-1", backend: "codex", cwd: "/tmp/project", preview: "已有会话", updatedAt: "2026-08-07T00:00:00.000Z" }] }),
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner, defaultCwd: "/tmp/project" }, TOKEN);
    const response = await app.request("/v1/sessions?import=true&agent_id=codex", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect((await response.json() as { sessions: Array<{ provider_session_id: string }> }).sessions[0]?.provider_session_id).toBe("provider-1");
    catalog.close();
    workItems.close();
  });

  it("creates a new Session from a provider-native fork", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      forkSession: async () => ({ ok: true, sessionId: "pi-forked", cwd: "/tmp/target" }),
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);
    const source = catalog.createSession({ agentId: "pi", cwd: "/tmp/source", providerSessionId: "pi-source" });

    const response = await app.request(`/v1/sessions/${source.id}/fork`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ target_cwd: "/tmp/target" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      agent_id: "pi",
      provider_session_id: "pi-forked",
      cwd: "/tmp/target",
      status: "idle",
    });
    expect(catalog.listSessions("pi")).toHaveLength(2);
    catalog.close();
    workItems.close();
  });

  it("authorizes and canonicalizes an optional Session workspace", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      authorizeDirectory: async (directory: string) => ({ ok: true, path: `/canonical${directory}` }),
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);

    const response = await app.request("/v1/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "pi", cwd: "/workspace" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ cwd: "/canonical/workspace" });
    catalog.close();
    workItems.close();
  });

  it("rejects a Session workspace when Runner authorization fails", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      authorizeDirectory: async () => ({ ok: false, error: "permission denied" }),
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);

    const response = await app.request("/v1/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "pi", cwd: "/private" }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "workspace_not_authorized" });
    expect(catalog.listSessions("pi")).toHaveLength(0);
    catalog.close();
    workItems.close();
  });

  it("starts project discovery asynchronously on the first message in a workspace Session", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    let observed: { workspacePath: string; workItemId?: string } | undefined;
    const discovery = {
      observe: async (workspacePath: string, workItemId?: string) => {
        observed = { workspacePath, workItemId };
        return {};
      },
    } as unknown as import("@codebridge/project-catalog").ProjectDiscovery;
    const app = createSessionApp({ catalog, agents, workItems, discovery }, TOKEN);
    const session = catalog.createSession({ agentId: "pi", cwd: "/workspace" });

    const response = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "检查当前目录" }),
    });
    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed).toMatchObject({ workspacePath: "/workspace" });
    expect(observed?.workItemId).toMatch(/^wi_/);
    catalog.close();
    workItems.close();
  });

  it("deletes provider history before removing Session metadata", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const deleted: string[] = [];
    const runner = {
      deleteSession: async (agentId: string, cwd: string, providerSessionId: string) => {
        deleted.push(agentId, cwd, providerSessionId);
        return { ok: true };
      },
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);
    const session = catalog.createSession({ agentId: "pi", cwd: "/workspace", providerSessionId: "pi-session" });

    const response = await app.request(`/v1/sessions/${session.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(204);
    expect(deleted).toEqual(["pi", "/workspace", "pi-session"]);
    expect(catalog.getSession(session.id)).toBeUndefined();
    catalog.close();
    workItems.close();
  });

  it("resumes the Session event stream from Last-Event-ID", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });
    const message = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "事件恢复" }),
    });
    const taskId = (await message.json() as { task_record_id: string }).task_record_id;
    workItems.appendEvent({ workItemId: taskId, type: "AGENT_EVENT", actor: "agent", payload: { text: "继续" } });
    const response = await app.request(`/v1/sessions/${session.id}/events`, {
      headers: { authorization: `Bearer ${TOKEN}`, "Last-Event-ID": "1" },
    });
    expect(await response.text()).toContain("AGENT_EVENT");
    catalog.close();
    workItems.close();
  });

  it("makes Session creation, messages and Runs idempotent", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const createInit = {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "Idempotency-Key": "session-1" },
      body: JSON.stringify({ agent_id: "pi" }),
    };
    const firstCreate = await app.request("/v1/sessions", createInit);
    const secondCreate = await app.request("/v1/sessions", createInit);
    const session = await firstCreate.json() as { session_id: string };
    expect((await secondCreate.json() as { session_id: string }).session_id).toBe(session.session_id);
    const messageInit = {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "Idempotency-Key": "message-1" },
      body: JSON.stringify({ message: "同一个消息" }),
    };
    const firstMessage = await app.request(`/v1/sessions/${session.session_id}/messages`, messageInit);
    const secondMessage = await app.request(`/v1/sessions/${session.session_id}/messages`, messageInit);
    const firstMessageBody = await firstMessage.json() as { task_record_id: string };
    expect(await secondMessage.json()).toEqual(firstMessageBody);
    const runInit = {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "Idempotency-Key": "run-1" },
      body: JSON.stringify({}),
    };
    const firstRun = await app.request(`/v1/sessions/${session.session_id}/runs`, runInit);
    const secondRun = await app.request(`/v1/sessions/${session.session_id}/runs`, runInit);
    expect(await secondRun.json()).toEqual(await firstRun.json());
    expect(workItems.listRuns(firstMessageBody.task_record_id)).toHaveLength(1);
    catalog.close();
    workItems.close();
  });

  it("compiles the selected Workflow revision into a persisted Run Plan", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const flows = new FlowCatalogStore(":memory:");
    flows.save({
      flowId: "review-change",
      name: "Review change",
      kind: "runbook",
      status: "published",
      source: "git",
      definitionRevision: "git:abc123",
      reviewStatus: "approved",
      gitRevision: "abc123",
      steps: [
        { id: "inspect", capability: "context.inspect", mode: "read_only" },
        {
          id: "change",
          capability: "workspace.change",
          mode: "workspace_write",
          dependsOn: ["inspect"],
        },
      ],
    });
    const app = createSessionApp({ catalog, agents, workItems, flows }, TOKEN);
    const session = catalog.createSession({ agentId: "pi", cwd: "/workspace" });
    const message = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "检查后修改", flow_id: "review-change" }),
    });
    const taskId = (await message.json() as { task_record_id: string }).task_record_id;

    const response = await app.request(`/v1/sessions/${session.id}/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ flow_id: "review-change" }),
    });

    expect(response.status).toBe(202);
    const body = await response.json() as { run_id: string; plan_id: string; workflow_revision: string };
    const run = workItems.getRun(body.run_id)!;
    expect(body).toMatchObject({ plan_id: run.planId, workflow_revision: "git:abc123" });
    expect(workItems.getWorkItem(taskId)).toMatchObject({
      workflowId: "review-change",
      workflowRevision: "git:abc123",
    });
    expect(workItems.getPlanForRun(run.id)).toMatchObject({
      planId: run.planId,
      workflowId: "review-change",
      definitionRevision: "git:abc123",
      sessionId: session.id,
      steps: [
        { id: "inspect", capabilityId: "context.inspect" },
        { id: "change", capabilityId: "workspace.change", dependsOn: ["inspect"] },
      ],
    });
    expect(workItems.listEvents(taskId).map((event) => event.type)).toContain("PLAN_VALIDATED");
    flows.close();
    catalog.close();
    workItems.close();
  });
});
