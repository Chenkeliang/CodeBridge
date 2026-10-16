import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore, defaultConfig, type AgentTaskDraft, type AlertIncidentView } from "@codebridge/core";
import { SessionCatalogStore, type AgentProfile } from "@codebridge/session-catalog";
import { SessionCoordinator } from "@codebridge/session-coordinator";
import { SqliteEventStore } from "@codebridge/work-items";
import { createManagementApp } from "./management-api.js";
import { LocalTaskManager } from "./managed-local-tasks.js";
import { ManagedRunbooks } from "./managed-runbooks.js";
import { AgentTaskStore } from "./agent-task-store.js";
import { AgentTaskService } from "./agent-tasks.js";
import { TaskAttentionService } from "./task-attention.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); });
const token = "fixture-task-api-token";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-task-api-"));
  vi.spyOn(os, "homedir").mockReturnValue(root);
  const config = defaultConfig(); config.runner.token = "env:UNIT_TASK_TOKEN"; config.workspaces = { root, default: root };
  config.access = { ...config.access, allowedChats: ["oc_fixture"] };
  config.feishu.alertMonitor = { pollIntervalMs: 30000, lookbackMs: 600000, dedupWindowMs: 1800000, maxConcurrent: 2, incidentRetentionMs: 604800000,
    groups: [{ chatId: "oc_fixture", senderAppIds: ["cli_alarm"], approverOpenIds: ["ou_fixture"] }] };
  fs.writeFileSync(path.join(root, "config.yaml"), stringify(config));
  const store = new ConfigStore({ dataDir: root, secrets: { env: { UNIT_TASK_TOKEN: token } } });
  const tasks = new AgentTaskStore(path.join(root, "tasks.sqlite")), items = new SqliteEventStore(path.join(root, "runs.sqlite")), catalog = new SessionCatalogStore(path.join(root, "sessions.sqlite"));
  const coordinator = new SessionCoordinator(items, { maxQueuedTurns: 10 });
  let hold: Promise<void> | undefined;
  const execute = vi.fn(async (id: string) => {
    if (hold) await hold;
    const run = items.getRun(id)!;
    items.appendEvent({ workItemId: run.workItemId, runId: id, type: "AGENT_EVENT", actor: "agent", payload: { event: { type: "text_delta", text: "API fixture result", phase: "final_answer" } } });
    coordinator.finishRun({ sessionId: run.sessionId!, runId: id, status: "succeeded" });
    return items.getRun(id)!;
  });
  const send = vi.fn(async () => {}), pending = vi.fn(async () => []);
  const service = new AgentTaskService({ store: tasks, workItems: items, catalog, coordinator, executor: { execute, isExecuting: () => false }, config: () => store.get(),
    agents: () => [{ agentId: "codex", displayName: "Fixture Codex", adapter: "acp", status: "healthy", capabilities: [], models: [], sessionFeatures: [] } as AgentProfile],
    runner: { authorizeDirectory: async (cwd) => ({ ok: true, path: cwd }), listTaskSkills: async () => ({ skills: [], targets: [], summary: { total: 0, sources: 0, linked: 0, issues: 0 }, scanned_at: new Date().toISOString() }) },
    connected: () => true, feishuChats: async () => [{ id: "oc_fixture", name: "Fixture group" }], send, dataDir: root });
  const attention = new TaskAttentionService({ catalog, workItems: items, tasks, approvals: { listForRun: () => [] }, pendingPermissions: pending });
  const incidents = vi.fn(async (): Promise<AlertIncidentView[]> => Array.from({ length: 3 }, (_, i) => ({ id: `om_fixture_${i}`, chatId: "oc_fixture", status: i ? "resolved" : "blocked", summary: `Fixture incident ${i}`,
    content: "Synthetic original alarm", senderAppId: "cli_alarm", firstSeenAt: "2026-10-15T00:00:00Z", lastSeenAt: "2026-10-15T00:01:00Z", repeatCount: 2, sourceMessageIds: [`om_fixture_${i}`, `om_duplicate_${i}`],
    responsibleOpenIds: ["ou_fixture"], approverOpenIds: ["ou_fixture"], sessionId: null, dismissal: null })));
  const app = createManagementApp({ store, dataDir: root, token, tasks: service, attention, incidents,
    local: new LocalTaskManager({ dataDir: root, home: root, platform: "darwin", run: () => "" }), runbooks: new ManagedRunbooks(root) });
  const request = (route: string, method = "GET", body?: unknown, revision?: string, key?: string, extra?: Record<string, string>) => app.request("http://localhost/v1/management" + route, { method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(revision ? { "if-match": revision } : {}), ...(key ? { "idempotency-key": key } : {}), ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const draft: AgentTaskDraft = { name: "API fixture task", prompt: "Read only synthetic input", agentId: "codex", cwd: root, skills: [], model: null, effort: null, permissionMode: null,
    schedule: "每10分钟", timezone: "Asia/Shanghai", target: { channel: "feishu", chatId: "oc_fixture" }, notification: "result", catchUp: "once", enabled: false };
  const revision = async () => ((await (await request("/agent-tasks")).json()) as { revision: string }).revision;
  const create = async () => {
    const rev = await revision(), response = await request("/agent-tasks", "POST", draft, rev, "create-fixture");
    expect(response.status).toBe(201); return (await response.json()) as { revision: string; task: { id: string; version: number } };
  };
  cleanup.push(async () => { await service.stop(); tasks.close(); items.close(); catalog.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, app, tasks, service, attention, items, catalog, coordinator, execute, send, pending, incidents, request, draft, revision, create, hold: (promise: Promise<void>) => { hold = promise; } };
}
describe("Agent task management HTTP contract", () => {
  it("requires local Host, Bearer, same Origin and current revision before creating a task", async () => {
    const f = fixture();
    expect((await f.app.request("/v1/management/agent-tasks")).status).toBe(401);
    expect((await f.app.request("http://attacker.example/v1/management/agent-tasks", { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    expect((await f.request("/agent-tasks", "POST", f.draft)).status).toBe(409);
    expect((await f.request("/agent-tasks", "POST", f.draft, await f.revision(), undefined, { origin: "https://attacker.example" })).status).toBe(403);
    expect(f.tasks.list()).toEqual([]); expect(f.execute).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("previews without executing and saves a paused definition without exposing service credentials", async () => {
    const f = fixture(), rev = await f.revision();
    const preflight = await f.request("/agent-tasks/preflight", "POST", f.draft, rev); expect(preflight.status).toBe(200); expect((await preflight.json() as { valid: boolean }).valid).toBe(true);
    const created = await f.create();
    expect((await f.request(`/agent-tasks/${created.task.id}`)).status).toBe(200);
    const text = await (await f.request("/agent-tasks")).text(); expect(text).not.toContain(token); expect(text).toContain("enabled\":false");
    expect(f.execute).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("runs once under duplicate requests, exposes the terminal result and resends without another execution", async () => {
    const f = fixture(), { task, revision } = await f.create();
    const routes = await Promise.all([f.request(`/agent-tasks/${task.id}/run`, "POST", { version: 1 }, revision, "same-action"), f.request(`/agent-tasks/${task.id}/run`, "POST", { version: 1 }, revision, "same-action")]);
    const a = await routes[0]!.json() as { attempt: { id: string } }, b = await routes[1]!.json() as { attempt: { id: string } }; expect(a.attempt.id).toBe(b.attempt.id);
    await vi.waitFor(() => expect(f.tasks.getAttempt(a.attempt.id)?.status).toBe("succeeded")); await f.service.tick();
    const detail = await (await f.request(`/agent-tasks/${task.id}/runs/${a.attempt.id}`)).json() as { attempt: { result: string } };
    expect(detail.attempt.result).toBe("API fixture result"); expect(f.execute).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce();
    const resend = await f.request(`/agent-tasks/${task.id}/runs/${a.attempt.id}/resend`, "POST", {}, revision, "only-resend");
    expect(resend.status).toBe(200); expect(f.send).toHaveBeenCalledTimes(2); expect(f.execute).toHaveBeenCalledOnce();
    expect((await f.request(`/agent-tasks/${task.id}/run`, "POST", { version: 1 }, revision)).status).toBe(400);
  });
  it("checks the task's own version and task/run relationship without overwriting the draft", async () => {
    const f = fixture(), { task, revision } = await f.create();
    const saved = await f.request(`/agent-tasks/${task.id}`, "PUT", { version: 1, task: { ...f.draft, prompt: "First edit" } }, revision); expect(saved.status).toBe(200);
    const stale = await f.request(`/agent-tasks/${task.id}`, "PUT", { version: 1, task: { ...f.draft, prompt: "Stale edit" } }, revision); expect(stale.status).toBe(409);
    expect(f.tasks.get(task.id)?.prompt).toBe("First edit");
    expect((await f.request(`/agent-tasks/${task.id}/runs/taskrun_wrong`)).status).toBe(404);
    expect((await f.request(`/agent-tasks/${task.id}?limit=900`)).status).toBe(400);
  });
  it("applies pause/resume separately and prevents a scheduled worker from creating more jobs", async () => {
    const f = fixture(), { task, revision } = await f.create();
    expect((await f.request(`/agent-tasks/${task.id}/resume`, "POST", { version: 1 }, revision)).status).toBe(200);
    expect(f.tasks.get(task.id)?.nextRunAt).not.toBeNull();
    expect((await f.request(`/agent-tasks/${task.id}/pause`, "POST", { version: 2 }, revision)).status).toBe(200);
    const run = await f.service.runNow(task.id, 3, "run-worker"); await vi.waitFor(() => expect(f.tasks.getAttempt(run.id)?.status).toBe("succeeded"));
    expect((await f.request("/agent-tasks", "POST", f.draft, revision, undefined, { "x-codebridge-run-id": run.runId! })).status).toBe(403);
  });
  it("filters and paginates real incident projections and refuses unconfigured groups", async () => {
    const f = fixture();
    const filtered = await f.request("/alerts/oc_fixture/incidents?status=resolved&limit=1"); expect(filtered.status).toBe(200);
    expect(await filtered.json()).toMatchObject({ total: 2, nextOffset: 1, items: [{ status: "resolved", repeatCount: 2 }] });
    expect((await f.request("/alerts/oc_other/incidents")).status).toBe(403); expect(f.incidents).toHaveBeenCalledTimes(1);
    expect((await f.request("/pending?kind=not-a-kind")).status).toBe(400);
    f.pending.mockRejectedValueOnce(new Error("fixture Runner offline"));
    expect(await (await f.request("/pending")).json()).toMatchObject({ items: [], issues: [expect.stringContaining("无法读取")] });
  });
});

it("recovers an ambiguous create response using the same key instead of creating a duplicate schedule", async () => {
  const f = fixture(), revision = await f.revision();
  const first = await f.request("/agent-tasks", "POST", f.draft, revision, "create-once");
  const repeated = await f.request("/agent-tasks", "POST", f.draft, revision, "create-once");
  expect(first.status).toBe(201); expect(repeated.status).toBe(201);
  expect(f.tasks.list()).toHaveLength(1);
  expect((await first.json() as { task: { id: string } }).task.id).toBe((await repeated.json() as { task: { id: string } }).task.id);
  expect((await f.request("/agent-tasks", "POST", { ...f.draft, name: "Different intent" }, revision, "create-once")).status).toBe(409);
});

it("archives the bytes actually sent, keeps the task's fixed recipient and does not inherit participant/status authority", async () => {
  const { createOutboundApp } = await import("./outbound-api.js");
  const f = fixture(); let release!: () => void; f.hold(new Promise((resolve) => { release = resolve; }));
  const { task, revision } = await f.create();
  try {
    const attempt = await f.service.runNow(task.id, 1, "file-source"); f.items.updateRunControl(attempt.runId!, { status: "running" });
    const output = path.join(f.root, "fixture.html"); fs.writeFileSync(output, "<h1>Synthetic output</h1>");
    const send = vi.fn(async (_chat: string, cached: string) => { fs.writeFileSync(output, "Changed source"); expect(fs.readFileSync(cached, "utf8")).toBe("<h1>Synthetic output</h1>"); return "fixture.html"; });
    const mention = vi.fn(async () => {}), status = vi.fn(async () => {});
    const outbound = createOutboundApp({ sendOutboundFile: send, sendOutboundMarkdown: async () => {}, sendOutboundMention: mention, setOutboundAlertStatus: status }, token,
      { workItemStore: f.items, taskTarget: (runId) => f.service.targetForRun(runId), taskFile: (runId, source) => f.service.prepareOutboundFile(runId, source) });
    const request = (route: string, body: unknown) => outbound.request(route, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const response = await request("/outbound/file", { runId: attempt.runId, path: output, chatId: "oc_attacker" });
    expect(response.status).toBe(200); expect(send).toHaveBeenCalledWith("oc_fixture", expect.any(String), undefined);
    expect((await request("/outbound/mention", { runId: attempt.runId, ref: "untrusted", text: "Synthetic mention" })).status).toBe(400);
    expect((await request("/outbound/alert-status", { runId: attempt.runId, status: "resolved", summary: "Synthetic" })).status).toBe(400);
    expect(mention).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
    const file = f.tasks.files(attempt.id)[0]!; const downloaded = await f.request(`/agent-task-files/${file.id}`);
    expect(downloaded.status).toBe(200); expect(downloaded.headers.get("content-type")).toBe("application/octet-stream"); expect(downloaded.headers.get("content-disposition")).toContain("attachment"); expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await downloaded.text()).toBe("<h1>Synthetic output</h1>"); expect(file.deliveryOwner).toBe("agent");
    release(); await vi.waitFor(() => expect(f.tasks.getAttempt(attempt.id)?.status).toBe("succeeded")); await f.service.tick();
    expect(f.execute).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce();
    expect((await f.request(`/agent-tasks/${task.id}/runs/${attempt.id}/outputs`, "POST", { path: output }, revision)).status).toBe(400);
  } finally { release(); }
});
