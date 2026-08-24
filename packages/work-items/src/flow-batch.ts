import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

export type FlowBatchDraftStatus =
  | "needs_input"
  | "ready"
  | "confirmed"
  | "stale"
  | "cancelled";

export type FlowBatchStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "partial_succeeded"
  | "failed"
  | "cancelled";

export type FlowBatchChildStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface FlowBatchInputEvidence {
  source: "user" | "agent_extracted" | "context" | "default";
  evidenceRef: string;
  inferred: boolean;
}

export interface FlowBatchInvocationIssue {
  code:
    | "missing"
    | "ambiguous"
    | "invalid_type"
    | "invalid_value"
    | "duplicate"
    | "conflict";
  field: string | null;
  message: string;
  blocking: boolean;
}

export interface FlowBatchDraftItem {
  itemId: string;
  ordinal: number;
  label: string | null;
  inputs: Record<string, unknown>;
  evidence: Record<string, FlowBatchInputEvidence>;
  issues: FlowBatchInvocationIssue[];
}

export interface FlowBatchDraft {
  schemaVersion: 1;
  draftId: string;
  sessionId: string;
  sourceRunId: string;
  flowId: string;
  definitionRevision: string;
  status: FlowBatchDraftStatus;
  revision: number;
  globalInputs: Record<string, unknown>;
  items: FlowBatchDraftItem[];
  sourceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateFlowBatchDraftInput {
  draftId?: string;
  sessionId: string;
  sourceRunId: string;
  flowId: string;
  definitionRevision: string;
  status: Extract<FlowBatchDraftStatus, "needs_input" | "ready">;
  globalInputs: Record<string, unknown>;
  items: FlowBatchDraftItem[];
  sourceRefs: string[];
}

export interface ReplaceFlowBatchDraftInput {
  draftId: string;
  expectedRevision: number;
  status: Extract<FlowBatchDraftStatus, "needs_input" | "ready" | "stale">;
  globalInputs: Record<string, unknown>;
  items: FlowBatchDraftItem[];
  sourceRefs: string[];
}

export interface FlowBatchRun {
  schemaVersion: 1;
  batchId: string;
  draftId: string;
  sessionId: string;
  sourceRunId: string;
  flowId: string;
  definitionRevision: string;
  planIrHash: string;
  concurrency: number;
  failurePolicy: "continue";
  createdBy: string;
  idempotencyKey: string;
  flowSnapshot: Record<string, unknown>;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConfirmFlowBatchDraftInput {
  draftId: string;
  expectedRevision: number;
  idempotencyKey: string;
  planIrHash: string;
  flowSnapshot: Record<string, unknown>;
  concurrency: number;
  createdBy: string;
}

export interface FlowBatchItemRun {
  batchId: string;
  itemId: string;
  ordinal: number;
  attempt: number;
  workItemId: string;
  runId: string;
  inputHash: string;
  resolvedInputs: Record<string, unknown>;
  materializedAt: string | null;
  cancelledAt: string | null;
  supersedesRunId: string | null;
  createdAt: string;
}

export interface ReserveFlowBatchRetryInput {
  batchId: string;
  itemIds: string[];
  idempotencyKey: string;
}

export type FlowBatchStoreErrorCode =
  | "batch_draft_not_found"
  | "batch_draft_not_ready"
  | "batch_draft_changed"
  | "batch_draft_immutable"
  | "batch_not_found"
  | "batch_retry_empty";

export class FlowBatchStoreError extends Error {
  constructor(public readonly code: FlowBatchStoreErrorCode) {
    super(code);
    this.name = "FlowBatchStoreError";
  }
}

export function aggregateFlowBatchStatus(
  statuses: FlowBatchChildStatus[],
  options: { cancelRequested?: boolean } = {},
): FlowBatchStatus {
  if (statuses.length === 0 || statuses.every((status) => status === "queued")) {
    return options.cancelRequested ? "cancelled" : "queued";
  }
  if (statuses.some((status) => ["queued", "running", "waiting"].includes(status))) {
    return "running";
  }
  const succeeded = statuses.filter((status) => status === "succeeded").length;
  if (succeeded === statuses.length) return "succeeded";
  if (succeeded > 0) return "partial_succeeded";
  if (options.cancelRequested && statuses.every((status) => status === "cancelled")) {
    return "cancelled";
  }
  return "failed";
}

type Row = Record<string, unknown>;

export class FlowBatchStore {
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
      CREATE TABLE IF NOT EXISTS flow_invocation_drafts (
        draft_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        flow_id TEXT NOT NULL,
        definition_revision TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        global_inputs TEXT NOT NULL,
        items TEXT NOT NULL,
        source_refs TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flow_invocation_drafts_session_updated
        ON flow_invocation_drafts (session_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS flow_batch_runs (
        batch_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        draft_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        flow_id TEXT NOT NULL,
        definition_revision TEXT NOT NULL,
        plan_ir_hash TEXT NOT NULL,
        concurrency INTEGER NOT NULL,
        failure_policy TEXT NOT NULL,
        created_by TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        flow_snapshot TEXT NOT NULL,
        cancel_requested_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (draft_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS flow_batch_runs_session_created
        ON flow_batch_runs (session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS flow_batch_items (
        batch_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        work_item_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL UNIQUE,
        input_hash TEXT NOT NULL,
        resolved_inputs TEXT NOT NULL,
        materialized_at TEXT,
        cancelled_at TEXT,
        supersedes_run_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (batch_id, item_id, attempt),
        FOREIGN KEY (batch_id) REFERENCES flow_batch_runs(batch_id)
      );
      CREATE INDEX IF NOT EXISTS flow_batch_items_batch_ordinal
        ON flow_batch_items (batch_id, ordinal, attempt);

      CREATE TABLE IF NOT EXISTS flow_batch_retry_keys (
        batch_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        run_ids TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (batch_id, idempotency_key)
      );
    `);
  }

  createDraft(input: CreateFlowBatchDraftInput): FlowBatchDraft {
    const now = new Date().toISOString();
    const draft: FlowBatchDraft = {
      schemaVersion: 1,
      draftId: input.draftId ?? createId("batch_draft"),
      sessionId: input.sessionId,
      sourceRunId: input.sourceRunId,
      flowId: input.flowId,
      definitionRevision: input.definitionRevision,
      status: input.status,
      revision: 1,
      globalInputs: cloneRecord(input.globalInputs),
      items: cloneItems(input.items),
      sourceRefs: [...input.sourceRefs],
      createdAt: now,
      updatedAt: now,
    };
    this.database.prepare(`
      INSERT INTO flow_invocation_drafts (
        draft_id, schema_version, session_id, source_run_id, flow_id,
        definition_revision, status, revision, global_inputs, items,
        source_refs, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      draft.draftId,
      draft.schemaVersion,
      draft.sessionId,
      draft.sourceRunId,
      draft.flowId,
      draft.definitionRevision,
      draft.status,
      draft.revision,
      JSON.stringify(draft.globalInputs),
      JSON.stringify(draft.items),
      JSON.stringify(draft.sourceRefs),
      draft.createdAt,
      draft.updatedAt,
    );
    return draft;
  }

  getDraft(draftId: string): FlowBatchDraft | undefined {
    const row = this.database.prepare(
      "SELECT * FROM flow_invocation_drafts WHERE draft_id = ?",
    ).get(draftId) as Row | undefined;
    return row ? toDraft(row) : undefined;
  }

  listDraftsForSession(sessionId: string): FlowBatchDraft[] {
    return (this.database.prepare(`
      SELECT * FROM flow_invocation_drafts
      WHERE session_id = ? ORDER BY updated_at DESC, draft_id DESC
    `).all(sessionId) as Row[]).map(toDraft);
  }

  replaceDraft(input: ReplaceFlowBatchDraftInput): FlowBatchDraft {
    const current = this.requireDraft(input.draftId);
    if (["confirmed", "cancelled"].includes(current.status)) {
      throw new FlowBatchStoreError("batch_draft_immutable");
    }
    if (current.revision !== input.expectedRevision) {
      throw new FlowBatchStoreError("batch_draft_changed");
    }
    const nextRevision = current.revision + 1;
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE flow_invocation_drafts
      SET status = ?, revision = ?, global_inputs = ?, items = ?,
        source_refs = ?, updated_at = ?
      WHERE draft_id = ? AND revision = ?
    `).run(
      input.status,
      nextRevision,
      JSON.stringify(input.globalInputs),
      JSON.stringify(input.items),
      JSON.stringify(input.sourceRefs),
      now,
      input.draftId,
      input.expectedRevision,
    );
    return this.requireDraft(input.draftId);
  }

  cancelDraft(draftId: string): FlowBatchDraft {
    const current = this.requireDraft(draftId);
    if (current.status === "confirmed") {
      throw new FlowBatchStoreError("batch_draft_immutable");
    }
    if (current.status === "cancelled") return current;
    this.database.prepare(`
      UPDATE flow_invocation_drafts
      SET status = 'cancelled', revision = revision + 1, updated_at = ?
      WHERE draft_id = ?
    `).run(new Date().toISOString(), draftId);
    return this.requireDraft(draftId);
  }

  confirmDraft(input: ConfirmFlowBatchDraftInput): FlowBatchRun {
    const existing = this.batchForDraft(input.draftId);
    if (existing) {
      if (existing.idempotencyKey === input.idempotencyKey) return existing;
      return existing;
    }
    const draft = this.requireDraft(input.draftId);
    if (draft.revision !== input.expectedRevision) {
      throw new FlowBatchStoreError("batch_draft_changed");
    }
    if (draft.status !== "ready") {
      throw new FlowBatchStoreError("batch_draft_not_ready");
    }
    const now = new Date().toISOString();
    const batch: FlowBatchRun = {
      schemaVersion: 1,
      batchId: createId("batch"),
      draftId: draft.draftId,
      sessionId: draft.sessionId,
      sourceRunId: draft.sourceRunId,
      flowId: draft.flowId,
      definitionRevision: draft.definitionRevision,
      planIrHash: input.planIrHash,
      concurrency: Math.max(1, Math.min(10, Math.floor(input.concurrency))),
      failurePolicy: "continue",
      createdBy: input.createdBy,
      idempotencyKey: input.idempotencyKey,
      flowSnapshot: cloneRecord(input.flowSnapshot),
      cancelRequestedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.prepare(`
        INSERT INTO flow_batch_runs (
          batch_id, schema_version, draft_id, session_id, source_run_id,
          flow_id, definition_revision, plan_ir_hash, concurrency,
          failure_policy, created_by, idempotency_key, flow_snapshot,
          cancel_requested_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batch.batchId,
        batch.schemaVersion,
        batch.draftId,
        batch.sessionId,
        batch.sourceRunId,
        batch.flowId,
        batch.definitionRevision,
        batch.planIrHash,
        batch.concurrency,
        batch.failurePolicy,
        batch.createdBy,
        batch.idempotencyKey,
        JSON.stringify(batch.flowSnapshot),
        batch.cancelRequestedAt,
        batch.createdAt,
        batch.updatedAt,
      );
      const insertItem = this.database.prepare(`
        INSERT INTO flow_batch_items (
          batch_id, item_id, ordinal, attempt, work_item_id, run_id,
          input_hash, resolved_inputs, materialized_at, cancelled_at,
          supersedes_run_id, created_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, NULL, ?)
      `);
      for (const item of draft.items) {
        const resolvedInputs = {
          ...draft.globalInputs,
          ...item.inputs,
        };
        insertItem.run(
          batch.batchId,
          item.itemId,
          item.ordinal,
          createId("wi"),
          createId("run"),
          hashJson({
            flowId: batch.flowId,
            definitionRevision: batch.definitionRevision,
            resolvedInputs,
          }),
          JSON.stringify(resolvedInputs),
          now,
        );
      }
      this.database.prepare(`
        UPDATE flow_invocation_drafts
        SET status = 'confirmed', updated_at = ? WHERE draft_id = ?
      `).run(now, draft.draftId);
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
    return batch;
  }

  getBatch(batchId: string): FlowBatchRun | undefined {
    const row = this.database.prepare(
      "SELECT * FROM flow_batch_runs WHERE batch_id = ?",
    ).get(batchId) as Row | undefined;
    return row ? toBatch(row) : undefined;
  }

  listBatchesForSession(sessionId: string): FlowBatchRun[] {
    return (this.database.prepare(`
      SELECT * FROM flow_batch_runs
      WHERE session_id = ? ORDER BY created_at DESC, batch_id DESC
    `).all(sessionId) as Row[]).map(toBatch);
  }

  listBatches(): FlowBatchRun[] {
    return (this.database.prepare(`
      SELECT * FROM flow_batch_runs ORDER BY created_at ASC, batch_id ASC
    `).all() as Row[]).map(toBatch);
  }

  listBatchItems(batchId: string): FlowBatchItemRun[] {
    return (this.database.prepare(`
      SELECT * FROM flow_batch_items
      WHERE batch_id = ? ORDER BY ordinal ASC, attempt ASC
    `).all(batchId) as Row[]).map(toBatchItem);
  }

  markItemMaterialized(batchId: string, itemId: string, attempt: number): void {
    this.database.prepare(`
      UPDATE flow_batch_items SET materialized_at = ?
      WHERE batch_id = ? AND item_id = ? AND attempt = ?
        AND materialized_at IS NULL
    `).run(new Date().toISOString(), batchId, itemId, attempt);
  }

  markItemCancelled(batchId: string, itemId: string, attempt: number): void {
    this.database.prepare(`
      UPDATE flow_batch_items SET cancelled_at = ?
      WHERE batch_id = ? AND item_id = ? AND attempt = ?
        AND cancelled_at IS NULL
    `).run(new Date().toISOString(), batchId, itemId, attempt);
  }

  reserveRetry(input: ReserveFlowBatchRetryInput): FlowBatchItemRun[] {
    const replay = this.database.prepare(`
      SELECT run_ids FROM flow_batch_retry_keys
      WHERE batch_id = ? AND idempotency_key = ?
    `).get(input.batchId, input.idempotencyKey) as { run_ids?: unknown } | undefined;
    if (replay) {
      return parseJson<string[]>(replay.run_ids).flatMap((runId) => {
        const row = this.database.prepare(
          "SELECT * FROM flow_batch_items WHERE run_id = ?",
        ).get(runId) as Row | undefined;
        return row ? [toBatchItem(row)] : [];
      });
    }
    if (!this.getBatch(input.batchId)) {
      throw new FlowBatchStoreError("batch_not_found");
    }
    const uniqueItemIds = [...new Set(input.itemIds)];
    if (uniqueItemIds.length === 0) {
      throw new FlowBatchStoreError("batch_retry_empty");
    }
    const now = new Date().toISOString();
    const reserved: FlowBatchItemRun[] = [];
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      for (const itemId of uniqueItemIds) {
        const sourceRow = this.database.prepare(`
          SELECT * FROM flow_batch_items
          WHERE batch_id = ? AND item_id = ?
          ORDER BY attempt DESC LIMIT 1
        `).get(input.batchId, itemId) as Row | undefined;
        if (!sourceRow) continue;
        const source = toBatchItem(sourceRow);
        const next: FlowBatchItemRun = {
          ...source,
          attempt: source.attempt + 1,
          workItemId: createId("wi"),
          runId: createId("run"),
          materializedAt: null,
          cancelledAt: null,
          supersedesRunId: source.runId,
          createdAt: now,
        };
        this.database.prepare(`
          INSERT INTO flow_batch_items (
            batch_id, item_id, ordinal, attempt, work_item_id, run_id,
            input_hash, resolved_inputs, materialized_at, cancelled_at,
            supersedes_run_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
        `).run(
          next.batchId,
          next.itemId,
          next.ordinal,
          next.attempt,
          next.workItemId,
          next.runId,
          next.inputHash,
          JSON.stringify(next.resolvedInputs),
          next.supersedesRunId,
          next.createdAt,
        );
        reserved.push(next);
      }
      if (reserved.length === 0) {
        throw new FlowBatchStoreError("batch_retry_empty");
      }
      this.database.prepare(`
        INSERT INTO flow_batch_retry_keys (
          batch_id, idempotency_key, run_ids, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(
        input.batchId,
        input.idempotencyKey,
        JSON.stringify(reserved.map((item) => item.runId)),
        now,
      );
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
    return reserved;
  }

  requestBatchCancellation(batchId: string): FlowBatchRun {
    const current = this.getBatch(batchId);
    if (!current) throw new FlowBatchStoreError("batch_not_found");
    if (current.cancelRequestedAt) return current;
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE flow_batch_runs
      SET cancel_requested_at = ?, updated_at = ? WHERE batch_id = ?
    `).run(now, now, batchId);
    return this.getBatch(batchId)!;
  }

  close(): void {
    this.database.close();
  }

  private requireDraft(draftId: string): FlowBatchDraft {
    const draft = this.getDraft(draftId);
    if (!draft) throw new FlowBatchStoreError("batch_draft_not_found");
    return draft;
  }

  private batchForDraft(draftId: string): FlowBatchRun | undefined {
    const row = this.database.prepare(
      "SELECT * FROM flow_batch_runs WHERE draft_id = ?",
    ).get(draftId) as Row | undefined;
    return row ? toBatch(row) : undefined;
  }
}

function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

function cloneItems(items: FlowBatchDraftItem[]): FlowBatchDraftItem[] {
  return structuredClone(items);
}

function toDraft(row: Row): FlowBatchDraft {
  return {
    schemaVersion: 1,
    draftId: String(row.draft_id),
    sessionId: String(row.session_id),
    sourceRunId: String(row.source_run_id),
    flowId: String(row.flow_id),
    definitionRevision: String(row.definition_revision),
    status: String(row.status) as FlowBatchDraftStatus,
    revision: Number(row.revision),
    globalInputs: parseJson<Record<string, unknown>>(row.global_inputs),
    items: parseJson<FlowBatchDraftItem[]>(row.items),
    sourceRefs: parseJson<string[]>(row.source_refs),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toBatch(row: Row): FlowBatchRun {
  return {
    schemaVersion: 1,
    batchId: String(row.batch_id),
    draftId: String(row.draft_id),
    sessionId: String(row.session_id),
    sourceRunId: String(row.source_run_id),
    flowId: String(row.flow_id),
    definitionRevision: String(row.definition_revision),
    planIrHash: String(row.plan_ir_hash),
    concurrency: Number(row.concurrency),
    failurePolicy: "continue",
    createdBy: String(row.created_by),
    idempotencyKey: String(row.idempotency_key),
    flowSnapshot: parseJson<Record<string, unknown>>(row.flow_snapshot),
    cancelRequestedAt: row.cancel_requested_at == null
      ? null
      : String(row.cancel_requested_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toBatchItem(row: Row): FlowBatchItemRun {
  return {
    batchId: String(row.batch_id),
    itemId: String(row.item_id),
    ordinal: Number(row.ordinal),
    attempt: Number(row.attempt),
    workItemId: String(row.work_item_id),
    runId: String(row.run_id),
    inputHash: String(row.input_hash),
    resolvedInputs: parseJson<Record<string, unknown>>(row.resolved_inputs),
    materializedAt: row.materialized_at == null
      ? null
      : String(row.materialized_at),
    cancelledAt: row.cancelled_at == null ? null : String(row.cancelled_at),
    supersedesRunId: row.supersedes_run_id == null
      ? null
      : String(row.supersedes_run_id),
    createdAt: String(row.created_at),
  };
}
