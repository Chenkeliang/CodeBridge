import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SessionCoordinator } from "@codebridge/session-coordinator";
import { SqliteEventStore } from "@codebridge/work-items";
import { ApprovalService } from "@codebridge/policy";
import { AgentTaskStore } from "./agent-task-store.js";
import { TaskAttentionService } from "./task-attention.js";
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) close(); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-task-attention-"));
  const items = new SqliteEventStore(path.join(root, "runs.sqlite")), catalog = new SessionCatalogStore(path.join(root, "sessions.sqlite")), tasks = new AgentTaskStore(path.join(root, "tasks.sqlite"));
  const coordinator = new SessionCoordinator(items, { maxQueuedTurns: 10 }), approvals = new ApprovalService(items, path.join(root, "approvals.sqlite"));
  const pending = vi.fn(async () => [] as Array<{ runId: string; requestId: string; title: string }>);
  const service = new TaskAttentionService({ catalog, workItems: items, tasks, approvals, pendingPermissions: pending });
  const session = catalog.createSession({ agentId: "codex", cwd: root, title: "Fixture session" });
  const submit = (key: string) => coordinator.submitTurn({ sessionId: session.id, idempotencyKey: key,
    message: { text: key, attachmentIds: [], model: null, effort: null, permissionMode: null, executionKind: "agent", plan: null },
    workItem: { title: key, mode: "auto", conversationId: `conv_${session.id.slice(5)}`, agentId: "codex", workspaceScope: [root], riskLevel: "read_only" } });
  cleanup.push(() => { approvals.close(); tasks.close(); items.close(); catalog.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, items, catalog, tasks, coordinator, approvals, pending, service, session, submit };
}
describe("task attention read projection", () => {
  it("shows only the actionable FIFO permission head and never resolves it while listing", async () => {
    const f = fixture(), submitted = f.submit("first"); f.items.updateRunControl(submitted.run!.id, { status: "running" });
    f.pending.mockResolvedValue([{ runId: submitted.run!.id, requestId: "first", title: "Read fixture" }, { runId: submitted.run!.id, requestId: "second", title: "Write fixture" }]);
    const before = f.items.listEvents(submitted.workItemId).length;
    const response = await f.service.list({ offset: 0, limit: 1 });
    expect(response.total).toBe(1); expect(response.items[0]).toMatchObject({ kind: "agent_permission", approvalId: "first", sessionId: f.session.id });
    expect(f.items.listEvents(submitted.workItemId)).toHaveLength(before);
  });
  it("keeps Agent permissions separate from step approvals and surfaces expired waiting runs", async () => {
    const f = fixture(), submitted = f.submit("step approval"), run = submitted.run!;
    f.items.updateRunControl(run.id, { status: "waiting" });
    const approval = f.approvals.request({ workItemId: run.workItemId, runId: run.id, stepId: "step", capabilityId: "fixture.read", inputHash: "fixture-hash", requestedBy: "system", sessionId: f.session.id, environment: "test", targetResource: "fixture" });
    const current = await f.service.list({ offset: 0, limit: 30 });
    expect(current.items).toContainEqual(expect.objectContaining({ kind: "runtime_approval", approvalId: approval.id }));
    expect(current.items.some((item) => item.kind === "agent_permission")).toBe(false);
    const expired = new TaskAttentionService({ catalog: f.catalog, workItems: f.items, tasks: f.tasks, approvals: f.approvals, pendingPermissions: f.pending, now: () => new Date("2099-01-01T00:00:00Z") });
    const expiredItems = (await expired.list({ offset: 0, limit: 30 })).items;
    expect(expiredItems[0]?.summary).toContain("没有有效审批"); expect(expiredItems[0]?.approvalId).toBeUndefined();
  });
  it("shows paused messages, paginates exact totals and removes an old failure after a later success", async () => {
    const f = fixture(), first = f.submit("first"), queued = f.submit("queued");
    f.coordinator.finishRun({ sessionId: f.session.id, runId: first.run!.id, status: "failed", reason: "fixture error" });
    const paused = await f.service.list({ offset: 0, limit: 1 }); expect(paused.total).toBe(2); expect(paused.nextOffset).toBe(1);
    expect((await f.service.list({ offset: 0, limit: 30, kind: "paused_queue" })).items[0]?.summary).toContain("1条消息或任务");
    const resumed = f.coordinator.resumeQueue({ sessionId: f.session.id, expectedRuntimeVersion: f.items.getSessionRuntime(f.session.id)!.version, idempotencyKey: "resume-fixture" });
    expect(resumed.dispatched?.turn.turnId).toBe(queued.turn.turnId);
    f.coordinator.finishRun({ sessionId: f.session.id, runId: resumed.dispatched!.run.id, status: "succeeded" });
    const original = f.items.listRunsByStatus.bind(f.items);
    vi.spyOn(f.items, "listRunsByStatus").mockImplementation((statuses) => original(statuses).map((run) => ({ ...run, createdAt: "2026-10-15T00:00:00Z", updatedAt: run.id === first.run!.id ? "2026-10-16T00:00:00Z" : "2026-10-15T00:00:00Z" })));
    expect((await f.service.list({ offset: 0, limit: 30 })).items).toEqual([]);
  });
  it("excludes archived conversations and reports an unavailable Runner without inventing an empty healthy permission queue", async () => {
    const f = fixture(), first = f.submit("first");
    f.coordinator.finishRun({ sessionId: f.session.id, runId: first.run!.id, status: "failed", reason: "fixture error" });
    f.catalog.updateSession(f.session.id, { archived: true }); f.pending.mockRejectedValue(new Error("fixture down"));
    const response = await f.service.list({ offset: 0, limit: 30 });
    expect(response.items).toEqual([]); expect(response.issues[0]).toContain("无法读取");
  });
});
