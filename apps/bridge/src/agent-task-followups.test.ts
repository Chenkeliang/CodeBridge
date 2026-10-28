import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore, defaultConfig, type FollowupObservation, type AgentTaskDefinition } from "@codebridge/core";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SessionCoordinator } from "@codebridge/session-coordinator";
import { SqliteEventStore } from "@codebridge/work-items";
import { AgentTaskStore } from "./agent-task-store.js";
import { AgentTaskService } from "./agent-tasks.js";
import { createManagementApp } from "./management-api.js";
import { LocalTaskManager } from "./managed-local-tasks.js";
import { ManagedRunbooks } from "./managed-runbooks.js";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach((f) => f()); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-followup-"));
  const tasks = new AgentTaskStore(path.join(root, "tasks.sqlite")), items = new SqliteEventStore(":memory:"), catalog = new SessionCatalogStore(":memory:");
  let now = new Date("2026-10-28T00:00:00Z");
  const config = defaultConfig(); config.access = { ...config.access, allowedChats: ["oc_example"] };
  const coordinator = new SessionCoordinator(items, { maxQueuedTurns: 10, now: () => now });
  let service: AgentTaskService;
  let observation: FollowupObservation = { status: "waiting", summary: "还在等待" };
  let result = "模型完整结果\n" + "证据内容。".repeat(500);
  const sendFollowup = vi.fn(async (_target: unknown, _text: string, context: { isCurrent: () => boolean }): Promise<{ messageId: string } | false> => context.isCurrent() ? { messageId: "om_example_notice" } : false), control: { hold?: Promise<void>; closed?: boolean; maintenance?: boolean; onComplete?: () => void } = {};
  const executor = { isExecuting: () => false, cancelRun: vi.fn((id: string) => {
    const run = items.getRun(id)!; return coordinator.finishRun({ sessionId: run.sessionId!, runId: id, status: "cancelled" }).run;
  }), execute: vi.fn(async (id: string) => {
    const run = items.getRun(id)!; items.updateRunStatus(id, "running");
    if (control.hold) await control.hold;
    if (items.getRun(id)!.status === "cancelled") return items.getRun(id)!;
    await service.observeFollowup(id, observation);
    items.appendEvent({ workItemId: run.workItemId, runId: id, type: "AGENT_EVENT", actor: "agent", payload: { event: { type: "text_delta", phase: "final_answer", text: result } } });
    control.onComplete?.();
    return coordinator.finishRun({ sessionId: run.sessionId!, runId: id, status: "succeeded" }).run;
  }) };
  const options = { store: tasks, workItems: items, catalog, coordinator, executor, config: () => config,
    agents: () => [{ agentId: "codex", displayName: "Example Agent", adapter: "acp" as const, status: "healthy" as const, models: [], capabilities: ["session" as const], sessionFeatures: ["resume" as const] }],
    runner: { authorizeDirectory: async (cwd: string) => ({ ok: true, path: cwd }), listTaskSkills: async () => ({ skills: [], targets: [], summary: { total: 0, sources: 0, linked: 0, issues: 0 }, scanned_at: now.toISOString() }) },
    connected: () => true, send: vi.fn(async () => {}), sendFollowup,
    feishuMembers: vi.fn(async () => [{ id: "ou_example_a", name: "示例成员甲" }, { id: "ou_example_b", name: "示例成员乙" }]), dataDir: root, now: () => now };
  Object.assign(options, { followupIsClosed: () => control.closed ?? false, isMaintenance: () => control.maintenance ?? false });
  service = new AgentTaskService(options);
  fs.writeFileSync(path.join(root, "config.yaml"), JSON.stringify(config));
  const configStore = new ConfigStore({ dataDir: root });
  const app = createManagementApp({ store: configStore, dataDir: root, token: "fixture-followup-api", tasks: service,
    local: new LocalTaskManager({ dataDir: root, home: root, platform: "darwin", run: () => "" }), runbooks: new ManagedRunbooks(root) });
  const requestApi = (route: string, runId: string, method = "GET", body?: unknown, revision?: string) => app.request("http://localhost/v1/management" + route, { method,
    headers: { authorization: "Bearer fixture-followup-api", "x-codebridge-run-id": runId, "content-type": "application/json", ...(revision ? { "if-match": revision } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  function source(user = "ou_example_a", sharedSession?: string) {
    const session = sharedSession ? catalog.getSession(sharedSession)! : catalog.createSession({ agentId: "codex", cwd: root });
    const submitted = coordinator.submitTurn({ sessionId: session.id, idempotencyKey: "source:" + user,
      message: { text: "请持续查询并通知", attachmentIds: [], model: null, effort: null, permissionMode: null, executionKind: "agent", plan: null, actorRef: { channel: "feishu", id: user }, replyContext: { senderId: user, threadId: "omt_example" } },
      workItem: { title: "Example request", mode: "auto", agentId: "codex", conversationId: "oc_example|om_example", workspaceScope: [root], riskLevel: "read_only" },
      delivery: { channel: "feishu", conversationId: "oc_example|om_example", replyToMessageId: "om_source_" + user, showThinking: false } });
    items.updateRunStatus(submitted.run!.id, "running");
    return submitted;
  }
  const original = source();
  const request = { name: "示例跟进", prompt: "只查询是否有结果，不重复初始操作", intervalMinutes: 1, timeoutMinutes: 3, allowedNotifyNames: ["示例成员乙"] };
  const settle = async () => { await vi.waitFor(() => expect(tasks.unsettled().filter(a => a.runId && !["succeeded", "failed", "skipped", "cancelled", "interrupted"].includes(a.status))).toHaveLength(0)); await service.tick(); };
  cleanup.push(() => { tasks.close(); items.close(); catalog.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { config, tasks, items, catalog, coordinator, service, options, executor, sendFollowup, original, request, source, settle, requestApi, control,
    advance: (minutes: number) => { now = new Date(now.getTime() + minutes * 60000); }, observe: (v: FollowupObservation) => { observation = v; }, result: (v: string) => { result = v; } };
}

describe("bounded followup runtime", () => {
  it("binds real provenance, deduplicates creation and separates notification from management", async () => {
    const f = fixture(), task = await f.service.createFollowup(f.original.run!.id, f.request);
    f.advance(1);
    expect((await f.service.createFollowup(f.original.run!.id, f.request)).id).toBe(task.id);
    expect(f.tasks.list()).toHaveLength(1); expect(f.executor.execute).not.toHaveBeenCalled();
    expect(task.target).toEqual({ channel: "feishu", chatId: "oc_example", topicId: "om_example" });
    expect(task.followup).toMatchObject({ origin: { creatorId: "ou_example_a", managerIds: ["ou_example_a"] }, defaultRecipientIds: ["ou_example_a"] });
    f.coordinator.finishRun({ sessionId: f.original.run!.sessionId!, runId: f.original.run!.id, status: "succeeded" });
    const other = f.source("ou_example_b", f.original.run!.sessionId!);
    expect(() => f.service.assertTaskAccess(task.id, other.run!.id)).toThrow("无权");
    await expect(f.service.createFollowup(other.run!.id, { ...f.request, target: { channel: "local" } })).rejects.toThrow();
  });
  it("stays silent while waiting, preserves the full result and notifies only the selected member", async () => {
    const f = fixture(), task = await f.service.createFollowup(f.original.run!.id, f.request);
    f.advance(1); await f.service.tick(); await f.settle(); expect(f.sendFollowup).not.toHaveBeenCalled();
    f.observe({ status: "completed", summary: "已拿到结果", notifyNames: ["示例成员乙"] });
    f.advance(1); await f.service.tick(); await f.settle();
    expect(f.tasks.get(task.id)?.followup?.status).toBe("completed"); expect(f.tasks.get(task.id)?.enabled).toBe(false);
    expect(f.sendFollowup).toHaveBeenCalledTimes(1);
    expect(f.sendFollowup.mock.calls[0]).toEqual([task.target, expect.stringContaining("证据内容。".repeat(500)), expect.objectContaining({ recipientOpenIds: ["ou_example_b"], sourceMessageId: "om_source_ou_example_a" })]);
    f.advance(10); await f.service.tick(); expect(f.executor.execute).toHaveBeenCalledTimes(2);
  });
  it("expires after a restart without running or replaying missed queries", async () => {
    const f = fixture(), task = await f.service.createFollowup(f.original.run!.id, f.request);
    f.advance(10);
    const restarted = new AgentTaskService(f.options);
    await restarted.tick(); await restarted.tick();
    expect(f.tasks.get(task.id)?.followup?.status).toBe("expired");
    expect(f.executor.execute).not.toHaveBeenCalled(); expect(f.sendFollowup).toHaveBeenCalledTimes(1);
  });
  it("enforces the same two-user ownership on the live management routes", async () => {
    const f = fixture(), runId = f.original.run!.id;
    const revision = ((await (await f.requestApi("/agent-tasks", runId)).json()) as { revision: string }).revision;
    expect((await f.requestApi("/followups", runId, "POST", { runId: "run_forged", request: f.request }, revision)).status).toBe(403);
    const response = await f.requestApi("/followups", runId, "POST", { runId, request: f.request }, revision);
    expect(response.status).toBe(201);
    const task = ((await response.json()) as { task: AgentTaskDefinition }).task;
    f.coordinator.finishRun({ sessionId: f.original.run!.sessionId!, runId, status: "succeeded" });
    const other = f.source("ou_example_b", f.original.run!.sessionId!);
    expect((await f.requestApi("/agent-tasks/" + task.id, other.run!.id)).status).toBe(403);
    expect(((await (await f.requestApi("/agent-tasks", other.run!.id)).json()) as { tasks: unknown[] }).tasks).toEqual([]);
    expect((await f.requestApi("/followup-stop", other.run!.id, "POST", { runId: other.run!.id, taskId: task.id }, revision)).status).toBe(403);
    expect(f.tasks.get(task.id)?.enabled).toBe(true);
  });
  it("deduplicates progress across polling attempts and preserves continuity through quiet checks", async () => {
    const f = fixture(); await f.service.createFollowup(f.original.run!.id, { ...f.request, timeoutMinutes: 10 });
    f.observe({ status: "progress", summary: "仓配任务已创建", key: "warehouse-task-created", notifyNames: ["示例成员乙"] });
    for (let i = 0; i < 2; i++) { f.advance(1); await f.service.tick(); await f.settle(); }
    expect(f.sendFollowup).toHaveBeenCalledTimes(1);
    f.observe({ status: "waiting", summary: "仍在等单号" }); f.advance(1); await f.service.tick(); await f.settle();
    expect(f.tasks.list()[0]?.followup?.lastSummary).toBe("仓配任务已创建");
    expect(f.sendFollowup).toHaveBeenCalledTimes(1);
  });
  it("stops without replay and rejects late observations and deadline extension", async () => {
    const f = fixture(), task = await f.service.createFollowup(f.original.run!.id, f.request);
    await f.service.setEnabled(task.id, task.version, false, () => {});
    f.advance(10); await f.service.tick();
    expect(f.executor.execute).not.toHaveBeenCalled(); expect(f.sendFollowup).not.toHaveBeenCalled();
    expect(f.tasks.get(task.id)?.followup?.status).toBe("cancelled");
    await expect(f.service.setEnabled(task.id, f.tasks.get(task.id)!.version, true, () => {})).rejects.toThrow("不能恢复");
    await expect(f.service.runNow(task.id, f.tasks.get(task.id)!.version, "retry")).rejects.toThrow("已结束");
  });
  it("does not replace a missing named recipient with the requester", async () => {
    const f = fixture(); await f.service.createFollowup(f.original.run!.id, f.request);
    f.options.feishuMembers.mockResolvedValue([{ id: "ou_example_a", name: "示例成员甲" }]);
    f.observe({ status: "completed", summary: "已有结果", notifyNames: ["示例成员乙"] }); f.advance(1); await f.service.tick(); await f.settle();
    expect(f.sendFollowup.mock.calls[0]).toEqual([expect.anything(), expect.stringContaining("未发送定向提醒"), expect.objectContaining({ recipientOpenIds: [] })]);
    expect(f.tasks.attempts().items[0]?.deliveryState).toBe("failed");
  });
  it("rechecks a named default recipient when group membership becomes ambiguous", async () => {
    const f = fixture(); await f.service.createFollowup(f.original.run!.id, { ...f.request, notifyNames: ["示例成员乙"] });
    f.options.feishuMembers.mockResolvedValue([{ id: "ou_example_a", name: "示例成员甲" }, { id: "ou_example_b", name: "示例成员乙" }, { id: "ou_example_c", name: "示例成员乙" }]);
    f.observe({ status: "completed", summary: "已有结果" }); f.advance(1); await f.service.tick(); await f.settle();
    expect(f.sendFollowup).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("无法唯一确认"), expect.objectContaining({ recipientOpenIds: [] }));
    expect(f.tasks.attempts().items[0]?.deliveryState).toBe("failed");
  });
  it("cancels an in-flight query at its deadline and does not accept its late result", async () => {
    const f = fixture(); let release!: () => void;
    f.control.hold = new Promise<void>(resolve => { release = resolve; });
    const task = await f.service.createFollowup(f.original.run!.id, f.request);
    f.advance(1); await f.service.tick();
    await vi.waitFor(() => expect(f.executor.execute).toHaveBeenCalledTimes(1));
    const attempt = f.tasks.attempts(task.id).items[0]!;
    f.advance(3); await f.service.tick();
    expect(f.executor.cancelRun).toHaveBeenCalledWith(attempt.runId);
    expect(f.tasks.get(task.id)?.followup?.status).toBe("expired");
    await expect(f.service.observeFollowup(attempt.runId!, { status: "completed", summary: "late" })).rejects.toThrow();
    release(); await f.settle();
    expect(f.sendFollowup).toHaveBeenCalledTimes(1); expect(f.executor.execute).toHaveBeenCalledTimes(1);
  });
  it("resends a cached notification without repeating the query after an unknown send", async () => {
    const f = fixture(); await f.service.createFollowup(f.original.run!.id, f.request);
    f.sendFollowup.mockRejectedValueOnce(new Error("fixture transport timeout"));
    f.observe({ status: "completed", summary: "已有结果", notifyNames: ["示例成员乙"] }); f.advance(1); await f.service.tick(); await f.settle();
    const attempt = f.tasks.attempts().items[0]!;
    expect(attempt.deliveryState).toBe("unknown");
    await f.service.resend(attempt.id, "same-receipt"); await f.service.resend(attempt.id, "same-receipt");
    expect(f.executor.execute).toHaveBeenCalledTimes(1); expect(f.sendFollowup).toHaveBeenCalledTimes(2);
    expect(f.tasks.notices(attempt.id)).toEqual(expect.arrayContaining([expect.objectContaining({ state: "unknown" }), expect.objectContaining({ state: "sent", kind: "resend" })]));
  });
  it("stops without another query or reminder when the source case is closed", async () => {
    const f = fixture(), task = await f.service.createFollowup(f.original.run!.id, f.request);
    f.control.closed = true; f.advance(1); await f.service.tick();
    expect(f.tasks.get(task.id)?.followup?.status).toBe("cancelled");
    expect(f.executor.execute).not.toHaveBeenCalled(); expect(f.sendFollowup).not.toHaveBeenCalled();
  });
  it("rejects ambiguous members and stops on revoked requester access", async () => {
    const f = fixture();
    f.options.feishuMembers.mockResolvedValueOnce([{ id: "ou_example_a", name: "示例成员甲" }, { id: "ou_example_b", name: "示例成员乙" }, { id: "ou_example_c", name: "示例成员乙" }]);
    await expect(f.service.createFollowup(f.original.run!.id, f.request)).rejects.toThrow("同名");
    expect(f.tasks.list()).toEqual([]);
    const task = await f.service.createFollowup(f.original.run!.id, f.request);
    f.config.access!.allowedUsers = ["ou_example_b"]; f.advance(1); await f.service.tick();
    expect(f.tasks.get(task.id)?.followup?.status).toBe("blocked");
    expect(f.executor.execute).not.toHaveBeenCalled(); expect(f.sendFollowup).not.toHaveBeenCalled();
  });
  it("accepts a configured alert source without making its recipient an approver", async () => {
    const f = fixture();
    f.config.feishu.alertMonitor = { enabled: true, pollIntervalMs: 60000, lookbackMs: 600000, dedupWindowMs: 1800000, maxConcurrent: 1, incidentRetentionMs: 604800000,
      groups: [{ chatId: "oc_example", senderAppIds: ["cli_example_alarm"], approverOpenIds: ["ou_example_a"] }] };
    const bot = f.source("cli_example_alarm");
    const task = await f.service.createFollowup(bot.run!.id, { ...f.request, notifyNames: ["示例成员乙"] });
    expect(task.followup).toMatchObject({ origin: { creatorId: "cli_example_alarm", managerIds: ["ou_example_a"] }, defaultRecipientIds: ["ou_example_b"] });
    const other = f.source("ou_example_b"); expect(() => f.service.assertTaskAccess(task.id, other.run!.id)).toThrow("无权");
    expect(f.config.feishu.alertMonitor.groups[0]!.approverOpenIds).toEqual(["ou_example_a"]);
  });
  it("delivers a known completed result after restart without expiring it or rerunning the query", async () => {
    const f = fixture(); await f.service.createFollowup(f.original.run!.id, f.request);
    f.observe({ status: "completed", summary: "已经查到结果" });
    f.control.onComplete = () => { f.control.maintenance = true; };
    f.advance(1); await f.service.tick(); await f.settle();
    expect(f.tasks.list()[0]?.followup?.status).toBe("completed"); expect(f.sendFollowup).not.toHaveBeenCalled();
    f.advance(10); f.control.maintenance = false;
    await new AgentTaskService(f.options).tick();
    expect(f.sendFollowup).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("模型完整结果"), expect.anything());
    expect(f.executor.execute).toHaveBeenCalledTimes(1);
  });
  it("takes each round's model from the current source binding without changing its deadline", async () => {
    const f = fixture(); let model = "example-model-first";
    Object.assign(f.options, { followupOptions: () => ({ agentId: "codex", cwd: f.options.dataDir, model, effort: "high", permissionMode: null }) });
    const task = await f.service.createFollowup(f.original.run!.id, f.request);
    f.advance(1); await f.service.tick(); await f.settle();
    expect(f.tasks.attempts(task.id).items[0]?.definition.model).toBe("example-model-first");
    model = "example-model-second";
    f.advance(1); await f.service.tick(); await f.settle();
    expect(f.tasks.attempts(task.id).items[0]?.definition.model).toBe("example-model-second");
    expect(f.tasks.get(task.id)?.model).toBeNull();
    expect(f.tasks.get(task.id)?.followup?.deadlineAt).toBe(task.followup!.deadlineAt);
    expect(f.tasks.attempts(task.id).items.every(a => a.definition.effort === "high")).toBe(true);
  });
});
