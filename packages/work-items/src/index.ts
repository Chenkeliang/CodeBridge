import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { initializeSessionRuntimeSchema } from "./session-schema.js";
import {
  appendSessionEventInTransaction,
  createSqliteSessionRuntimeTransaction,
  importProviderHistoryInTransaction,
} from "./session-runtime.js";
import type {
  QueuePauseReason,
  QueueState,
  ProviderHistoryImportInput,
  ProviderHistoryImportResult,
  ReplaySafety,
  RunAttempt,
  SessionRuntime,
  SessionEventInput,
  SessionTimelineBlock,
  SessionTimelineSegment,
  SessionTimelineTurn,
  SessionTurn,
  SessionTurnMessage,
  SessionTurnStatus,
  SessionRuntimeTransaction,
} from "./session-runtime.js";

export type {
  ImportedHistoryEntry,
  ProviderHistoryImportInput,
  ProviderHistoryImportResult,
  QueuePauseReason,
  QueueState,
  ReplaySafety,
  RunAttempt,
  SessionEventInput,
  SessionRuntime,
  SessionRuntimeTransaction,
  SessionRuntimeWorkItemInput,
  SessionRunSpec,
  SessionTimelineBlock,
  SessionTimelineSegment,
  SessionTimelineTurn,
  SessionTurn,
  SessionTurnMessage,
  SessionTurnStatus,
  TimelineTurnStatus,
} from "./session-runtime.js";

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
  | "SESSION_HISTORY_HYDRATED"
  | "MESSAGE_RECEIVED"
  | "RUN_CREATED"
  | "AGENT_EVENT"
  | "RUN_STARTED"
  | "RUN_SUCCEEDED"
  | "RUN_FAILED"
  | "RUN_CANCELLED"
  | "RUN_CANCEL_REQUESTED"
  | "RUN_INTERRUPTED"
  | "TURN_QUEUED"
  | "TURN_DISPATCHED"
  | "TURN_CANCELLED"
  | "DISCOVERY_STARTED"
  | "PROJECT_CANDIDATE_FOUND"
  | "FLOW_PROPOSED"
  | "FLOW_SELECTED"
  | "FLOW_SAVED_AS_CANDIDATE"
  | "PLAN_PROPOSED"
  | "PLAN_VALIDATED"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_GRANTED"
  | "APPROVAL_REJECTED"
  | "STEP_STARTED"
  | "STEP_SUCCEEDED"
  | "STEP_SKIPPED"
  | "STEP_RETRYING"
  | "STEP_FAILED"
  | "BRANCH_SELECTED"
  | "ARTIFACT_CREATED"
  | "VERIFICATION_COMPLETED"
  | "WORK_ITEM_COMPLETED"
  | "PARAM_RESOLVED"
  | "FLOW_RECOMMENDED"
  | "FLOW_REJECTED"
  | "VERIFICATION_FAILED"
  | "RUN_SNAPSHOT";

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
  sessionId: string | null;
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
  sessionId?: string | null;
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
  | "cancelled"
  | "interrupted";

