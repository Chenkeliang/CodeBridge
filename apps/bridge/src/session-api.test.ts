import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionCatalogStore, type AgentProfile } from "@codebridge/session-catalog";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import { ApprovalService, CapabilityRegistry } from "@codebridge/policy";
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

  it("renames, pins, and archives a Session through its metadata API", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "codex", title: "原始名称" }),
    });
    const session = await create.json() as { session_id: string };
    const renamed = await app.request(`/v1/sessions/${session.session_id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "重命名后的会话", pinned: true }),
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ title: "重命名后的会话", pinned_at: expect.any(String), archived_at: null });

    const archived = await app.request(`/v1/sessions/${session.session_id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ archived_at: expect.any(String), pinned_at: null });
    expect((await (await app.request("/v1/sessions", { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { sessions: unknown[] }).sessions).toHaveLength(0);
    expect((await (await app.request("/v1/sessions?include_archived=true", { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { sessions: unknown[] }).sessions).toHaveLength(1);
    catalog.close();
    workItems.close();
  });

  it("reads Agent health dynamically for later Session creation", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    let status: AgentProfile["status"] = "unavailable";
    const app = createSessionApp({
      catalog,
      agents: () => [{ ...agents[1]!, status }],
      workItems,
    }, TOKEN);
    const unavailable = await app.request("/v1/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "pi" }),
    });
    expect(unavailable.status).toBe(409);

    status = "healthy";
    const healthy = await app.request("/v1/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "pi" }),
    });
    expect(healthy.status).toBe(201);
    catalog.close();
    workItems.close();
  });

  it("maps channel conversations onto the same Session Message and Run contracts", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const send = (message: string) => app.request("/v1/channels/feishu/conversations/chat%3Atopic/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message, agent_id: "pi" }),
    });

    const first = await send("第一条");
    expect(first.status).toBe(202);
    const firstBody = await first.json() as { session_id: string; task_record_id: string; run_id: string };
    const secondBody = await (await send("第二条")).json() as typeof firstBody;
    expect(secondBody.session_id).toBe(firstBody.session_id);
    expect(secondBody.task_record_id).toBe(firstBody.task_record_id);
    expect(secondBody.run_id).not.toBe(firstBody.run_id);
    expect(catalog.getChannelSession("feishu", "chat:topic")?.id).toBe(firstBody.session_id);
    expect(workItems.listRuns(firstBody.task_record_id)).toHaveLength(2);
    catalog.close();
    workItems.close();
  });

  it("cancels a channel-bound Run and resolves its approval through the same ingress", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const approvals = new ApprovalService(workItems, ":memory:");
    const app = createSessionApp({ catalog, agents, workItems, approvals }, TOKEN);
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const accepted = await app.request("/v1/channels/telegram/conversations/chat/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "发布", agent_id: "pi" }),
    });
    const body = await accepted.json() as { session_id: string; task_record_id: string; run_id: string };
    workItems.updateRunStatus(body.run_id, "waiting");
    const approval = approvals.request({
      workItemId: body.task_record_id,
      runId: body.run_id,
      stepId: "release",
      capabilityId: "release.execute",
      sessionId: body.session_id,
      environment: "production",
      targetResource: "service/release",
      inputHash: "sha256:test",
      requestedBy: "system",
    });
    const resolved = await app.request("/v1/channels/telegram/conversations/chat/approval", {
      method: "POST",
      headers,
      body: JSON.stringify({ approve: true }),
    });
    expect(await resolved.json()).toMatchObject({ resolved: true, approval_id: approval.id });
    expect(approvals.get(approval.id)?.status).toBe("granted");
    const cancelled = await app.request("/v1/channels/telegram/conversations/chat/cancel", { method: "POST", headers });
    expect(await cancelled.json()).toMatchObject({ stopped: true, run_id: body.run_id });
    expect(workItems.getRun(body.run_id)?.status).toBe("cancelled");
    approvals.close();
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

  it("adds and removes authorized additional directories for a Session", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const authorized: string[] = [];
    const runner = {
      authorizeDirectory: async (directory: string) => {
        authorized.push(directory);
        return { ok: true, path: `/canonical${directory}` };
      },
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);
    const session = catalog.createSession({ agentId: "pi", cwd: "/workspace" });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

    const added = await app.request(`/v1/sessions/${session.id}/directories`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "/shared" }),
    });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({
      session_id: session.id,
      additional_directories: ["/canonical/shared"],
    });
    expect(authorized).toEqual(["/shared"]);

    const duplicate = await app.request(`/v1/sessions/${session.id}/directories`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "/shared" }),
    });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json() as { additional_directories: string[] }).additional_directories)
      .toEqual(["/canonical/shared"]);

    const removed = await app.request(`/v1/sessions/${session.id}/directories`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ path: "/canonical/shared" }),
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      session_id: session.id,
      additional_directories: [],
    });
    catalog.close();
    workItems.close();
  });

  it("picks an additional directory without accepting a path from the browser", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      pickDirectory: async () => ({ ok: true, path: "/canonical/shared" }),
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);
    const session = catalog.createSession({ agentId: "pi", cwd: "/workspace" });
    const response = await app.request(`/v1/sessions/${session.id}/directories/pick`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      session_id: session.id,
      additional_directories: ["/canonical/shared"],
    });
    catalog.close();
    workItems.close();
  });

  it("returns live Agent config options for a Session", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      listConfigOptions: async () => ({
        options: [{ id: "model", name: "Model", type: "select", category: "model", values: [{ value: "model-1", name: "Model 1" }] }],
      }),
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner, defaultCwd: "/workspace" }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });
    const response = await app.request(`/v1/sessions/${session.id}/config-options`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ options: [{ id: "model" }] });
    catalog.close();
    workItems.close();
  });

  it("merges native and session-advertised Agent commands", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      listCommands: async () => ({ commands: [{ name: "skill:review", description: "Review" }] }),
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner, defaultCwd: "/workspace" }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });
    const message = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    const taskId = (await message.json() as { task_record_id: string }).task_record_id;
    workItems.appendEvent({
      workItemId: taskId,
      type: "AGENT_EVENT",
      actor: "adapter",
      payload: { event: { type: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact context" }] } },
    });

    const response = await app.request(`/v1/sessions/${session.id}/commands`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await response.json()).toEqual({
      commands: [
        { name: "skill:review", description: "Review" },
        { name: "compact", description: "Compact context" },
      ],
    });
    catalog.close();
    workItems.close();
  });

  it("keeps the command menu available when Runner command discovery fails", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      listCommands: async () => { throw new Error("Runner command endpoint unavailable"); },
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner, defaultCwd: "/workspace" }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });

    const response = await app.request(`/v1/sessions/${session.id}/commands`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      commands: [],
      error: "Runner command endpoint unavailable",
    });
    catalog.close();
    workItems.close();
  });

  it("does not mutate additional directories when authorization is unavailable", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });
    const response = await app.request(`/v1/sessions/${session.id}/directories`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ path: "/shared" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "runner_unavailable" });
    expect(catalog.getSession(session.id)?.additionalDirectories).toEqual([]);
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

  it("keeps an opt-in Session SSE stream open for later events", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });
    const message = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "持续事件" }),
    });
    const taskId = (await message.json() as { task_record_id: string }).task_record_id;
    const response = await app.request(`/v1/sessions/${session.id}/events?after_sequence=2&live=true`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const reader = response.body!.getReader();
    workItems.appendEvent({
      workItemId: taskId,
      type: "AGENT_EVENT",
      actor: "agent",
      payload: { text: "later" },
    });
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timeout")), 2_000)),
    ]);
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("AGENT_EVENT");
    workItems.appendEvent({ workItemId: taskId, type: "VERIFICATION_COMPLETED", actor: "system" });
    const second = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timeout")), 2_000)),
    ]);
    expect(second.done).toBe(false);
    expect(new TextDecoder().decode(second.value)).toContain("VERIFICATION_COMPLETED");
    await reader.cancel();
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

  it("lists Runs for a Session as a stable status projection", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "检查状态" }),
    });
    const created = await app.request(`/v1/sessions/${session.id}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    const runId = (await created.json() as { run_id: string }).run_id;

    const response = await app.request(`/v1/sessions/${session.id}/runs`, { headers });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runs: [{ run_id: runId, session_id: session.id, status: "queued", agent_id: "pi" }],
    });
    catalog.close();
    workItems.close();
  });

  it("stores Session message attachments and returns reference metadata", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });
    const response = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: "请读取这个上下文",
        attachments: [{ name: "context.txt", mime_type: "text/plain", data_base64: Buffer.from("hello").toString("base64") }],
      }),
    });
    expect(response.status).toBe(202);
    const body = await response.json() as { attachment_ids: string[]; task_record_id: string };
    expect(body.attachment_ids).toHaveLength(1);
    expect(workItems.listEvents(body.task_record_id).at(-1)?.payload).toMatchObject({ attachment_ids: body.attachment_ids });

    const detail = await app.request(`/v1/attachments/${body.attachment_ids[0]}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ name: "context.txt", mime_type: "text/plain", content_hash: expect.stringMatching(/^sha256:/) });
    catalog.close();
    workItems.close();
  });

  it("compiles the selected Workflow revision into a persisted Run Plan", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const flows = new FlowCatalogStore(":memory:");
    const capabilities = new CapabilityRegistry();
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
    const app = createSessionApp({ catalog, agents, workItems, flows, capabilities }, TOKEN);
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
    expect(capabilities.get("context.inspect")).toMatchObject({ adapter: "agent", risk: "read_only" });
    expect(capabilities.get("workspace.change")).toMatchObject({ adapter: "agent", risk: "workspace_write" });
    capabilities.close();
    flows.close();
    catalog.close();
    workItems.close();
  });
});
