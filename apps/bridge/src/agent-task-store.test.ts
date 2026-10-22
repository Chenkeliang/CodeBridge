import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTaskDraft } from "@codebridge/core";
import { AgentTaskStore } from "./agent-task-store.js";
import { parseTaskSchedule } from "./task-schedule.js";
const roots: string[] = [], stores: AgentTaskStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const now = new Date("2026-10-15T00:00:00Z");
const draft: AgentTaskDraft = { name: "Fixture report", prompt: "Read the fixture", agentId: "codex", cwd: "/fixture", skills: [], model: null, effort: null, permissionMode: null,
  schedule: "每30分钟", timezone: "Asia/Shanghai", catchUp: "once", notification: "result", target: { channel: "local" }, enabled: true };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-task-store-")); roots.push(root);
  const file = path.join(root, "tasks.sqlite"), store = new AgentTaskStore(file); stores.push(store);
  const task = store.create(draft, parseTaskSchedule(draft.schedule, draft.timezone, now), now);
  return { root, file, store, task };
}
describe("durable Agent task ledger", () => {
  it("shares occurrence identity across store instances and preserves it across restart", () => {
    const f = fixture(), other = new AgentTaskStore(f.file); stores.push(other);
    const input = { key: `schedule:${f.task.nextRunAt}`, trigger: "scheduled" as const, scheduledAt: f.task.nextRunAt!, now: new Date(f.task.nextRunAt!) };
    const first = f.store.claim(f.task.id, input)!;
    expect(other.claim(f.task.id, input)?.id).toBe(first.id);
    expect(other.attempts(f.task.id).total).toBe(1);
    expect(other.forSession(first.sessionId)?.id).toBe(first.id);
    expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
  });
  it("records a skipped overlapping slot and never dispatches a second concurrent attempt", () => {
    const f = fixture(), at = f.task.nextRunAt!;
    const first = f.store.claim(f.task.id, { key: "manual:one", trigger: "manual", scheduledAt: now.toISOString(), now })!;
    const skipped = f.store.claim(f.task.id, { key: `schedule:${at}`, trigger: "scheduled", scheduledAt: at, now: new Date(at) })!;
    expect(skipped).toMatchObject({ status: "skipped", deliveryState: "local" });
    expect(f.store.get(f.task.id)?.activeAttemptId).toBe(first.id);
    expect(() => f.store.claim(f.task.id, { key: "manual:two", trigger: "manual", scheduledAt: at, now: new Date(at) })).toThrow("仍有");
  });
  it("keeps a running snapshot immutable when the task is edited and rejects stale edits", () => {
    const f = fixture();
    const run = f.store.claim(f.task.id, { key: "manual:one", trigger: "manual", scheduledAt: now.toISOString(), now })!;
    const next = f.store.update(f.task.id, 1, { ...draft, prompt: "New fixture" }, f.task.parsedSchedule, now);
    expect(next.version).toBe(2); expect(f.store.getAttempt(run.id)?.definition.prompt).toBe(draft.prompt);
    expect(() => f.store.update(f.task.id, 1, draft, f.task.parsedSchedule, now)).toThrow("已被修改");
  });
  it("pauses unknown outcomes and requires explicit acknowledgement to resume or rerun", () => {
    const f = fixture(), run = f.store.claim(f.task.id, { key: "manual:one", trigger: "manual", scheduledAt: now.toISOString(), now })!;
    f.store.updateAttempt(run.id, { status: "interrupted", finishedAt: now.toISOString() });
    const task = f.store.get(f.task.id)!;
    expect(task.enabled).toBe(false); expect(task.activeAttemptId).toBeNull();
    expect(() => f.store.setEnabled(task.id, task.version, true, now)).toThrow("核对");
    expect(() => f.store.claim(task.id, { key: "manual:two", trigger: "manual", scheduledAt: now.toISOString(), now })).toThrow("核对");
    expect(f.store.setEnabled(task.id, task.version, true, now, true).enabled).toBe(true);
    expect(() => f.store.updateAttempt(run.id, { status: "succeeded" })).toThrow("不可改写");
  });
  it("pauses future triggers without cancelling the current run and reanchors on resume", () => {
    const f = fixture(), run = f.store.claim(f.task.id, { key: "manual:one", trigger: "manual", scheduledAt: now.toISOString(), now })!;
    const paused = f.store.setEnabled(f.task.id, 1, false, now);
    expect(paused.activeAttemptId).toBe(run.id); expect(paused.nextRunAt).toBeNull();
    const resumed = f.store.setEnabled(f.task.id, paused.version, true, new Date("2026-10-16T00:00:00Z"));
    expect(resumed.nextRunAt).toBe("2026-10-16T00:30:00.000Z");
    expect(f.store.getAttempt(run.id)?.status).toBe("claimed");
  });
});

it("keeps the SQLite write-ahead log and shared-memory sidecars private too", () => {
  const f = fixture();
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(f.file + suffix)) expect(fs.statSync(f.file + suffix).mode & 0o777).toBe(0o600);
});