export interface Run {
  schemaVersion: 1;
  id: string;
  workItemId: string;
  sessionId: string | null;
  turnId: string | null;
  mode: WorkItemMode;
  status: RunStatus;
  agentId: string | null;
  planId: string | null;
  planIrHash: string | null;
  workflowRevision: string | null;
  terminalReason: string | null;
  replaySafety: ReplaySafety;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  cancelRequestedAt: string | null;
  cancelDeadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunInput {
  id?: string;
  workItemId: string;
  sessionId?: string | null;
  turnId?: string | null;
  mode: WorkItemMode;
  agentId?: string | null;
  planId?: string | null;
  planIrHash?: string | null;
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
  successWhen?: string | null;
  retry?: { maxAttempts: number; delayMs: number } | null;
}

export interface PersistedPlan {
  schemaVersion: 1;
  planId: string;
  source: "workflow" | "agent_generated";
  workflowId: string;
  definitionRevision: string | null;
  planIrHash: string | null;
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
  planIrHash?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  steps: PersistedPlanStep[];
}

export type ArtifactKind = "output" | "diff" | "test_report" | "log" | "image" | "other";

export interface ArtifactRecord {
  id: string;
  workItemId: string;
  runId: string;
  stepId: string | null;
  kind: ArtifactKind;
  name: string;
  mimeType: string;
  content: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateArtifactInput {
  id?: string;
  workItemId: string;
  runId: string;
  stepId?: string | null;
  kind?: ArtifactKind;
  name: string;
  mimeType?: string;
  content: string;
  metadata?: Record<string, unknown>;
  actor?: DomainEventActor;
}

export type VerificationStatus = "passed" | "failed" | "skipped";

export interface VerificationRecord {
  id: string;
  workItemId: string;
  runId: string;
  stepId: string | null;
  validator: string;
  status: VerificationStatus;
  summary: string;
  artifactIds: string[];
  createdAt: string;
}

export interface RecordVerificationInput {
  id?: string;
  workItemId: string;
  runId: string;
  stepId?: string | null;
  validator: string;
  status: VerificationStatus;
  summary: string;
  artifactIds?: string[];
}

export interface MessageAttachmentRecord {
  schemaVersion: 1;
  id: string;
  workItemId: string;
  name: string;
  mimeType: string;
  dataBase64: string;
  byteSize: number;
  contentHash: string;
  createdAt: string;
}

export interface CreateMessageAttachmentInput {
  id?: string;
  workItemId: string;
  name: string;
  mimeType?: string;
  dataBase64: string;
}

type SqliteRow = Record<string, unknown>;

const STATUS_BY_EVENT: Partial<Record<DomainEventType, WorkItemStatus>> = {
  PLAN_PROPOSED: "planned",
  APPROVAL_REQUESTED: "awaiting_approval",
  RUN_CANCELLED: "cancelled",
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
    this.database.exec("PRAGMA busy_timeout = 5000;");
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

      CREATE TABLE IF NOT EXISTS message_attachments (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        work_item_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        data_base64 TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS message_attachments_work_item_created
        ON message_attachments (work_item_id, created_at);

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

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        step_id TEXT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (work_item_id) REFERENCES work_items(id),
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );
      CREATE INDEX IF NOT EXISTS artifacts_run_created ON artifacts (run_id, created_at);

      CREATE TABLE IF NOT EXISTS verifications (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        step_id TEXT,
        validator TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        artifact_ids TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (work_item_id) REFERENCES work_items(id),
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );
      CREATE INDEX IF NOT EXISTS verifications_run_created ON verifications (run_id, created_at);
    `);
    for (const statement of [
      "ALTER TABLE runs ADD COLUMN workflow_revision TEXT",
      "ALTER TABLE plans ADD COLUMN plan_ir_hash TEXT",
      "ALTER TABLE runs ADD COLUMN plan_ir_hash TEXT",
    ]) {
      try { this.database.exec(statement); } catch { /* Existing databases already contain the column. */ }
    }
    initializeSessionRuntimeSchema(this.database);
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
      sessionId: input.sessionId ?? null,
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
            session_id, agent_id, workflow_id, workflow_revision, workspace_scope,
            identifiers, context_revision, risk_level, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workItem.id,
          workItem.schemaVersion,
          workItem.title,
          workItem.status,
          workItem.mode,
          workItem.conversationId,
          workItem.sessionId,
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
      if (workItem.sessionId) {
        this.database
          .prepare(
            `INSERT INTO session_runtime (
              session_id, active_run_id, queue_state, queue_pause_reason,
              last_event_sequence, version, updated_at
            ) VALUES (?, NULL, 'ready', NULL, 0, 1, ?)`,
          )
          .run(workItem.sessionId, workItem.createdAt);
      }
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

  getWorkItemBySessionId(sessionId: string): WorkItem | undefined {
    const row = this.database
      .prepare("SELECT * FROM work_items WHERE session_id = ?")
      .get(sessionId);
    return row ? toWorkItem(row) : undefined;
  }

  getSessionRuntime(sessionId: string): SessionRuntime | undefined {
    const row = this.database
      .prepare("SELECT * FROM session_runtime WHERE session_id = ?")
      .get(sessionId);
    return row ? toSessionRuntime(row) : undefined;
  }

  getTurn(turnId: string): SessionTurn | undefined {
    const row = this.database
      .prepare("SELECT * FROM session_turns WHERE turn_id = ?")
      .get(turnId);
    return row ? toSessionTurn(row) : undefined;
  }

  listQueuedTurns(
    sessionId: string,
    options: { afterPosition?: number; limit: number },
  ): {
    turns: SessionTurn[];
    total: number;
    nextCursor: number | null;
  } {
    const afterPosition = Math.max(0, Math.floor(options.afterPosition ?? 0));
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
    const rows = this.database
      .prepare(
        `SELECT * FROM session_turns
         WHERE session_id = ? AND status = 'queued' AND queue_position > ?
         ORDER BY queue_position ASC
         LIMIT ?`,
      )
      .all(sessionId, afterPosition, limit + 1) as SqliteRow[];
    const totalRow = this.database
      .prepare(
        `SELECT COUNT(*) AS total FROM session_turns
         WHERE session_id = ? AND status = 'queued'`,
      )
      .get(sessionId) as { total?: number } | undefined;
    const hasMore = rows.length > limit;
    const turns = rows.slice(0, limit).map(toSessionTurn);
    return {
      turns,
      total: Number(totalRow?.total ?? 0),
      nextCursor: hasMore
        ? turns.at(-1)?.queuePosition ?? null
        : null,
    };
  }

  listTimelineTurns(
    sessionId: string,
    options: {
      before?: number;
      limit: number;
      contentBudgetBytes?: number;
    },
  ): {
    turns: SessionTimelineTurn[];
    previousCursor: number | null;
    truncatedBlockIds: string[];
  } {
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit)));
    const before = Number.isFinite(options.before)
      ? Math.max(1, Math.floor(options.before!))
      : Number.MAX_SAFE_INTEGER;
    const contentBudget = Math.max(
      1,
      Math.min(
        1_048_576,
        Math.floor(options.contentBudgetBytes ?? 1_048_576),
      ),
    );
    const rows = this.database
      .prepare(
        `SELECT * FROM session_timeline_turns
         WHERE session_id = ? AND timeline_index < ?
         ORDER BY timeline_index DESC
         LIMIT ?`,
      )
      .all(sessionId, before, limit + 1) as SqliteRow[];
    const hasEarlier = rows.length > limit;
    const selectedRows = rows.slice(0, limit).reverse();
    const truncatedBlockIds: string[] = [];
    let usedBytes = 0;
    const turns = selectedRows.map((turnRow) => {
      const blockRows = this.database
        .prepare(
          `SELECT * FROM session_timeline_blocks
           WHERE turn_id = ?
           ORDER BY block_index ASC`,
        )
        .all(String(turnRow.turn_id)) as SqliteRow[];
      const blocks: SessionTimelineBlock[] = blockRows.map((blockRow) => {
        const segmentRows = this.database
          .prepare(
            `SELECT * FROM session_output_segments
             WHERE block_id = ?
             ORDER BY segment_index ASC
             LIMIT 101`,
          )
          .all(String(blockRow.block_id)) as SqliteRow[];
        const segments: SessionTimelineSegment[] = [];
        for (const segmentRow of segmentRows.slice(0, 100)) {
          const byteLength = Number(segmentRow.byte_length);
          if (usedBytes + byteLength > contentBudget) break;
          segments.push(toTimelineSegment(segmentRow));
          usedBytes += byteLength;
        }
        const hasMore = segments.length < segmentRows.length;
        if (hasMore) truncatedBlockIds.push(String(blockRow.block_id));
        return {
          ...toTimelineBlock(blockRow),
          segments,
          nextSegmentCursor: hasMore
            ? segments.at(-1)?.segmentIndex ?? -1
            : null,
        };
      });
      return {
        ...toTimelineTurn(turnRow),
        blocks,
      };
    });
    return {
      turns,
      previousCursor: hasEarlier
        ? turns[0]?.timelineIndex ?? null
        : null,
      truncatedBlockIds,
    };
  }

  listTimelineSegments(
    blockId: string,
    options: { after?: number; limit: number },
  ): {
    segments: SessionTimelineSegment[];
    nextCursor: number | null;
  } {
    const after = Number.isFinite(options.after)
      ? Math.floor(options.after!)
      : -1;
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
    const rows = this.database
      .prepare(
        `SELECT * FROM session_output_segments
         WHERE block_id = ? AND segment_index > ?
         ORDER BY segment_index ASC
         LIMIT ?`,
      )
      .all(blockId, after, limit + 1) as SqliteRow[];
    const hasMore = rows.length > limit;
    const segments = rows.slice(0, limit).map(toTimelineSegment);
    return {
      segments,
      nextCursor: hasMore
        ? segments.at(-1)?.segmentIndex ?? null
        : null,
    };
  }

  listSessionCommands(sessionId: string): Array<{
    name: string;
    description: string;
    input?: { hint: string };
  }> {
    const rows = this.database
      .prepare(
        `SELECT name, description, input_json
         FROM session_commands
         WHERE session_id = ?
         ORDER BY name ASC`,
      )
      .all(sessionId) as SqliteRow[];
    return rows.map((row) => {
      const input = row.input_json === null || row.input_json === undefined
        ? undefined
        : JSON.parse(String(row.input_json)) as { hint: string };
      return {
        name: String(row.name),
        description: String(row.description),
        ...(input ? { input } : {}),
      };
    });
  }

  countAllChanges(): number {
    const row = this.database
      .prepare("SELECT total_changes() AS value")
      .get() as { value?: number } | undefined;
    return Number(row?.value ?? 0);
  }

  getProviderHistoryImport(
    sessionId: string,
    providerSessionId: string,
  ): {
    providerDigest: string;
    importedPosition: number;
    importedAt: string;
  } | undefined {
    const row = this.database
      .prepare(
        `SELECT provider_digest, imported_position, imported_at
         FROM provider_history_imports
         WHERE session_id = ? AND provider_session_id = ?`,
      )
      .get(sessionId, providerSessionId) as SqliteRow | undefined;
    return row
      ? {
          providerDigest: String(row.provider_digest),
          importedPosition: Number(row.imported_position),
          importedAt: String(row.imported_at),
        }
      : undefined;
  }

  importProviderHistory(
    input: ProviderHistoryImportInput,
  ): ProviderHistoryImportResult {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = importProviderHistoryInTransaction(
        this.database,
        input,
      );
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  withSessionTransaction<T>(
    operation: (transaction: SessionRuntimeTransaction) => T,
  ): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const transaction = createSqliteSessionRuntimeTransaction(
        this.database,
      );
      const result = operation(transaction);
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
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

  appendLeasedRunEvent(
    owner: string,
    input: SessionEventInput & { runId: string },
  ): DomainEvent {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const lease = this.database
        .prepare(
          `SELECT 1 FROM runs
           WHERE id = ? AND session_id = ? AND status = 'running'
             AND lease_owner = ? AND lease_expires_at >= ?`,
        )
        .get(
          input.runId,
          input.sessionId,
          owner,
          new Date().toISOString(),
        );
      if (!lease) throw new Error("run_lease_lost");
      const event = appendSessionEventInTransaction(
        this.database,
        input,
      );
      this.database.exec("COMMIT;");
      return event;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  appendEventOnce(input: AppendEventInput & { inputHash: string }): DomainEvent {
    if (!this.getWorkItem(input.workItemId)) {
      throw new Error(`WorkItem not found: ${input.workItemId}`);
    }

    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.database
        .prepare("SELECT * FROM domain_events WHERE work_item_id = ? AND input_hash = ? LIMIT 1")
        .get(input.workItemId, input.inputHash) as SqliteRow | undefined;
      const event = existing ? toDomainEvent(existing) : this.appendEventInTransaction(input);
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

  listRecentEvents(workItemId: string, limit: number): DomainEvent[] {
    const boundedLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    const rows = this.database
      .prepare(
        `SELECT * FROM domain_events
         WHERE work_item_id = ?
         ORDER BY sequence DESC
         LIMIT ?`,
      )
      .all(workItemId, boundedLimit) as SqliteRow[];
    return rows.reverse().map(toDomainEvent);
  }

  listEventInputHashes(workItemId: string): Set<string> {
    const rows = this.database
      .prepare(
        `SELECT input_hash FROM domain_events
         WHERE work_item_id = ? AND input_hash IS NOT NULL`,
      )
      .all(workItemId) as Array<{ input_hash?: unknown }>;
    return new Set(rows.map((row) => String(row.input_hash)));
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
      planIrHash: input.planIrHash ?? null,
      sessionId: input.sessionId ?? null,
      runId: input.runId ?? null,
      steps: input.steps.map(clonePlanStep),
      createdAt: new Date().toISOString(),
    };
    this.database
      .prepare(
        `INSERT INTO plans (
          plan_id, schema_version, source, workflow_id, definition_revision,
          plan_ir_hash, session_id, run_id, steps, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plan_id) DO UPDATE SET
          source = excluded.source,
          workflow_id = excluded.workflow_id,
          definition_revision = excluded.definition_revision,
          plan_ir_hash = excluded.plan_ir_hash,
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
        plan.planIrHash,
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
      sessionId: input.sessionId ?? workItem.sessionId,
      turnId: input.turnId ?? null,
      mode: input.mode,
      status: "queued",
      agentId: input.agentId ?? workItem.agentId,
      planId: input.planId ?? null,
      planIrHash: input.planIrHash ?? plan?.planIrHash ?? null,
      workflowRevision:
        input.workflowRevision ?? plan?.definitionRevision ?? workItem.workflowRevision,
      terminalReason: null,
      replaySafety: "safe",
      leaseOwner: null,
      leaseExpiresAt: null,
      cancelRequestedAt: null,
      cancelDeadlineAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database
        .prepare(
          `INSERT INTO runs (
            id, schema_version, work_item_id, session_id, turn_id, mode, status,
            agent_id, plan_id, plan_ir_hash, workflow_revision, terminal_reason,
            replay_safety, lease_owner, lease_expires_at, cancel_requested_at,
            cancel_deadline_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.schemaVersion,
          run.workItemId,
          run.sessionId,
          run.turnId,
          run.mode,
          run.status,
          run.agentId,
          run.planId,
          run.planIrHash,
          run.workflowRevision,
          run.terminalReason,
          run.replaySafety,
          run.leaseOwner,
          run.leaseExpiresAt,
          run.cancelRequestedAt,
          run.cancelDeadlineAt,
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

  updateRunControl(
    runId: string,
    patch: {
      status?: RunStatus;
      terminalReason?: string | null;
      replaySafety?: ReplaySafety;
      leaseOwner?: string | null;
      leaseExpiresAt?: string | null;
      cancelRequestedAt?: string | null;
      cancelDeadlineAt?: string | null;
    },
  ): Run {
    const current = this.getRun(runId);
    if (!current) throw new Error(`Run not found: ${runId}`);
    const next = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.database
      .prepare(
        `UPDATE runs
         SET status = ?, terminal_reason = ?, replay_safety = ?,
           lease_owner = ?, lease_expires_at = ?, cancel_requested_at = ?,
           cancel_deadline_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.status,
        next.terminalReason,
        next.replaySafety,
        next.leaseOwner,
        next.leaseExpiresAt,
        next.cancelRequestedAt,
        next.cancelDeadlineAt,
        next.updatedAt,
        runId,
      );
    return this.getRun(runId)!;
  }

