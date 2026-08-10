import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

export type WorkItemStatus =
  | "created"
  | "exploring"
  | "planned"
  | "awaiting_input"
  | "awaiting_approval"
  | "executing"
  | "verifying"
  | "manual_review"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkItemMode =
  | "auto"
  | "investigation"
  | "change"
  | "review"
  | "release"
  | "observe";

export type RiskLevel =
  | "read_only"
  | "workspace_write"
  | "git_write"
  | "production_write";

export type DomainEventType =
  | "WORK_ITEM_CREATED"
  | "MESSAGE_RECEIVED"
  | "RUN_CREATED"
  | "AGENT_EVENT"
  | "RUN_STARTED"
  | "RUN_SUCCEEDED"
  | "RUN_FAILED"
  | "RUN_CANCELLED"
  | "DISCOVERY_STARTED"
  | "PROJECT_CANDIDATE_FOUND"
  | "PLAN_PROPOSED"
  | "PLAN_VALIDATED"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_GRANTED"
  | "STEP_STARTED"
  | "STEP_SUCCEEDED"
  | "STEP_FAILED"
  | "BRANCH_SELECTED"
  | "VERIFICATION_COMPLETED"
  | "WORK_ITEM_COMPLETED";

export type DomainEventActor =
  | "user"
  | "agent"
  | "system"
  | "adapter"
  | "channel";

