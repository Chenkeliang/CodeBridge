import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { AgentTaskAttempt, AgentTaskDefinition, AgentTaskDraft, AgentTaskSchedule, TaskFile, TaskNotice } from "@codebridge/core";
import { nextTaskRun } from "./task-schedule.js";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted", "skipped"]);

export class TaskConflictError extends Error {
  readonly status = 409;
}
export function taskDraft(task: AgentTaskDraft): AgentTaskDraft {
  const { name, prompt, agentId, cwd, skills, model, effort, permissionMode, schedule, timezone, catchUp, notification, target, enabled } = task;
  return structuredClone({ name, prompt, agentId, cwd, skills, model, effort, permissionMode, schedule, timezone, catchUp, notification, target, enabled });
}

/** Definitions and dispatch identity are durable; Agent execution remains in the existing Run store. */
export class AgentTaskStore {
  private readonly db: DatabaseSyncType;
  constructor(databasePath: string) {
    if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") fs.chmodSync(databasePath, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS agent_tasks (id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_task_creations (command_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES agent_tasks(id));
      CREATE TABLE IF NOT EXISTS agent_task_attempts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES agent_tasks(id), trigger_key TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL UNIQUE, run_id TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_attempts_by_task ON agent_task_attempts(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS task_attempts_by_run ON agent_task_attempts(run_id);
      CREATE TABLE IF NOT EXISTS agent_task_notices (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES agent_task_attempts(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_task_files (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES agent_task_attempts(id), stored_path TEXT NOT NULL, data TEXT NOT NULL);`);
    if (databasePath !== ":memory:") for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(databasePath + suffix)) fs.chmodSync(databasePath + suffix, 0o600);
  }
  close(): void { this.db.close(); }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = run(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  get(id: string): AgentTaskDefinition | undefined {
    const row = this.db.prepare("SELECT data FROM agent_tasks WHERE id=?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  list(): AgentTaskDefinition[] {
    return (this.db.prepare("SELECT data FROM agent_tasks ORDER BY rowid DESC").all() as Array<{ data: string }>).map((row) => JSON.parse(row.data));
  }
  create(draft: AgentTaskDraft, schedule: AgentTaskSchedule, now: Date, commandKey?: string): AgentTaskDefinition {
    return this.transaction(() => {
      const hash = createHash("sha256").update(JSON.stringify(taskDraft(draft))).digest("hex");
      if (commandKey) {
        const prior = this.db.prepare("SELECT request_hash,task_id FROM agent_task_creations WHERE command_key=?").get(commandKey) as { request_hash: string; task_id: string } | undefined;
        if (prior) {
          if (prior.request_hash !== hash) throw new TaskConflictError("同一操作标识不能用于不同的任务，请核对后重新提交");
          return this.require(prior.task_id);
        }
      }
      const task: AgentTaskDefinition = { ...taskDraft(draft), schedule: schedule.kind === "once" ? schedule.at : draft.schedule,
        id: `task_${randomUUID().replaceAll("-", "")}`, version: 1,
        parsedSchedule: schedule, nextRunAt: draft.enabled ? nextTaskRun(schedule, draft.timezone, now) : null,
        activeAttemptId: null, lastRunAt: null, pausedReason: draft.enabled ? null : "新任务尚未启用",
        createdAt: now.toISOString(), updatedAt: now.toISOString() };
      this.db.prepare("INSERT INTO agent_tasks(id,version,data) VALUES(?,?,?)").run(task.id, task.version, JSON.stringify(task));
      if (commandKey) this.db.prepare("INSERT INTO agent_task_creations(command_key,request_hash,task_id) VALUES(?,?,?)").run(commandKey, hash, task.id);
      return task;
    });
  }
  private require(id: string, expectedVersion?: number): AgentTaskDefinition {
    const task = this.get(id);
    if (!task) throw new Error("定时任务不存在");
    if (expectedVersion !== undefined && task.version !== expectedVersion) throw new TaskConflictError("任务已被修改，请刷新后核对；当前输入没有覆盖原配置");
    return task;
  }
  private write(task: AgentTaskDefinition): void {
    this.db.prepare("UPDATE agent_tasks SET version=?,data=? WHERE id=?").run(task.version, JSON.stringify(task), task.id);
  }
  update(id: string, expectedVersion: number, draft: AgentTaskDraft, schedule: AgentTaskSchedule, now: Date): AgentTaskDefinition {
    return this.transaction(() => {
      const task = this.require(id, expectedVersion);
      if (draft.enabled && task.pausedReason?.startsWith("执行结果不明")) throw new TaskConflictError("请先核对上次执行结果，再明确恢复调度");
      const changedSchedule = task.schedule !== draft.schedule || task.timezone !== draft.timezone;
      const next = { ...task, ...taskDraft(draft), schedule: schedule.kind === "once" ? schedule.at : draft.schedule, parsedSchedule: schedule, version: task.version + 1, updatedAt: now.toISOString(),
        nextRunAt: !draft.enabled ? null : changedSchedule || !task.enabled ? nextTaskRun(schedule, draft.timezone, now) : task.nextRunAt,
        pausedReason: draft.enabled ? null : task.pausedReason ?? "已暂停未来触发" };
      this.write(next); return next;
    });
  }
  setEnabled(id: string, expectedVersion: number, enabled: boolean, now: Date, acknowledgeUnknown = false): AgentTaskDefinition {
    return this.transaction(() => {
      const task = this.require(id, expectedVersion);
      if (enabled && task.pausedReason?.startsWith("执行结果不明") && !acknowledgeUnknown) throw new TaskConflictError("上次执行结果不明，请核对后勾选确认再恢复");
      const nextRunAt = enabled ? nextTaskRun(task.parsedSchedule, task.timezone, now) : null;
      if (enabled && !nextRunAt) throw new Error("一次性计划时间已过，请先调整计划；运行一次仍可显式触发");
      const next = { ...task, enabled, nextRunAt, pausedReason: enabled ? null : "已暂停未来触发，进行中的任务继续运行", version: task.version + 1, updatedAt: now.toISOString() };
      this.write(next); return next;
    });
  }
  claim(id: string, input: { key: string; trigger: AgentTaskAttempt["trigger"]; scheduledAt: string; now: Date; expectedVersion?: number;
    retryOf?: string; definition?: AgentTaskDraft; skipReason?: string; acknowledgeUnknown?: boolean }): AgentTaskAttempt | null {
    return this.transaction(() => {
      const previous = this.db.prepare("SELECT data FROM agent_task_attempts WHERE trigger_key=?").get(`${id}:${input.key}`) as { data: string } | undefined;
      if (previous) return JSON.parse(previous.data);
      const task = this.require(id, input.expectedVersion);
      if (input.trigger === "scheduled" && (!task.enabled || task.nextRunAt !== input.scheduledAt)) return null;
      if (input.trigger !== "scheduled" && task.pausedReason?.startsWith("执行结果不明") && !input.acknowledgeUnknown) throw new TaskConflictError("请先核对上次执行结果，再明确确认重新执行");
      if (task.activeAttemptId && input.trigger !== "scheduled") throw new TaskConflictError("此任务仍有一轮运行或等待审批，请结束后重试");
      const skipped = input.skipReason ?? (task.activeAttemptId ? "上一轮尚未结束，本次重叠计划已跳过" : null);
      const attemptId = `taskrun_${randomUUID().replaceAll("-", "")}`;
      const definition = taskDraft(input.definition ?? task);
      const attempt: AgentTaskAttempt = { id: attemptId, taskId: id, trigger: input.trigger, scheduledAt: input.scheduledAt,
        startedAt: input.now.toISOString(), finishedAt: skipped ? input.now.toISOString() : null,
        status: skipped ? "skipped" : "claimed", reason: skipped, outcomeUncertain: false, sessionId: `sess_${attemptId}`, runId: null, turnId: null, workItemId: null,
        definition, retryOf: input.retryOf ?? null, result: "", deliveryState: definition.target.channel === "local" ? "local" : skipped ? "suppressed" : "pending" };
      this.db.prepare("INSERT INTO agent_task_attempts(id,task_id,trigger_key,session_id,state,created_at,data) VALUES(?,?,?,?,?,?,?)")
        .run(attempt.id, id, `${id}:${input.key}`, attempt.sessionId, attempt.status, attempt.startedAt, JSON.stringify(attempt));
      const reviewed = input.acknowledgeUnknown && task.pausedReason?.startsWith("执行结果不明");
      const next = { ...task, ...(reviewed ? { pausedReason: "已核对上次执行结果，未来调度仍暂停", version: task.version + 1 } : {}), updatedAt: input.now.toISOString(), activeAttemptId: skipped ? task.activeAttemptId : attempt.id,
        lastRunAt: skipped ? task.lastRunAt : input.now.toISOString(),
        nextRunAt: input.trigger === "scheduled" ? nextTaskRun(task.parsedSchedule, task.timezone, input.now) : task.nextRunAt };
      this.write(next); return attempt;
    });
  }
  getAttempt(id: string): AgentTaskAttempt | undefined {
    const row = this.db.prepare("SELECT data FROM agent_task_attempts WHERE id=?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  forSession(sessionId: string): AgentTaskAttempt | undefined {
    const row = this.db.prepare("SELECT data FROM agent_task_attempts WHERE session_id=?").get(sessionId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  forRun(runId: string): AgentTaskAttempt | undefined {
    const row = this.db.prepare("SELECT data FROM agent_task_attempts WHERE run_id=?").get(runId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  attempts(taskId?: string, offset = 0, limit = 50): { items: AgentTaskAttempt[]; total: number } {
    const where = taskId ? "WHERE task_id=?" : "";
    const args = taskId ? [taskId] : [];
    const total = Number((this.db.prepare(`SELECT count(*) AS total FROM agent_task_attempts ${where}`).get(...args) as { total: number }).total);
    const rows = this.db.prepare(`SELECT data FROM agent_task_attempts ${where} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Array<{ data: string }>;
    return { items: rows.map((row) => JSON.parse(row.data)), total };
  }
  unsettled(): AgentTaskAttempt[] {
    return (this.db.prepare("SELECT data FROM agent_task_attempts WHERE state IN ('claimed','queued','running','waiting') OR json_extract(data,'$.deliveryState')='pending'")
      .all() as Array<{ data: string }>).map((row) => JSON.parse(row.data));
  }
  updateAttempt(id: string, patch: Partial<Pick<AgentTaskAttempt, "status" | "reason" | "finishedAt" | "runId" | "turnId" | "workItemId" | "result" | "deliveryState" | "outcomeUncertain">>): AgentTaskAttempt {
    return this.transaction(() => {
      const current = this.getAttempt(id);
      if (!current) throw new Error("运行记录不存在");
      if (terminal.has(current.status) && patch.status && patch.status !== current.status) throw new TaskConflictError("已结束的运行状态不可改写");
      const next = { ...current, ...patch, outcomeUncertain: current.outcomeUncertain || patch.outcomeUncertain === true || patch.status === "interrupted" };
      this.db.prepare("UPDATE agent_task_attempts SET run_id=?,state=?,data=? WHERE id=?").run(next.runId, next.status, JSON.stringify(next), id);
      if (terminal.has(next.status)) {
        const task = this.require(next.taskId);
        if (task.activeAttemptId === id) {
          task.activeAttemptId = null;
          if (next.outcomeUncertain) { task.enabled = false; task.nextRunAt = null; task.pausedReason = "执行结果不明：本次已中断，请核对实际结果后再恢复或重新执行"; task.version++; }
          this.write(task);
        }
      }
      return next;
    });
  }
  deliveryIssues(): AgentTaskAttempt[] {
    return (this.db.prepare("SELECT data FROM agent_task_attempts WHERE json_extract(data,'$.deliveryState') IN ('failed','unknown') ORDER BY created_at DESC")
      .all() as Array<{ data: string }>).map((row) => JSON.parse(row.data));
  }
  acknowledgeDelivery(attemptId: string, key: string, now: Date): AgentTaskAttempt {
    return this.transaction(() => {
      const attempt = this.getAttempt(attemptId);
      if (!attempt) throw new Error("运行记录不存在");
      const id = `${attemptId}:acknowledgement:${key}`;
      if (this.notices(attemptId).some((notice) => notice.id === id)) return attempt;
      if (!terminal.has(attempt.status) || attempt.deliveryState !== "unknown") throw new TaskConflictError("只有已结束且发送结果未确认的运行，才需要确认无需补发");
      this.claimNotice({ id, attemptId, kind: "acknowledgement", state: "acknowledged", text: "用户已核对并确认本次结果无需补发；原发送回执状态保留", error: null, messageId: null,
        createdAt: now.toISOString(), finishedAt: now.toISOString() });
      const next: AgentTaskAttempt = { ...attempt, deliveryState: "acknowledged" };
      this.db.prepare("UPDATE agent_task_attempts SET data=? WHERE id=?").run(JSON.stringify(next), attemptId);
      return next;
    });
  }
  latestAttempt(taskId: string): AgentTaskAttempt | undefined {
    const row = this.db.prepare("SELECT data FROM agent_task_attempts WHERE task_id=? AND state!='skipped' ORDER BY rowid DESC LIMIT 1").get(taskId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  notices(attemptId: string): TaskNotice[] {
    return (this.db.prepare("SELECT data FROM agent_task_notices WHERE attempt_id=? ORDER BY rowid").all(attemptId) as Array<{ data: string }>).map((row) => JSON.parse(row.data));
  }
  claimNotice(notice: TaskNotice): boolean {
    return Number(this.db.prepare("INSERT OR IGNORE INTO agent_task_notices(id,attempt_id,data) VALUES(?,?,?)").run(notice.id, notice.attemptId, JSON.stringify(notice)).changes) === 1;
  }
  updateNotice(notice: TaskNotice): void {
    this.db.prepare("UPDATE agent_task_notices SET data=? WHERE id=?").run(JSON.stringify(notice), notice.id);
  }
  files(attemptId: string): TaskFile[] {
    return (this.db.prepare("SELECT data FROM agent_task_files WHERE attempt_id=? ORDER BY rowid").all(attemptId) as Array<{ data: string }>).map((row) => JSON.parse(row.data));
  }
  addFile(file: TaskFile, storedPath: string): void {
    this.db.prepare("INSERT INTO agent_task_files(id,attempt_id,stored_path,data) VALUES(?,?,?,?)").run(file.id, file.attemptId, storedPath, JSON.stringify(file));
  }
  updateFile(file: TaskFile): void {
    this.db.prepare("UPDATE agent_task_files SET data=? WHERE id=?").run(JSON.stringify(file), file.id);
  }
  file(id: string): { file: TaskFile; storedPath: string } | undefined {
    const row = this.db.prepare("SELECT data,stored_path FROM agent_task_files WHERE id=?").get(id) as { data: string; stored_path: string } | undefined;
    return row ? { file: JSON.parse(row.data), storedPath: row.stored_path } : undefined;
  }
}