  claimRun(
    runId: string,
    owner: string,
    now: string,
    expiresAt: string,
  ): Run | null {
    return this.withSessionTransaction((tx) =>
      tx.claimRun(runId, owner, now, expiresAt)
    );
  }

  renewRunLease(
    runId: string,
    owner: string,
    expiresAt: string,
  ): Run | null {
    return this.withSessionTransaction((tx) =>
      tx.renewRunLease(runId, owner, expiresAt)
    );
  }

  updateLeasedRunReplaySafety(
    runId: string,
    owner: string,
    replaySafety: ReplaySafety,
  ): Run {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `UPDATE runs
         SET replay_safety = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at >= ?`,
      )
      .run(replaySafety, now, runId, owner, now);
    if (Number(result.changes) !== 1) {
      throw new Error("run_lease_lost");
    }
    return this.getRun(runId)!;
  }

  listExpiredRunningRuns(now: string, limit: number): Run[] {
    return createSqliteSessionRuntimeTransaction(this.database)
      .listExpiredRunningRuns(now, limit);
  }

  listCancellationDeadlineRuns(now: string, limit: number): Run[] {
    return createSqliteSessionRuntimeTransaction(this.database)
      .listCancellationDeadlineRuns(now, limit);
  }

  startRunAttempt(runId: string): RunAttempt {
    if (!this.getRun(runId)) throw new Error(`Run not found: ${runId}`);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.database
        .prepare(
          `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt
           FROM run_attempts WHERE run_id = ?`,
        )
        .get(runId) as { next_attempt?: number } | undefined;
      const attemptId =
        `attempt_${randomUUID().replaceAll("-", "")}`;
      this.database
        .prepare(
          `INSERT INTO run_attempts (
            attempt_id, run_id, attempt_number, started_at, ended_at,
            provider_error, side_effect_boundary
          ) VALUES (?, ?, ?, ?, NULL, NULL, 'safe')`,
        )
        .run(
          attemptId,
          runId,
          Number(row?.next_attempt ?? 1),
          new Date().toISOString(),
        );
      const attempt = this.database
        .prepare("SELECT * FROM run_attempts WHERE attempt_id = ?")
        .get(attemptId) as SqliteRow;
      this.database.exec("COMMIT;");
      return toRunAttempt(attempt);
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  finishRunAttempt(
    attemptId: string,
    input: {
      providerError: string | null;
      sideEffectBoundary: ReplaySafety;
    },
  ): RunAttempt {
    const result = this.database
      .prepare(
        `UPDATE run_attempts
         SET ended_at = ?, provider_error = ?,
           side_effect_boundary = ?
         WHERE attempt_id = ? AND ended_at IS NULL`,
      )
      .run(
        new Date().toISOString(),
        input.providerError,
        input.sideEffectBoundary,
        attemptId,
      );
    if (Number(result.changes) !== 1) {
      throw new Error(`Open Run attempt not found: ${attemptId}`);
    }
    const row = this.database
      .prepare("SELECT * FROM run_attempts WHERE attempt_id = ?")
      .get(attemptId) as SqliteRow;
    return toRunAttempt(row);
  }

  listRunAttempts(runId: string): RunAttempt[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM run_attempts
         WHERE run_id = ? ORDER BY attempt_number ASC`,
      )
      .all(runId) as SqliteRow[];
    return rows.map(toRunAttempt);
  }

  findTerminalEventForRun(runId: string): DomainEvent | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM domain_events
         WHERE run_id = ?
           AND type IN (
             'RUN_SUCCEEDED', 'RUN_FAILED',
             'RUN_CANCELLED', 'RUN_INTERRUPTED'
           )
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(runId) as SqliteRow | undefined;
    return row ? toDomainEvent(row) : undefined;
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

  createMessageAttachment(input: CreateMessageAttachmentInput): MessageAttachmentRecord {
    if (!this.getWorkItem(input.workItemId)) throw new Error(`WorkItem not found: ${input.workItemId}`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64) || input.dataBase64.length % 4 === 1) {
      throw new Error("attachment data must be valid base64");
    }
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (bytes.length === 0) throw new Error("attachment data cannot be empty");
    if (bytes.length > 10_000_000) throw new Error("attachment content exceeds 10 MB");
    const record: MessageAttachmentRecord = {
      schemaVersion: 1,
      id: input.id ?? createId("attachment"),
      workItemId: input.workItemId,
      name: path.basename(input.name || "attachment"),
      mimeType: input.mimeType || "application/octet-stream",
      dataBase64: input.dataBase64,
      byteSize: bytes.length,
      contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      createdAt: new Date().toISOString(),
    };
    this.database
      .prepare(
        `INSERT INTO message_attachments (
          id, schema_version, work_item_id, name, mime_type, data_base64,
          byte_size, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.schemaVersion,
        record.workItemId,
        record.name,
        record.mimeType,
        record.dataBase64,
        record.byteSize,
        record.contentHash,
        record.createdAt,
      );
    return record;
  }

  getMessageAttachment(id: string): MessageAttachmentRecord | undefined {
    const row = this.database.prepare("SELECT * FROM message_attachments WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? toMessageAttachment(row) : undefined;
  }

  listMessageAttachments(workItemId: string, ids?: string[]): MessageAttachmentRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM message_attachments WHERE work_item_id = ? ORDER BY created_at ASC")
      .all(workItemId) as SqliteRow[];
    const attachments = rows.map(toMessageAttachment);
    if (!ids) return attachments;
    const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
    return ids.flatMap((id) => {
      const attachment = byId.get(id);
      return attachment ? [attachment] : [];
    });
  }

  createArtifact(input: CreateArtifactInput): ArtifactRecord {
    if (!this.getWorkItem(input.workItemId)) throw new Error(`WorkItem not found: ${input.workItemId}`);
    if (!this.getRun(input.runId)) throw new Error(`Run not found: ${input.runId}`);
    if (input.content.length > 10_000_000) throw new Error("artifact content exceeds 10 MB");
    const record: ArtifactRecord = {
      id: input.id ?? createId("artifact"),
      workItemId: input.workItemId,
      runId: input.runId,
      stepId: input.stepId ?? null,
      kind: input.kind ?? "output",
      name: input.name,
      mimeType: input.mimeType ?? "text/plain",
      content: input.content,
      contentHash: `sha256:${createHash("sha256").update(input.content).digest("hex")}`,
      metadata: { ...(input.metadata ?? {}) },
      createdAt: new Date().toISOString(),
    };
    this.database
      .prepare(
        `INSERT INTO artifacts (
          id, work_item_id, run_id, step_id, kind, name, mime_type, content,
          content_hash, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workItemId,
        record.runId,
        record.stepId,
        record.kind,
        record.name,
        record.mimeType,
        record.content,
        record.contentHash,
        JSON.stringify(record.metadata),
        record.createdAt,
      );
    this.appendEvent({
      workItemId: record.workItemId,
      runId: record.runId,
      type: "ARTIFACT_CREATED",
      actor: input.actor ?? "adapter",
      target: record.id,
      resultRef: `artifact://${record.id}`,
      payload: {
        artifact_id: record.id,
        step_id: record.stepId,
        kind: record.kind,
        name: record.name,
        mime_type: record.mimeType,
        content_hash: record.contentHash,
      },
    });
    return record;
  }