export interface WorkItem {
  schemaVersion: 1;
  id: string;
  title: string;
  status: WorkItemStatus;
  mode: WorkItemMode;
  conversationId: string;
  agentId: string | null;
  workflowId: string | null;
  workflowRevision: string | null;
  workspaceScope: string[];
  identifiers: Record<string, unknown>;
  contextRevision: number;
  riskLevel: RiskLevel;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkItemInput {
  id?: string;
  title: string;
  mode: WorkItemMode;
  conversationId: string;
  agentId?: string | null;
  workflowId?: string | null;
  workflowRevision?: string | null;
  workspaceScope?: string[];
  identifiers?: Record<string, unknown>;
  contextRevision?: number;
  riskLevel: RiskLevel;
}

export interface DomainEvent {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  workItemId: string;
  runId: string | null;
  type: DomainEventType;
  occurredAt: string;
  actor: DomainEventActor;
  target: string | null;
  inputHash: string | null;
  resultRef: string | null;
  payload: Record<string, unknown>;
}

export interface AppendEventInput {
  workItemId: string;
  runId?: string | null;
  type: DomainEventType;
  actor: DomainEventActor;
  target?: string | null;
  inputHash?: string | null;
  resultRef?: string | null;
  payload?: Record<string, unknown>;
}

export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Run {
  schemaVersion: 1;
  id: string;
  workItemId: string;
  mode: WorkItemMode;
  status: RunStatus;
  agentId: string | null;
  planId: string | null;
  workflowRevision: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunInput {
  id?: string;
  workItemId: string;
  mode: WorkItemMode;
  agentId?: string | null;
  planId?: string | null;
  workflowRevision?: string | null;
}

export interface PersistedPlanStep {
  id: string;
  capabilityId: string | null;
  risk: "read_only" | "workspace_write" | "git_write" | "production_write" | "manual";
  dependsOn: string[];
  guard: string | null;
  approval: "none" | "required";
  branches: Array<{ when: string; next: string }>;
  purpose: string | null;
}

export interface PersistedPlan {
  schemaVersion: 1;
  planId: string;
  source: "workflow" | "agent_generated";
  workflowId: string;
  definitionRevision: string | null;
  sessionId: string | null;
  runId: string | null;
  steps: PersistedPlanStep[];
  createdAt: string;
}

export interface SavePlanInput {
  planId: string;
  source: PersistedPlan["source"];
  workflowId: string;
  definitionRevision: string | null;
  sessionId?: string | null;
  runId?: string | null;
  steps: PersistedPlanStep[];
}

type SqliteRow = Record<string, unknown>;

const STATUS_BY_EVENT: Partial<Record<DomainEventType, WorkItemStatus>> = {
  PLAN_PROPOSED: "planned",
  APPROVAL_REQUESTED: "awaiting_approval",
  STEP_STARTED: "executing",
  VERIFICATION_COMPLETED: "verifying",
  STEP_FAILED: "failed",
  WORK_ITEM_COMPLETED: "completed",
};

export class SqliteEventStore {
  private readonly database: DatabaseSyncType;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") {
      this.database.exec("PRAGMA journal_mode = WAL;");
    }
    this.database.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        agent_id TEXT,
        workflow_id TEXT,
        workflow_revision TEXT,
        workspace_scope TEXT NOT NULL,
        identifiers TEXT NOT NULL,
        context_revision INTEGER NOT NULL,
        risk_level TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS domain_events (
        event_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        work_item_id TEXT NOT NULL,
        run_id TEXT,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        target TEXT,
        input_hash TEXT,
        result_ref TEXT,
        payload TEXT NOT NULL,
        FOREIGN KEY (work_item_id) REFERENCES work_items(id),
        UNIQUE (work_item_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS domain_events_work_item_sequence
        ON domain_events (work_item_id, sequence);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        work_item_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        agent_id TEXT,
        plan_id TEXT,
        workflow_revision TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (work_item_id) REFERENCES work_items(id)
      );

      CREATE INDEX IF NOT EXISTS runs_work_item_created
        ON runs (work_item_id, created_at);

      CREATE TABLE IF NOT EXISTS plans (
        plan_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        source TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        definition_revision TEXT,
        session_id TEXT,
        run_id TEXT UNIQUE,
        steps TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idempotency_responses (
        namespace TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (namespace, idempotency_key)
      );
    `);
    try {
      this.database.exec("ALTER TABLE runs ADD COLUMN workflow_revision TEXT");
    } catch {
      // Existing databases already contain the column.
    }
  }

  createWorkItem(input: CreateWorkItemInput): WorkItem {
    const now = new Date().toISOString();
    const workItem: WorkItem = {
      schemaVersion: 1,
      id: input.id ?? createId("wi"),
      title: input.title,
      status: "created",
      mode: input.mode,
      conversationId: input.conversationId,
      agentId: input.agentId ?? null,
      workflowId: input.workflowId ?? null,
      workflowRevision: input.workflowRevision ?? null,
      workspaceScope: [...(input.workspaceScope ?? [])],
      identifiers: { ...(input.identifiers ?? {}) },
      contextRevision: input.contextRevision ?? 1,
      riskLevel: input.riskLevel,
      createdAt: now,
      updatedAt: now,
    };

    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database
        .prepare(
          `INSERT INTO work_items (
            id, schema_version, title, status, mode, conversation_id,
            agent_id, workflow_id, workflow_revision, workspace_scope, identifiers,
            context_revision, risk_level, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workItem.id,
          workItem.schemaVersion,
          workItem.title,
          workItem.status,
          workItem.mode,
          workItem.conversationId,
          workItem.agentId,
          workItem.workflowId,
          workItem.workflowRevision,
          JSON.stringify(workItem.workspaceScope),
          JSON.stringify(workItem.identifiers),
          workItem.contextRevision,
          workItem.riskLevel,
          workItem.createdAt,
          workItem.updatedAt,
        );
      this.appendEventInTransaction({
        workItemId: workItem.id,
        type: "WORK_ITEM_CREATED",
        actor: "system",
      });
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }

    return workItem;
  }

  getWorkItem(workItemId: string): WorkItem | undefined {
    const row = this.database
      .prepare("SELECT * FROM work_items WHERE id = ?")
      .get(workItemId);
    return row ? toWorkItem(row) : undefined;
  }

  updateWorkflowBinding(
    workItemId: string,
    workflowId: string | null,
    workflowRevision: string | null = null,
  ): WorkItem | undefined {
    if (!this.getWorkItem(workItemId)) return undefined;
    this.database
      .prepare(
        `UPDATE work_items
         SET workflow_id = ?, workflow_revision = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(workflowId, workflowRevision, new Date().toISOString(), workItemId);
    return this.getWorkItem(workItemId);
  }

  listWorkItems(): WorkItem[] {
    const rows = this.database
      .prepare("SELECT * FROM work_items ORDER BY updated_at DESC, rowid ASC")
      .all();
    return rows.map(toWorkItem);
  }

  appendEvent(input: AppendEventInput): DomainEvent {
    if (!this.getWorkItem(input.workItemId)) {
      throw new Error(`WorkItem not found: ${input.workItemId}`);
    }

    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const event = this.appendEventInTransaction(input);
      this.database.exec("COMMIT;");
      return event;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  listEvents(workItemId: string, afterSequence = 0): DomainEvent[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM domain_events
         WHERE work_item_id = ? AND sequence > ?
         ORDER BY sequence ASC`,
      )
      .all(workItemId, afterSequence);
    return rows.map(toDomainEvent);
  }

  sequenceForEventId(workItemId: string, eventId: string): number {
    const row = this.database
      .prepare("SELECT sequence FROM domain_events WHERE work_item_id = ? AND event_id = ?")
      .get(workItemId, eventId) as { sequence?: number } | undefined;
    return row?.sequence ? Number(row.sequence) : 0;
  }

  savePlan(input: SavePlanInput): PersistedPlan {
    const plan: PersistedPlan = {
      schemaVersion: 1,
      planId: input.planId,
      source: input.source,
      workflowId: input.workflowId,
      definitionRevision: input.definitionRevision,
      sessionId: input.sessionId ?? null,
      runId: input.runId ?? null,
      steps: input.steps.map(clonePlanStep),
      createdAt: new Date().toISOString(),
    };
    this.database
      .prepare(
        `INSERT INTO plans (
          plan_id, schema_version, source, workflow_id, definition_revision,
          session_id, run_id, steps, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plan_id) DO UPDATE SET
          source = excluded.source,
          workflow_id = excluded.workflow_id,
          definition_revision = excluded.definition_revision,
          session_id = excluded.session_id,
          run_id = excluded.run_id,
          steps = excluded.steps`,
      )
      .run(
        plan.planId,
        plan.schemaVersion,
        plan.source,
        plan.workflowId,
        plan.definitionRevision,
        plan.sessionId,
        plan.runId,
        JSON.stringify(plan.steps),
        plan.createdAt,
      );
    return this.getPlan(plan.planId)!;
  }

  getPlan(planId: string): PersistedPlan | undefined {
    const row = this.database.prepare("SELECT * FROM plans WHERE plan_id = ?").get(planId);
    return row ? toPlan(row) : undefined;
  }

  getPlanForRun(runId: string): PersistedPlan | undefined {
    const row = this.database.prepare("SELECT * FROM plans WHERE run_id = ?").get(runId);
    return row ? toPlan(row) : undefined;
  }

  createRun(input: CreateRunInput): Run {
    const workItem = this.getWorkItem(input.workItemId);
    if (!workItem) {
      throw new Error(`WorkItem not found: ${input.workItemId}`);
    }

    const plan = input.planId ? this.getPlan(input.planId) : undefined;
    if (input.planId && !plan) {
      throw new Error(`Plan not found: ${input.planId}`);
    }
    if (plan?.runId && input.id && plan.runId !== input.id) {
      throw new Error(`Plan ${plan.planId} is bound to another Run`);
    }

    const now = new Date().toISOString();
    const run: Run = {
      schemaVersion: 1,
      id: input.id ?? createId("run"),
      workItemId: input.workItemId,
      mode: input.mode,
      status: "queued",
      agentId: input.agentId ?? workItem.agentId,
      planId: input.planId ?? null,
      workflowRevision:
        input.workflowRevision ?? plan?.definitionRevision ?? workItem.workflowRevision,
      createdAt: now,
      updatedAt: now,
    };

    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database
        .prepare(
          `INSERT INTO runs (
            id, schema_version, work_item_id, mode, status, agent_id,
            plan_id, workflow_revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.schemaVersion,
          run.workItemId,
          run.mode,
          run.status,
          run.agentId,
          run.planId,
          run.workflowRevision,
          run.createdAt,
          run.updatedAt,
        );
      this.appendEventInTransaction({
        workItemId: run.workItemId,
        runId: run.id,
        type: "RUN_CREATED",
        actor: "system",
        target: run.id,
        payload: {
          mode: run.mode,
          agent_id: run.agentId,
          plan_id: run.planId,
          workflow_revision: run.workflowRevision,
        },
      });
      if (plan) {
        this.appendEventInTransaction({
          workItemId: run.workItemId,
          runId: run.id,
          type: "PLAN_VALIDATED",
          actor: "system",
          target: plan.planId,
          payload: {
            workflow_id: plan.workflowId,
            definition_revision: plan.definitionRevision,
            source: plan.source,
            step_count: plan.steps.length,
          },
        });
      }
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }

    return run;
  }

  getRun(runId: string): Run | undefined {
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    return row ? toRun(row) : undefined;
  }

  listRuns(workItemId: string): Run[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM runs WHERE work_item_id = ? ORDER BY created_at ASC",
      )
      .all(workItemId);
    return rows.map(toRun);
  }

  listRunsByStatus(statuses: RunStatus[]): Run[] {
    if (!statuses.length) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.database
      .prepare(`SELECT * FROM runs WHERE status IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...statuses);
    return rows.map(toRun);
  }

  updateRunStatus(runId: string, status: RunStatus): Run {
    const now = new Date().toISOString();
    const result = this.database
      .prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, runId);
    if (Number(result.changes) !== 1) throw new Error(`Run not found: ${runId}`);
    return this.getRun(runId)!;
  }

