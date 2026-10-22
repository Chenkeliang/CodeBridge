import { FeishuBridge } from "@codebridge/channel-feishu";
import { TelegramBridge, TelegramApi } from "@codebridge/channel-telegram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type AgentEvent, type AgentTaskDraft, type AgentTaskTarget, type RunRequest } from "@codebridge/core";
import { SessionCatalogStore, type AgentProfile } from "@codebridge/session-catalog";
import { SessionCoordinator, SessionLeaseService } from "@codebridge/session-coordinator";
import { RunExecutor } from "@codebridge/run-executor";
import { SqliteEventStore } from "@codebridge/work-items";
import { AgentTaskStore } from "./agent-task-store.js";
import { AgentTaskService, type AgentTaskServiceOptions } from "./agent-tasks.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });
function fixture(target: AgentTaskTarget = { channel: "local" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-agent-tasks-"));
  vi.spyOn(os, "homedir").mockReturnValue(root);
  const config = defaultConfig(); config.workspaces = { root, default: root }; config.access = { ...config.access, allowedChats: ["oc_fixture"] };
  config.telegram = { botToken: "123456:fixture-token", allowedChats: ["-101"], pollingTimeoutSec: 25 };
  const tasks = new AgentTaskStore(path.join(root, "tasks.sqlite")), items = new SqliteEventStore(path.join(root, "runs.sqlite")), catalog = new SessionCatalogStore(path.join(root, "sessions.sqlite"));
  let clock = new Date("2026-10-15T00:00:00Z");
  const coordinator = new SessionCoordinator(items, { maxQueuedTurns: 100, now: () => clock });
  const requests: RunRequest[] = [], control: { hold?: Promise<void>; fail?: boolean; before?: (request: RunRequest) => Promise<void> } = {};
  const agents: AgentProfile[] = [{ agentId: "codex", displayName: "Fixture Codex", adapter: "acp", status: "healthy", models: [], capabilities: ["session"], sessionFeatures: ["resume"] }];
  let service: AgentTaskService;
  const executor = new RunExecutor(items, { async *run(request) {
    requests.push(request); await control.before?.(request); if (control.hold) await control.hold;
    if (control.fail) throw new Error("fixture backend failed");
    yield { type: "text_delta", text: "Fixture completed result", phase: "final_answer" } as AgentEvent;
    yield { type: "done", exitCode: 0 } as AgentEvent;
  } }, { sessionCoordinator: coordinator, sessionLeaseService: new SessionLeaseService(items), executorOwner: "fixture-task-owner", resolveRequest: async (item, run) => {
    const session = catalog.getSession(run.sessionId!)!;
    const request = { runId: run.id, sessionKey: { chatId: item.conversationId, backendId: session.agentId, cwd: session.cwd! }, prompt: items.listEvents(item.id).find((event) => event.type === "MESSAGE_RECEIVED")!.payload.message as string,
      model: session.model ?? undefined, effort: session.effort ?? undefined, mode: session.permissionMode ?? undefined };
    return service.prepareRunRequest(run, request);
  } });
  const send = vi.fn(async (_target: AgentTaskTarget, _text: string) => {}), sendFile = vi.fn(async (_target: AgentTaskTarget, _file: string) => {});
  const runner = { authorizeDirectory: vi.fn(async (cwd: string) => ({ ok: true, path: cwd })), listTaskSkills: vi.fn(async () => ({ skills: [], targets: [], summary: { total: 0, sources: 0, linked: 0, issues: 0 }, scanned_at: clock.toISOString() })) };
  const options: AgentTaskServiceOptions = { store: tasks, workItems: items, catalog, coordinator, executor, config: () => config, agents: () => agents, runner, connected: () => true,
    feishuChats: async () => [{ id: "oc_fixture", name: "Fixture group" }], send, sendFile, dataDir: root, now: () => clock };
  service = new AgentTaskService(options);
  const draft: AgentTaskDraft = { name: "Fixture scheduled report", prompt: "Read fixture and return a report", agentId: "codex", cwd: root, skills: [], model: "fixture-model", effort: "high", permissionMode: null,
    schedule: "每10分钟", timezone: "Asia/Shanghai", catchUp: "once", notification: "result", target, enabled: false };
  cleanups.push(async () => { await service.stop(); tasks.close(); items.close(); catalog.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const save = () => service.save(draft, () => {});
  const finish = async (attemptId: string) => { await vi.waitFor(() => expect(["succeeded", "failed", "cancelled", "interrupted"]).toContain(tasks.getAttempt(attemptId)?.status)); await service.tick(); await vi.waitFor(() => expect(tasks.getAttempt(attemptId)?.deliveryState).not.toBe("pending")); return tasks.getAttempt(attemptId)!; };
  return { root, config, tasks, items, catalog, coordinator, executor, requests, control, agents, runner, send, sendFile, service, options, draft, save, finish, setNow: (value: string) => { clock = new Date(value); } };
}
describe("Agent scheduled task runtime", () => {
  it("preflights and saves a paused task without invoking an Agent, sending a message or copying Skill data", async () => {
    const f = fixture();
    const preview = await f.service.preflight(f.draft);
    expect(preview.valid).toBe(true); expect(preview.nextRuns).toHaveLength(3);
    const saved = await f.save(); expect(saved.task.enabled).toBe(false); expect(f.tasks.list()).toHaveLength(1);
    expect(f.requests).toEqual([]); expect(f.send).not.toHaveBeenCalled(); expect(f.catalog.listSessions()).toEqual([]);
    expect(f.runner.authorizeDirectory).toHaveBeenCalledWith(f.root);
  });
  it("uses the real coordinator and executor once, preserving Agent settings and creating a fresh session for a retry", async () => {
    const f = fixture(), { task } = await f.save();
    const first = await f.service.runNow(task.id, task.version, "first");
    const finished = await f.finish(first.id);
    expect(finished).toMatchObject({ status: "succeeded", result: "Fixture completed result", deliveryState: "local" });
    expect(f.requests).toHaveLength(1); expect(f.requests[0]).toMatchObject({ model: "fixture-model", effort: "high", mode: undefined });
    expect((await f.service.runNow(task.id, task.version, "first")).id).toBe(first.id);
    expect(f.requests).toHaveLength(1);
    const retry = await f.service.runNow(task.id, task.version, "retry", false, first.id); await f.finish(retry.id);
    expect(retry.sessionId).not.toBe(first.sessionId); expect(retry.retryOf).toBe(first.id);
    expect(f.catalog.listSessions()).toHaveLength(2); expect(f.tasks.getAttempt(first.id)?.status).toBe("succeeded");
  });
  it.each<AgentTaskTarget>([{ channel: "feishu", chatId: "oc_fixture" }, { channel: "telegram", chatId: "-101", topicId: "8" }])("delivers a final result to the exact %s target", async (target) => {
    const f = fixture(target), { task } = await f.save();
    const run = await f.service.runNow(task.id, task.version, "first"); await f.finish(run.id);
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.send).toHaveBeenCalledWith(target, expect.stringContaining("Fixture completed result"));
    expect(f.items.listDeliveries(target.channel)).toEqual([]);
    expect(f.service.detail(run.id).notices).toEqual([expect.objectContaining({ state: "sent", kind: "result" })]);
  });
  it("suppresses successful error-only notifications while keeping failures visible", async () => {
    const f = fixture({ channel: "feishu", chatId: "oc_fixture" }); f.draft.notification = "errors";
    const { task } = await f.save(), first = await f.service.runNow(task.id, 1, "first");
    expect((await f.finish(first.id)).deliveryState).toBe("suppressed"); expect(f.send).not.toHaveBeenCalled();
    f.control.fail = true;
    const second = await f.service.runNow(task.id, 1, "second"); expect((await f.finish(second.id)).status).toBe("failed");
    expect(f.send).toHaveBeenCalledOnce(); expect(f.send.mock.calls[0]![1]).toContain("执行失败");
  });
  it("coalesces missed intervals into one execution and records skip policy without invoking the Agent", async () => {
    const f = fixture(); f.draft.enabled = true;
    const { task } = await f.save(); f.setNow("2026-10-16T01:00:00Z");
    await Promise.all([f.service.tick(), f.service.tick()]);
    const first = f.tasks.attempts(task.id).items[0]!; await f.finish(first.id);
    expect(f.tasks.attempts(task.id).total).toBe(1); expect(f.requests).toHaveLength(1);
    expect(f.tasks.get(task.id)?.nextRunAt).toBe("2026-10-16T01:10:00.000Z");
    const latest = f.tasks.get(task.id)!;
    await f.service.save({ ...f.draft, catchUp: "skip" }, () => {}, task.id, latest.version);
    f.setNow("2026-10-17T01:00:00Z"); await f.service.tick();
    expect(f.tasks.attempts(task.id).items[0]?.status).toBe("skipped"); expect(f.requests).toHaveLength(1);
  });
  it("does not overlap a long-running task and pause only stops future triggers", async () => {
    const f = fixture(); let release!: () => void; f.control.hold = new Promise((resolve) => { release = resolve; }); f.draft.enabled = true;
    const { task } = await f.save();
    try {
      const first = await f.service.runNow(task.id, task.version, "first"); await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.setNow("2026-10-15T00:10:00Z"); await f.service.tick();
      expect(f.tasks.attempts(task.id).items[0]?.status).toBe("skipped"); expect(f.requests).toHaveLength(1);
      const paused = await f.service.setEnabled(task.id, task.version, false, () => {});
      expect(paused.activeAttemptId).toBe(first.id); expect(f.executor.isExecuting(first.runId!)).toBe(true);
      release(); await f.finish(first.id);
    } finally { release(); }
  });
  it("recovers the admission gap using the committed submission receipt without creating a second Run", async () => {
    const f = fixture(), { task } = await f.save();
    const attempt = f.tasks.claim(task.id, { key: "manual:crash", trigger: "manual", scheduledAt: "2026-10-15T00:00:00Z", now: new Date("2026-10-15T00:00:00Z") })!;
    f.catalog.createSession({ id: attempt.sessionId, agentId: "codex", cwd: f.root });
    const receipt = f.coordinator.submitTurn({ sessionId: attempt.sessionId, idempotencyKey: `agent-task:${attempt.id}`,
      message: { text: f.draft.prompt, attachmentIds: [], model: null, effort: null, permissionMode: null, executionKind: "agent", plan: null },
      workItem: { title: f.draft.name, mode: "auto", conversationId: `conv_${attempt.sessionId.replace(/^sess_/, "")}`, agentId: "codex", workspaceScope: [f.root], riskLevel: "read_only" } });
    await f.service.tick(); await f.finish(attempt.id);
    expect(f.tasks.getAttempt(attempt.id)?.runId).toBe(receipt.run!.id); expect(f.items.listRuns(receipt.workItemId)).toHaveLength(1); expect(f.requests).toHaveLength(1);
  });
  it("does not re-execute or automatically resend an unknown notification; an explicit resend only sends the stored result", async () => {
    const f = fixture({ channel: "telegram", chatId: "-101" }); f.send.mockRejectedValueOnce(new Error("fixture network lost after acceptance"));
    const { task } = await f.save(), run = await f.service.runNow(task.id, 1, "first"); await f.finish(run.id);
    expect(f.tasks.getAttempt(run.id)?.deliveryState).toBe("unknown");
    await f.service.tick(); await f.service.tick(); expect(f.send).toHaveBeenCalledOnce(); expect(f.requests).toHaveLength(1);
    await f.service.resend(run.id, "resend-one"); await f.service.resend(run.id, "resend-one");
    expect(f.send).toHaveBeenCalledTimes(2); expect(f.requests).toHaveLength(1); expect(f.tasks.getAttempt(run.id)?.deliveryState).toBe("sent");
  });
  it("keeps the immutable destination and refuses delivery after that destination loses access", async () => {
    const f = fixture({ channel: "feishu", chatId: "oc_fixture" });
    f.control.before = async () => { f.config.access!.allowedChats = ["oc_different"]; };
    const { task } = await f.save(), run = await f.service.runNow(task.id, 1, "first"); await f.finish(run.id);
    expect(f.send).not.toHaveBeenCalled(); expect(f.tasks.getAttempt(run.id)?.deliveryState).toBe("failed");
    f.config.access!.allowedChats = ["oc_fixture"];
    await f.service.resend(run.id, "allowed-again"); expect(f.send).toHaveBeenCalledWith({ channel: "feishu", chatId: "oc_fixture" }, expect.any(String));
  });
  it("archives actual output bytes independently of the source file and only registers outputs for a running attempt", async () => {
    const f = fixture(); const output = path.join(f.root, "fixture-report.md"); fs.writeFileSync(output, "Original fixture output");
    let registered!: string;
    f.control.before = async (request) => { const attempt = f.tasks.forRun(request.runId)!; registered = f.service.recordFile(attempt.id, output).id; };
    const { task } = await f.save(), run = await f.service.runNow(task.id, 1, "first"); await f.finish(run.id);
    fs.writeFileSync(output, "Changed source");
    expect(fs.readFileSync(f.service.fileContent(registered).storedPath, "utf8")).toBe("Original fixture output");
    expect(f.service.detail(run.id).files[0]?.name).toBe("fixture-report.md");
    expect(() => f.service.recordFile(run.id, output)).toThrow("正在执行");
  });
  it("rechecks availability at execution time and rejects an async stale save without modifying the task", async () => {
    const f = fixture(), { task } = await f.save(); f.agents[0]!.status = "unavailable";
    const run = await f.service.runNow(task.id, 1, "first");
    const failed = await f.finish(run.id); expect(failed.status).toBe("failed"); expect(failed.reason).toContain("Agent尚未就绪"); expect(f.requests).toEqual([]);
    await expect(f.service.save({ ...f.draft, prompt: "Changed" }, () => { throw new Error("stale revision"); }, task.id, 1)).rejects.toThrow("stale revision");
    expect(f.tasks.get(task.id)?.prompt).toBe(f.draft.prompt);
  });
});

it("does not move a relative one-shot when only its prompt is edited", async () => {
  const f = fixture(); f.draft.enabled = true; f.draft.schedule = "30分钟后";
  const { task } = await f.save(); f.setNow("2026-10-15T00:05:00Z");
  const { taskDraft } = await import("./agent-task-store.js");
  await f.service.save({ ...taskDraft(task), prompt: "Edited fixture prompt" }, () => {}, task.id, task.version);
  expect(f.tasks.get(task.id)?.nextRunAt).toBe("2026-10-15T00:30:00.000Z");
  f.setNow("2026-10-15T00:30:00Z"); await f.service.tick();
  const run = f.tasks.attempts(task.id).items[0]!; await f.finish(run.id);
  expect(f.tasks.get(task.id)?.nextRunAt).toBeNull();
  f.setNow("2026-10-15T00:35:00Z"); await f.service.tick(); expect(f.requests).toHaveLength(1);
});

it("pauses after an interrupted outcome and only retries in a new session after acknowledgement", async () => {
  const f = fixture(); f.draft.enabled = true; let release!: () => void; f.control.hold = new Promise((resolve) => { release = resolve; });
  const { task } = await f.save();
  try {
    const first = await f.service.runNow(task.id, task.version, "first"); await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    f.coordinator.finishRun({ sessionId: first.sessionId, runId: first.runId!, status: "interrupted", reason: "fixture lease expired" });
    await f.service.tick(); expect(f.tasks.get(task.id)?.enabled).toBe(false); expect(f.tasks.get(task.id)?.pausedReason).toContain("结果不明");
    f.setNow("2026-10-17T00:00:00Z"); await f.service.tick(); expect(f.requests).toHaveLength(1);
    const current = f.tasks.get(task.id)!;
    await expect(f.service.runNow(task.id, current.version, "retry-denied", false, first.id)).rejects.toThrow("核对");
    release(); await vi.waitFor(() => expect(f.executor.isExecuting(first.runId!)).toBe(false));
    const retried = await f.service.runNow(task.id, current.version, "retry-reviewed", true, first.id); await f.finish(retried.id);
    expect(retried.sessionId).not.toBe(first.sessionId); expect(f.tasks.getAttempt(first.id)?.status).toBe("interrupted");
    expect(f.tasks.get(task.id)?.enabled).toBe(false); expect(f.tasks.get(task.id)?.pausedReason).not.toContain("结果不明");
  } finally { release(); }
});
it("keeps the current Agent permission visible in error-only mode and does not notify queued permission heads prematurely", async () => {
  const f = fixture({ channel: "feishu", chatId: "oc_fixture" }); f.draft.notification = "errors";
  let release!: () => void; f.control.hold = new Promise((resolve) => { release = resolve; });
  const { task } = await f.save();
  try {
    const run = await f.service.runNow(task.id, 1, "permissions"); await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    f.options.pendingPermissions = async () => [{ runId: run.runId!, requestId: "head", title: "Read fixture" }, { runId: run.runId!, requestId: "queued", title: "Write fixture later" }];
    await f.service.tick(); await f.service.tick();
    expect(f.send).toHaveBeenCalledOnce(); expect(f.send.mock.calls[0]![1]).toContain("Read fixture"); expect(f.send.mock.calls[0]![1]).not.toContain("Write fixture later");
    expect(f.tasks.getAttempt(run.id)?.status).toBe("waiting"); f.options.pendingPermissions = async () => []; release();
    expect((await f.finish(run.id)).deliveryState).toBe("suppressed"); expect(f.send).toHaveBeenCalledOnce();
  } finally { release(); }
});
it("emits start, real progress and final result without replaying unchanged progress", async () => {
  const f = fixture({ channel: "telegram", chatId: "-101" }); f.draft.notification = "progress";
  let release!: () => void; f.control.hold = new Promise((resolve) => { release = resolve; });
  f.control.before = async (request) => { const run = f.items.getRun(request.runId)!; for (const event of [{ type: "tool_start", name: "FixtureRead", toolCallId: "fixture-read" }, { type: "text_delta", phase: "commentary", text: "Reading fixture data" }]) f.items.appendEvent({ workItemId: run.workItemId, runId: run.id, type: "AGENT_EVENT", actor: "agent", payload: { event } }); };
  const { task } = await f.save();
  try {
    const run = await f.service.runNow(task.id, 1, "progress"); await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.send).toHaveBeenCalledOnce(); f.setNow("2026-10-15T00:00:31Z"); await f.service.tick(); expect(f.send).toHaveBeenCalledTimes(2);
    await f.service.tick(); expect(f.send).toHaveBeenCalledTimes(2); release(); await f.finish(run.id); expect(f.send).toHaveBeenCalledTimes(3);
  } finally { release(); }
});
it("keeps one private output record for identical bytes and delegates explicitly sent files to the Agent", async () => {
  const f = fixture({ channel: "feishu", chatId: "oc_fixture" });
  f.control.before = async (request) => {
    const output = path.join(f.root, "fixture-output.md"); fs.writeFileSync(output, "Synthetic output bytes");
    const attempt = f.tasks.forRun(request.runId)!;
    const first = f.service.recordFile(attempt.id, output), second = f.service.recordFile(attempt.id, output);
    expect(second.id).toBe(first.id);
    const archived = f.service.prepareOutboundFile(request.runId, output)!;
    expect(fs.readFileSync(archived, "utf8")).toBe("Synthetic output bytes"); expect(f.tasks.files(attempt.id)).toHaveLength(1);
    expect(f.tasks.files(attempt.id)[0]?.deliveryOwner).toBe("agent");
  };
  const { task } = await f.save(), run = await f.service.runNow(task.id, 1, "output-owner"); await f.finish(run.id);
  expect(f.sendFile).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledOnce();
});

it("passes the visible Skill's actual entry to the Agent rather than an opaque catalog id", async () => {
  const f = fixture(), skillPath = path.join(f.root, "skills", "fixture-workflow"); fs.mkdirSync(skillPath, { recursive: true }); fs.writeFileSync(path.join(skillPath, "SKILL.md"), "---\nname: fixture-workflow\ndescription: Synthetic workflow\n---\nRead only fixture inputs.");
  f.draft.skills = ["skill_opaque_fixture"];
  f.options.runner.listTaskSkills = async () => ({ skills: [{ id: "skill_opaque_fixture", name: "fixture-workflow", description: "Synthetic workflow", source_path: skillPath, source_kind: "shared", package_revision: "fixture-package", revision: "fixture-revision", global_state: "enabled", ownership: "codebridge_managed", can_apply: true, tags: [], updated_at: "2026-10-15T00:00:00Z", targets: [{ agent_id: "codex", delivery_mode: "symlink_projection", target_path: skillPath, state: "linked", mutable: true, detail: null }] }], targets: [], summary: { total: 1, sources: 1, linked: 1, issues: 0 }, scanned_at: "2026-10-15T00:00:00Z" });
  const { task } = await f.save(), run = await f.service.runNow(task.id, 1, "skill-entry"); await f.finish(run.id);
  expect(f.requests[0]?.prompt).toContain(path.join(skillPath, "SKILL.md")); expect(f.requests[0]?.prompt).toContain("fixture-workflow");
  expect(f.requests[0]?.prompt).not.toContain("Read only fixture inputs.");
});
it("redacts configured service credentials from stored results and notifications", async () => {
  const f = fixture({ channel: "telegram", chatId: "-101" });
  f.control.before = async (request) => { const run = f.items.getRun(request.runId)!; f.items.appendEvent({ workItemId: run.workItemId, runId: run.id, type: "AGENT_EVENT", actor: "agent", payload: { event: { type: "text_delta", phase: "final_answer", text: f.config.runner.token } } }); };
  const { task } = await f.save(), run = await f.service.runNow(task.id, 1, "redacted"); await f.finish(run.id);
  expect(f.tasks.getAttempt(run.id)?.result).not.toContain(f.config.runner.token); expect(f.send.mock.calls[0]?.[1]).not.toContain(f.config.runner.token);
});

it("keeps runtime preparation out of the user's persisted conversation message", async () => {
  const f = fixture(), { task } = await f.save(), run = await f.service.runNow(task.id, 1, "clean-user-message"); await f.finish(run.id);
  expect(f.items.getTurn(run.turnId!)?.message.text).toBe(f.draft.prompt);
});
it("resumes an admitted queued occurrence through the same task owner after restart", async () => {
  const f = fixture(), { task } = await f.save();
  const attempt = f.tasks.claim(task.id, { key: "manual:queued-before-restart", trigger: "manual", scheduledAt: "2026-10-15T00:00:00Z", now: new Date("2026-10-15T00:00:00Z") })!;
  f.catalog.createSession({ id: attempt.sessionId, agentId: "codex", cwd: f.root });
  const receipt = f.coordinator.submitTurn({ sessionId: attempt.sessionId, idempotencyKey: `agent-task:${attempt.id}`,
    message: { text: f.draft.prompt, attachmentIds: [], model: null, effort: null, permissionMode: null, executionKind: "agent", plan: null },
    workItem: { title: f.draft.name, mode: "auto", conversationId: `conv_${attempt.sessionId.replace(/^sess_/, "")}`, agentId: "codex", workspaceScope: [f.root], riskLevel: "read_only" } });
  f.tasks.updateAttempt(attempt.id, { runId: receipt.run!.id, turnId: receipt.turn.turnId, workItemId: receipt.workItemId, status: "queued" });
  await f.service.tick(); await vi.waitFor(() => expect(f.requests).toHaveLength(1)); await f.finish(attempt.id);
  expect(f.items.listRuns(receipt.workItemId)).toHaveLength(1);
});

it("lets an operator close an uncertain delivery without sending or changing its original receipt", async () => {
  const f = fixture({ channel: "telegram", chatId: "-101" }); f.send.mockRejectedValueOnce(new Error("fixture ambiguous response"));
  const { task } = await f.save(), run = await f.service.runNow(task.id, 1, "unknown-to-ack"); await f.finish(run.id);
  expect(f.tasks.getAttempt(run.id)?.deliveryState).toBe("unknown");
  f.service.acknowledgeDelivery(run.id, "checked-no-resend"); f.service.acknowledgeDelivery(run.id, "checked-no-resend"); await f.service.tick();
  expect(f.tasks.getAttempt(run.id)?.deliveryState).toBe("acknowledged"); expect(f.tasks.deliveryIssues()).toEqual([]);
  expect(f.tasks.notices(run.id).filter((notice) => notice.kind === "acknowledgement")).toHaveLength(1);
  expect(f.tasks.notices(run.id)[0]?.state).toBe("unknown"); expect(f.send).toHaveBeenCalledOnce(); expect(f.requests).toHaveLength(1);
});
it("does not offer a parallel resend while the automatic result is still in flight", async () => {
  const f = fixture({ channel: "feishu", chatId: "oc_fixture" }); let release!: () => void;
  f.send.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const { task } = await f.save();
  try {
    const run = await f.service.runNow(task.id, 1, "held-notice"); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    await f.service.tick(); expect(f.tasks.getAttempt(run.id)?.deliveryState).toBe("pending");
    await expect(f.service.resend(run.id, "must-wait")).rejects.toThrow("仍在发送"); release();
    await vi.waitFor(() => expect(f.tasks.getAttempt(run.id)?.deliveryState).toBe("sent")); expect(f.send).toHaveBeenCalledOnce();
  } finally { release?.(); }
});

it.each(["feishu", "telegram"] as const)("runs %s result/file delivery through the real channel adapter and only resends saved output", async (channel) => {
  const target: AgentTaskTarget = channel === "feishu" ? { channel, chatId: "oc_fixture" } : { channel, chatId: "-101", topicId: "9" };
  const f = fixture(target), sdkSend = vi.fn(async (_chat: string, _input: unknown, _options?: unknown) => ({ messageId: "om_fixture_delivery" }));
  const feishu = new FeishuBridge({ config: f.config, dataDir: path.join(f.root, "feishu") });
  (feishu as unknown as { channel: unknown }).channel = { send: sdkSend, disconnect: async () => {} };
  const nativeRequests: Array<{ url: string; body: unknown }> = [];
  const api = new TelegramApi({ token: "123456:fixture_native_token", fetch: async (url, input) => {
    nativeRequests.push({ url: String(url), body: input?.body instanceof FormData ? Object.fromEntries(input.body.entries()) : JSON.parse(String(input?.body)) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }));
  } });
  const telegram = new TelegramBridge({ config: f.config, dataDir: path.join(f.root, "telegram"), api });
  f.options.send = (destination, text) => destination.channel === "feishu" ? feishu.sendOutboundMarkdown(destination.chatId!, text, destination.topicId) : telegram.sendOutboundMarkdown(`telegram:${destination.chatId}`, text, destination.topicId);
  f.options.sendFile = async (destination, file) => { if (destination.channel === "feishu") await feishu.sendOutboundFile(destination.chatId!, file, destination.topicId); else await telegram.sendOutboundFile(`telegram:${destination.chatId}`, file, destination.topicId); };
  f.control.before = async (request) => { const output = path.join(f.root, "native-fixture.md"); fs.writeFileSync(output, "Synthetic adapter output"); f.service.recordFile(f.tasks.forRun(request.runId)!.id, output); };
  try {
    const { task } = await f.save(), run = await f.service.runNow(task.id, 1, "native-adapter"); await f.finish(run.id);
    await f.service.resend(run.id, "native-resend"); expect(f.requests).toHaveLength(1);
    if (channel === "feishu") { expect(sdkSend).toHaveBeenCalledTimes(4); expect(sdkSend.mock.calls.every((args) => args[0] === "oc_fixture")).toBe(true); }
    else { expect(nativeRequests).toHaveLength(4); expect(nativeRequests.every((request) => (request.body as Record<string, unknown>).chat_id === "-101")).toBe(true); expect(nativeRequests[0]?.body).toMatchObject({ message_thread_id: 9 }); expect(nativeRequests[1]?.body).toMatchObject({ message_thread_id: "9" }); }
  } finally { await feishu.disconnect(); await telegram.disconnect(); }
});

it("does not launder an outside-home source through the task archive before Feishu delivery", async () => {
  const f = fixture({ channel: "feishu", chatId: "oc_fixture" });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cb-task-outside-home-")), file = path.join(outside, "outside.txt"); fs.writeFileSync(file, "Synthetic outside-home data");
  f.control.before = async (request) => { expect(() => f.service.prepareOutboundFile(request.runId, file)).toThrow("主目录"); expect(f.tasks.files(f.tasks.forRun(request.runId)!.id)).toEqual([]); };
  try { const { task } = await f.save(), run = await f.service.runNow(task.id, 1, "source-guard"); await f.finish(run.id); expect(f.sendFile).not.toHaveBeenCalled(); }
  finally { fs.rmSync(outside, { recursive: true, force: true }); }
});