  getArtifact(id: string): ArtifactRecord | undefined {
    const row = this.database.prepare("SELECT * FROM artifacts WHERE id = ?").get(id);
    return row ? toArtifact(row) : undefined;
  }

  listArtifacts(runId: string): ArtifactRecord[] {
    return (this.database.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC").all(runId) as SqliteRow[]).map(toArtifact);
  }

  recordVerification(input: RecordVerificationInput): VerificationRecord {
    if (!this.getWorkItem(input.workItemId)) throw new Error(`WorkItem not found: ${input.workItemId}`);
    if (!this.getRun(input.runId)) throw new Error(`Run not found: ${input.runId}`);
    const record: VerificationRecord = {
      id: input.id ?? createId("verification"),
      workItemId: input.workItemId,
      runId: input.runId,
      stepId: input.stepId ?? null,
      validator: input.validator,
      status: input.status,
      summary: input.summary,
      artifactIds: [...(input.artifactIds ?? [])],
      createdAt: new Date().toISOString(),
    };
    this.database
      .prepare(
        `INSERT INTO verifications (
          id, work_item_id, run_id, step_id, validator, status, summary,
          artifact_ids, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workItemId,
        record.runId,
        record.stepId,
        record.validator,
        record.status,
        record.summary,
        JSON.stringify(record.artifactIds),
        record.createdAt,
      );
    this.appendEvent({
      workItemId: record.workItemId,
      runId: record.runId,
      type: "VERIFICATION_COMPLETED",
      actor: "adapter",
      target: record.stepId ?? record.runId,
      resultRef: record.artifactIds[0] ? `artifact://${record.artifactIds[0]}` : null,
      payload: {
        verification_id: record.id,
        step_id: record.stepId,
        validator: record.validator,
        status: record.status,
        summary: record.summary,
        artifact_ids: record.artifactIds,
      },
    });
    return record;
  }