  requeueRun(runId: string): Run {
    return this.updateRunStatus(runId, "queued");
  }

  putIdempotencyResponse(namespace: string, key: string, response: unknown): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO idempotency_responses
         (namespace, idempotency_key, response, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(namespace, key, JSON.stringify(response), new Date().toISOString());
  }

  getIdempotencyResponse(namespace: string, key: string): unknown | undefined {
    const row = this.database
      .prepare("SELECT response FROM idempotency_responses WHERE namespace = ? AND idempotency_key = ?")
      .get(namespace, key) as { response?: string } | undefined;
    return row?.response ? JSON.parse(row.response) : undefined;
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private appendEventInTransaction(input: AppendEventInput): DomainEvent {
    const sequenceRow = this.database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM domain_events WHERE work_item_id = ?",
      )
      .get(input.workItemId);
    const sequence = Number(sequenceRow?.next_sequence ?? 1);
    const event: DomainEvent = {
      schemaVersion: 1,
      eventId: createId("evt"),
      sequence,
      workItemId: input.workItemId,
      runId: input.runId ?? null,
      type: input.type,
      occurredAt: new Date().toISOString(),
      actor: input.actor,
      target: input.target ?? null,
      inputHash: input.inputHash ?? null,
      resultRef: input.resultRef ?? null,
      payload: { ...(input.payload ?? {}) },
    };

    this.database
      .prepare(
        `INSERT INTO domain_events (
          event_id, schema_version, sequence, work_item_id, run_id, type,
          occurred_at, actor, target, input_hash, result_ref, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.schemaVersion,
        event.sequence,
        event.workItemId,
        event.runId,
        event.type,
        event.occurredAt,
        event.actor,
        event.target,
        event.inputHash,
        event.resultRef,
        JSON.stringify(event.payload),
      );

    const nextStatus = STATUS_BY_EVENT[event.type];
    if (nextStatus) {
      this.database
        .prepare("UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?")
        .run(nextStatus, event.occurredAt, event.workItemId);
    }

    return event;
  }

}

function createId(prefix: "wi" | "evt" | "run"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function toWorkItem(row: SqliteRow): WorkItem {
  return {
    schemaVersion: Number(row.schema_version) as 1,
    id: String(row.id),
    title: String(row.title),
    status: String(row.status) as WorkItemStatus,
    mode: String(row.mode) as WorkItemMode,
    conversationId: String(row.conversation_id),
    agentId: row.agent_id === null ? null : String(row.agent_id),
    workflowId: row.workflow_id === null ? null : String(row.workflow_id),
    workflowRevision:
      row.workflow_revision === null ? null : String(row.workflow_revision),
    workspaceScope: JSON.parse(String(row.workspace_scope)) as string[],
    identifiers: JSON.parse(String(row.identifiers)) as Record<string, unknown>,
    contextRevision: Number(row.context_revision),
    riskLevel: String(row.risk_level) as RiskLevel,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toDomainEvent(row: SqliteRow): DomainEvent {
  return {
    schemaVersion: Number(row.schema_version) as 1,
    eventId: String(row.event_id),
    sequence: Number(row.sequence),
    workItemId: String(row.work_item_id),
    runId: row.run_id === null ? null : String(row.run_id),
    type: String(row.type) as DomainEventType,
    occurredAt: String(row.occurred_at),
    actor: String(row.actor) as DomainEventActor,
    target: row.target === null ? null : String(row.target),
    inputHash: row.input_hash === null ? null : String(row.input_hash),
    resultRef: row.result_ref === null ? null : String(row.result_ref),
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
  };
}

function toRun(row: SqliteRow): Run {
  return {
    schemaVersion: Number(row.schema_version) as 1,
    id: String(row.id),
    workItemId: String(row.work_item_id),
    mode: String(row.mode) as WorkItemMode,
    status: String(row.status) as RunStatus,
    agentId: row.agent_id === null ? null : String(row.agent_id),
    planId: row.plan_id === null ? null : String(row.plan_id),
    workflowRevision:
      row.workflow_revision === null || row.workflow_revision === undefined
        ? null
        : String(row.workflow_revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toPlan(row: SqliteRow): PersistedPlan {
  return {
    schemaVersion: Number(row.schema_version) as 1,
    planId: String(row.plan_id),
    source: String(row.source) as PersistedPlan["source"],
    workflowId: String(row.workflow_id),
    definitionRevision:
      row.definition_revision === null ? null : String(row.definition_revision),
    sessionId: row.session_id === null ? null : String(row.session_id),
    runId: row.run_id === null ? null : String(row.run_id),
    steps: (JSON.parse(String(row.steps)) as PersistedPlanStep[]).map(clonePlanStep),
    createdAt: String(row.created_at),
  };
}

function clonePlanStep(step: PersistedPlanStep): PersistedPlanStep {
  return {
    ...step,
    dependsOn: [...step.dependsOn],
    branches: step.branches.map((branch) => ({ ...branch })),
  };
}