  listVerifications(runId: string): VerificationRecord[] {
    return (this.database.prepare("SELECT * FROM verifications WHERE run_id = ? ORDER BY created_at ASC").all(runId) as SqliteRow[]).map(toVerification);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private appendEventInTransaction(input: AppendEventInput): DomainEvent {
    const workItem = this.database
      .prepare("SELECT session_id FROM work_items WHERE id = ?")
      .get(input.workItemId) as
        | { session_id?: string | null }
        | undefined;
    if (workItem?.session_id) {
      return appendSessionEventInTransaction(this.database, {
        ...input,
        sessionId: String(workItem.session_id),
      });
    }
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

    this.database
      .prepare(
        `UPDATE session_runtime
         SET last_event_sequence = ?, updated_at = ?
         WHERE session_id = (
           SELECT session_id FROM work_items WHERE id = ?
         )`,
      )
      .run(event.sequence, event.occurredAt, event.workItemId);

    const nextStatus = STATUS_BY_EVENT[event.type];
    if (nextStatus) {
      this.database
        .prepare("UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?")
        .run(nextStatus, event.occurredAt, event.workItemId);
    }

    return event;
  }

}

function createId(prefix: "wi" | "evt" | "run" | "artifact" | "verification" | "attachment"): string {
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
    sessionId: row.session_id === null || row.session_id === undefined
      ? null
      : String(row.session_id),
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
    sessionId: row.session_id === null || row.session_id === undefined
      ? null
      : String(row.session_id),
    turnId: row.turn_id === null || row.turn_id === undefined
      ? null
      : String(row.turn_id),
    mode: String(row.mode) as WorkItemMode,
    status: String(row.status) as RunStatus,
    agentId: row.agent_id === null ? null : String(row.agent_id),
    planId: row.plan_id === null ? null : String(row.plan_id),
    planIrHash: row.plan_ir_hash === null || row.plan_ir_hash === undefined ? null : String(row.plan_ir_hash),
    workflowRevision:
      row.workflow_revision === null || row.workflow_revision === undefined
        ? null
        : String(row.workflow_revision),
    terminalReason:
      row.terminal_reason === null || row.terminal_reason === undefined
        ? null
        : String(row.terminal_reason),
    replaySafety: String(row.replay_safety ?? "safe") as ReplaySafety,
    leaseOwner:
      row.lease_owner === null || row.lease_owner === undefined
        ? null
        : String(row.lease_owner),
    leaseExpiresAt:
      row.lease_expires_at === null || row.lease_expires_at === undefined
        ? null
        : String(row.lease_expires_at),
    cancelRequestedAt:
      row.cancel_requested_at === null || row.cancel_requested_at === undefined
        ? null
        : String(row.cancel_requested_at),
    cancelDeadlineAt:
      row.cancel_deadline_at === null || row.cancel_deadline_at === undefined
        ? null
        : String(row.cancel_deadline_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toSessionRuntime(row: SqliteRow): SessionRuntime {
  return {
    sessionId: String(row.session_id),
    activeRunId:
      row.active_run_id === null || row.active_run_id === undefined
        ? null
        : String(row.active_run_id),
    queueState: String(row.queue_state) as QueueState,
    queuePauseReason:
      row.queue_pause_reason === null || row.queue_pause_reason === undefined
        ? null
        : String(row.queue_pause_reason) as Exclude<QueuePauseReason, null>,
    lastEventSequence: Number(row.last_event_sequence),
    version: Number(row.version),
    updatedAt: String(row.updated_at),
  };
}

function toSessionTurn(row: SqliteRow): SessionTurn {
  return {
    turnId: String(row.turn_id),
    sessionId: String(row.session_id),
    queuePosition: Number(row.queue_position),
    status: String(row.status) as SessionTurnStatus,
    message: JSON.parse(String(row.message_json)) as SessionTurnMessage,
    version: Number(row.version),
    dispatchedRunId:
      row.dispatched_run_id === null || row.dispatched_run_id === undefined
        ? null
        : String(row.dispatched_run_id),
    createdAt: String(row.created_at),
    dispatchedAt:
      row.dispatched_at === null || row.dispatched_at === undefined
        ? null
        : String(row.dispatched_at),
    cancelledAt:
      row.cancelled_at === null || row.cancelled_at === undefined
        ? null
        : String(row.cancelled_at),
  };
}

function toRunAttempt(row: SqliteRow): RunAttempt {
  return {
    attemptId: String(row.attempt_id),
    runId: String(row.run_id),
    attemptNumber: Number(row.attempt_number),
    startedAt: String(row.started_at),
    endedAt: row.ended_at === null
      ? null
      : String(row.ended_at),
    providerError: row.provider_error === null
      ? null
      : String(row.provider_error),
    sideEffectBoundary: String(
      row.side_effect_boundary,
    ) as ReplaySafety,
  };
}

function toTimelineSegment(row: SqliteRow): SessionTimelineSegment {
  return {
    segmentId: String(row.segment_id),
    blockId: String(row.block_id),
    segmentIndex: Number(row.segment_index),
    content: String(row.content),
    byteLength: Number(row.byte_length),
    sealed: Number(row.sealed) === 1,
  };
}

function toTimelineBlock(
  row: SqliteRow,
): Omit<SessionTimelineBlock, "segments" | "nextSegmentCursor"> {
  return {
    blockId: String(row.block_id),
    sessionId: String(row.session_id),
    turnId: String(row.turn_id),
    runId: String(row.run_id),
    blockIndex: Number(row.block_index),
    kind: String(row.kind),
    status: String(row.status),
    metadata: JSON.parse(
      String(row.metadata_json ?? "{}"),
    ) as Record<string, unknown>,
  };
}

function toTimelineTurn(
  row: SqliteRow,
): Omit<SessionTimelineTurn, "blocks"> {
  return {
    sessionId: String(row.session_id),
    timelineIndex: Number(row.timeline_index),
    turnId: String(row.turn_id),
    runId: String(row.run_id),
    startedSequence: Number(row.started_sequence),
    endedSequence:
      row.ended_sequence === null || row.ended_sequence === undefined
        ? null
        : Number(row.ended_sequence),
    status: String(row.status) as SessionTimelineTurn["status"],
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
    planIrHash: row.plan_ir_hash === null || row.plan_ir_hash === undefined ? null : String(row.plan_ir_hash),
    sessionId: row.session_id === null ? null : String(row.session_id),
    runId: row.run_id === null ? null : String(row.run_id),
    steps: (JSON.parse(String(row.steps)) as PersistedPlanStep[]).map(clonePlanStep),
    createdAt: String(row.created_at),
  };
}

function toArtifact(row: SqliteRow): ArtifactRecord {
  return {
    id: String(row.id),
    workItemId: String(row.work_item_id),
    runId: String(row.run_id),
    stepId: row.step_id === null ? null : String(row.step_id),
    kind: String(row.kind) as ArtifactKind,
    name: String(row.name),
    mimeType: String(row.mime_type),
    content: String(row.content),
    contentHash: String(row.content_hash),
    metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>,
    createdAt: String(row.created_at),
  };
}

function toMessageAttachment(row: SqliteRow): MessageAttachmentRecord {
  return {
    schemaVersion: Number(row.schema_version) as 1,
    id: String(row.id),
    workItemId: String(row.work_item_id),
    name: String(row.name),
    mimeType: String(row.mime_type),
    dataBase64: String(row.data_base64),
    byteSize: Number(row.byte_size),
    contentHash: String(row.content_hash),
    createdAt: String(row.created_at),
  };
}

function toVerification(row: SqliteRow): VerificationRecord {
  return {
    id: String(row.id),
    workItemId: String(row.work_item_id),
    runId: String(row.run_id),
    stepId: row.step_id === null ? null : String(row.step_id),
    validator: String(row.validator),
    status: String(row.status) as VerificationStatus,
    summary: String(row.summary),
    artifactIds: JSON.parse(String(row.artifact_ids)) as string[],
    createdAt: String(row.created_at),
  };
}

function clonePlanStep(step: PersistedPlanStep): PersistedPlanStep {
  return {
    ...step,
    dependsOn: [...step.dependsOn],
    branches: step.branches.map((branch) => ({ ...branch })),
    retry: step.retry ? { ...step.retry } : null,
  };
}

// ---- Learning-signal payloads (docs/superpowers/specs/2026-08-13-flow-design.md §5.1) ----
// Strong schemas: these feed the data flywheel, dirty data cannot be learned from.

export type ParamResolution = "edited" | "picked_alternative" | "confirmed";

export interface ParamResolvedPayload {
  flow_id: string;
  flow_revision: string;
  field: string;
  candidate_value: unknown;
  final_value: unknown;
  resolution: ParamResolution;
  source: "user" | "agent_extracted" | "step_output" | "default" | `context.${string}`;
  /** Required when source is agent_extracted: links back to the conversation event. */
  evidence_ref?: string;
  context?: string;
  resolver_version?: string;
}

export interface FlowRecommendedPayload {
  flow_id: string;
  flow_revision: string;
  match_reason: string;
  confidence: number;
}

export type FlowRejectReason = "wrong_intent" | "missing_capability" | "bad_timing" | "other";

export interface FlowRejectedPayload {
  flow_id: string;
  reason: FlowRejectReason;
  note?: string;
  user_chose?: "freeform" | string;
}

export type VerificationFailureCategory = "verification" | "infrastructure" | "policy" | "llm_output";

export interface VerificationFailedPayload {
  step_id: string;
  category: VerificationFailureCategory;
  postcondition: string;
  /** Output summary, capped at 4KB serialized; truncated flags the cap was hit. */
  actual: unknown;
  truncated: boolean;
}

/** Attribution block: every variable that can change output, hashed (spec §5.2). */
export interface Attribution {
  /** plan_ir_hash — the compiled execution artifact, NOT the YAML hash. */
  flow_revision: string;
  prompt_revision: string;
  tool_schema_revision: string;
  capability_revisions: Record<string, string>;
  resolver_revision: string;
  authorization_revision: string;
}

export interface ResolvedInput {
  field: string;
  value: unknown;
  source: ParamResolvedPayload["source"];
  evidence_ref?: string;
  resolver_version: string;
  /** directory inputs must carry the authorization record ref. */
  authorization_ref?: string;
}

export interface DecisionTraceStep {
  step_id: string;
  capability_id: string;
  capability_revision: string;
  /** Must be an artifact:// reference; large outputs are never inlined. */
  output_ref: string;
  verification_status: "passed" | "failed" | "skipped";
}

export interface RunSnapshotPayload {
  flow_id: string;
  flow_revision: string;
  resolved_inputs: ResolvedInput[];
  steps: DecisionTraceStep[];
  outcome: "succeeded" | "failed";
  attribution: Attribution;
}
