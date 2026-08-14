import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { projectSessionEvent } from "./session-projector.js";
import type {
  DomainEvent,
  DomainEventActor,
  DomainEventType,
  PersistedPlanStep,
  RiskLevel,
  Run,
  RunStatus,
  WorkItemMode,
} from "./index.js";

export type QueueState = "ready" | "paused";
export type QueuePauseReason =
  | "failed"
  | "cancelled"
  | "interrupted"
  | null;
export type SessionTurnStatus = "queued" | "dispatched" | "cancelled";
export type ReplaySafety =
  | "safe"
  | "side_effect_started"
  | "outcome_unknown";
export type TimelineTurnStatus =
  | "dispatched"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface SessionRuntime {
  sessionId: string;
  activeRunId: string | null;
  queueState: QueueState;
  queuePauseReason: QueuePauseReason;
  lastEventSequence: number;
  version: number;
  updatedAt: string;
}

export interface SessionTurnMessage {
  text: string;
  attachmentIds: string[];
  flowId: string | null;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  plan: {
    planId: string;
    source: "workflow" | "agent_generated";
    workflowId: string;
    definitionRevision: string | null;
    planIrHash: string | null;
    steps: PersistedPlanStep[];
  } | null;
}

export interface SessionTurn {
  turnId: string;
  sessionId: string;
  queuePosition: number;
  status: SessionTurnStatus;
  message: SessionTurnMessage;
  version: number;
  dispatchedRunId: string | null;
  createdAt: string;
  dispatchedAt: string | null;
  cancelledAt: string | null;
}

export interface SessionTimelineSegment {
  segmentId: string;
  blockId: string;
  segmentIndex: number;
  content: string;
  byteLength: number;
  sealed: boolean;
}

export interface SessionTimelineBlock {
  blockId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  blockIndex: number;
  kind: string;
  status: string;
  metadata: Record<string, unknown>;
  segments: SessionTimelineSegment[];
  nextSegmentCursor: number | null;
}

export interface RunAttempt {
  attemptId: string;
  runId: string;
  attemptNumber: number;
  startedAt: string;
  endedAt: string | null;
  providerError: string | null;
  sideEffectBoundary: ReplaySafety;
}

export type ImportedHistoryEntry =
  | { kind: "message"; text: string }
  | { kind: "agent_event"; event: Record<string, unknown> };

export interface SessionTimelineTurn {
  sessionId: string;
  timelineIndex: number;
  turnId: string;
  runId: string;
  startedSequence: number;
  endedSequence: number | null;
  status: TimelineTurnStatus;
  blocks: SessionTimelineBlock[];
}

export interface SessionRuntimeWorkItemInput {
  title: string;
  mode: WorkItemMode;
  conversationId: string;
  agentId: string | null;
  workspaceScope: string[];
  riskLevel: RiskLevel;
}

export interface SessionEventInput {
  workItemId: string;
  sessionId: string;
  runId?: string | null;
  type: DomainEventType;
  actor: DomainEventActor;
  target?: string | null;
  inputHash?: string | null;
  resultRef?: string | null;
  payload?: Record<string, unknown>;
}

export interface SessionRunSpec {
  id: string;
  workItemId: string;
  sessionId: string;
  turnId: string;
  mode: WorkItemMode;
  agentId: string | null;
  planId: string | null;
  planIrHash: string | null;
  workflowRevision: string | null;
}

export interface SessionRuntimeTransaction {
  getRuntime(sessionId: string): SessionRuntime | undefined;
  ensureRuntime(sessionId: string): SessionRuntime;
  getOrCreateWorkItem(
    sessionId: string,
    input: SessionRuntimeWorkItemInput,
  ): string;
  getIdempotencyResponse<T>(namespace: string, key: string): T | undefined;
  putIdempotencyResponse(
    namespace: string,
    key: string,
    response: unknown,
  ): void;
  countQueuedTurns(sessionId: string): number;
  insertTurn(
    sessionId: string,
    message: SessionTurnMessage,
  ): SessionTurn;
  getTurn(turnId: string): SessionTurn | undefined;
  nextQueuedTurn(sessionId: string): SessionTurn | undefined;
  getRun(runId: string): Run | undefined;
  getWorkItemForSession(sessionId: string): {
    id: string;
    mode: WorkItemMode;
    agentId: string | null;
  } | undefined;
  dispatchTurn(
    turnId: string,
    run: SessionRunSpec,
  ): { turn: SessionTurn; run: Run };
  dispatchNextTurn(
    sessionId: string,
  ): { turn: SessionTurn; run: Run } | null;
  cancelTurn(
    turnId: string,
    expectedVersion: number,
  ): SessionTurn | undefined;
  updateRun(
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
  ): Run;
  updateRuntime(
    sessionId: string,
    patch: Partial<
      Pick<
        SessionRuntime,
        "activeRunId" | "queueState" | "queuePauseReason"
      >
    >,
  ): SessionRuntime;
  appendEvent(input: SessionEventInput): DomainEvent;
}

type SqliteRow = Record<string, unknown>;

export function createSqliteSessionRuntimeTransaction(
  database: DatabaseSync,
): SessionRuntimeTransaction {
  const transaction: SessionRuntimeTransaction = {
    getRuntime(sessionId) {
      const row = database
        .prepare("SELECT * FROM session_runtime WHERE session_id = ?")
        .get(sessionId) as SqliteRow | undefined;
      return row ? toSessionRuntime(row) : undefined;
    },

    ensureRuntime(sessionId) {
      const existing = transaction.getRuntime(sessionId);
      if (existing) return existing;
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO session_runtime (
            session_id, active_run_id, queue_state, queue_pause_reason,
            last_event_sequence, version, updated_at
          ) VALUES (?, NULL, 'ready', NULL, 0, 1, ?)`,
        )
        .run(sessionId, now);
      return transaction.getRuntime(sessionId)!;
    },

    getOrCreateWorkItem(sessionId, input) {
      const existing = database
        .prepare("SELECT id FROM work_items WHERE session_id = ?")
        .get(sessionId) as { id?: string } | undefined;
      if (existing?.id) {
        transaction.ensureRuntime(sessionId);
        return String(existing.id);
      }
      const workItemId = createId("wi");
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO work_items (
            id, schema_version, title, status, mode, conversation_id,
            session_id, agent_id, workflow_id, workflow_revision,
            workspace_scope, identifiers, context_revision, risk_level,
            created_at, updated_at
          ) VALUES (?, 1, ?, 'created', ?, ?, ?, ?, NULL, NULL, ?, '{}', 1, ?, ?, ?)`,
        )
        .run(
          workItemId,
          input.title,
          input.mode,
          input.conversationId,
          sessionId,
          input.agentId,
          JSON.stringify(input.workspaceScope),
          input.riskLevel,
          now,
          now,
        );
      transaction.ensureRuntime(sessionId);
      transaction.appendEvent({
        workItemId,
        sessionId,
        type: "WORK_ITEM_CREATED",
        actor: "system",
      });
      return workItemId;
    },

    getIdempotencyResponse<T>(namespace: string, key: string) {
      const row = database
        .prepare(
          `SELECT response FROM idempotency_responses
           WHERE namespace = ? AND idempotency_key = ?`,
        )
        .get(namespace, key) as { response?: string } | undefined;
      return row?.response
        ? JSON.parse(row.response) as T
        : undefined;
    },

    putIdempotencyResponse(namespace, key, response) {
      database
        .prepare(
          `INSERT OR IGNORE INTO idempotency_responses (
            namespace, idempotency_key, response, created_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          namespace,
          key,
          JSON.stringify(response),
          new Date().toISOString(),
        );
    },

    countQueuedTurns(sessionId) {
      const row = database
        .prepare(
          `SELECT COUNT(*) AS count FROM session_turns
           WHERE session_id = ? AND status = 'queued'`,
        )
        .get(sessionId) as { count?: number } | undefined;
      return Number(row?.count ?? 0);
    },

    insertTurn(sessionId, message) {
      transaction.ensureRuntime(sessionId);
      const position = database
        .prepare(
          `SELECT COALESCE(MAX(queue_position), 0) + 1 AS next_position
           FROM session_turns WHERE session_id = ?`,
        )
        .get(sessionId) as { next_position?: number } | undefined;
      const now = new Date().toISOString();
      const turnId = createId("turn");
      database
        .prepare(
          `INSERT INTO session_turns (
            turn_id, session_id, queue_position, status, message_json,
            version, dispatched_run_id, created_at, dispatched_at,
            cancelled_at
          ) VALUES (?, ?, ?, 'queued', ?, 1, NULL, ?, NULL, NULL)`,
        )
        .run(
          turnId,
          sessionId,
          Number(position?.next_position ?? 1),
          JSON.stringify(message),
          now,
        );
      return transaction.getTurn(turnId)!;
    },

    getTurn(turnId) {
      const row = database
        .prepare("SELECT * FROM session_turns WHERE turn_id = ?")
        .get(turnId) as SqliteRow | undefined;
      return row ? toSessionTurn(row) : undefined;
    },

    nextQueuedTurn(sessionId) {
      const row = database
        .prepare(
          `SELECT * FROM session_turns
           WHERE session_id = ? AND status = 'queued'
           ORDER BY queue_position ASC
           LIMIT 1`,
        )
        .get(sessionId) as SqliteRow | undefined;
      return row ? toSessionTurn(row) : undefined;
    },

    getRun(runId) {
      const row = database
        .prepare("SELECT * FROM runs WHERE id = ?")
        .get(runId) as SqliteRow | undefined;
      return row ? toRun(row) : undefined;
    },

    getWorkItemForSession(sessionId) {
      const row = database
        .prepare(
          `SELECT id, mode, agent_id FROM work_items
           WHERE session_id = ?`,
        )
        .get(sessionId) as SqliteRow | undefined;
      return row
        ? {
            id: String(row.id),
            mode: String(row.mode) as WorkItemMode,
            agentId: nullableString(row.agent_id),
          }
        : undefined;
    },

    dispatchTurn(turnId, input) {
      const turn = transaction.getTurn(turnId);
      if (!turn) throw new Error(`Turn not found: ${turnId}`);
      if (turn.status !== "queued") {
        throw new Error(`Turn is not queued: ${turnId}`);
      }
      if (turn.sessionId !== input.sessionId) {
        throw new Error("Turn Session does not match Run Session");
      }
      const workItem = database
        .prepare(
          `SELECT agent_id, session_id FROM work_items WHERE id = ?`,
        )
        .get(input.workItemId) as SqliteRow | undefined;
      if (!workItem) {
        throw new Error(`WorkItem not found: ${input.workItemId}`);
      }
      if (String(workItem.session_id) !== input.sessionId) {
        throw new Error("WorkItem Session does not match Run Session");
      }

      const now = new Date().toISOString();
      const frozenPlan = turn.message.plan;
      if (frozenPlan) {
        if (input.planId !== frozenPlan.planId) {
          throw new Error("Turn Plan does not match Run Plan");
        }
        const existingPlan = database
          .prepare("SELECT run_id FROM plans WHERE plan_id = ?")
          .get(frozenPlan.planId) as { run_id?: string | null } | undefined;
        if (
          existingPlan?.run_id
          && existingPlan.run_id !== input.id
        ) {
          throw new Error(
            `Plan ${frozenPlan.planId} is bound to another Run`,
          );
        }
        database
          .prepare(
            `INSERT INTO plans (
              plan_id, schema_version, source, workflow_id,
              definition_revision, plan_ir_hash, session_id, run_id, steps,
              created_at
            ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
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
            frozenPlan.planId,
            frozenPlan.source,
            frozenPlan.workflowId,
            frozenPlan.definitionRevision,
            frozenPlan.planIrHash,
            input.sessionId,
            input.id,
            JSON.stringify(frozenPlan.steps),
            now,
          );
      } else if (input.planId) {
        const existingPlan = database
          .prepare("SELECT plan_id FROM plans WHERE plan_id = ?")
          .get(input.planId);
        if (!existingPlan) throw new Error(`Plan not found: ${input.planId}`);
      }
      database
        .prepare(
          `INSERT INTO runs (
            id, schema_version, work_item_id, session_id, turn_id, mode,
            status, agent_id, plan_id, plan_ir_hash, workflow_revision,
            terminal_reason, replay_safety, lease_owner, lease_expires_at,
            cancel_requested_at, cancel_deadline_at, created_at, updated_at
          ) VALUES (?, 1, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, NULL, 'safe',
            NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          input.id,
          input.workItemId,
          input.sessionId,
          input.turnId,
          input.mode,
          input.agentId ?? (
            workItem.agent_id === null ? null : String(workItem.agent_id)
          ),
          input.planId,
          input.planIrHash,
          input.workflowRevision,
          now,
          now,
        );
      const result = database
        .prepare(
          `UPDATE session_turns
           SET status = 'dispatched', version = version + 1,
             dispatched_run_id = ?, dispatched_at = ?
           WHERE turn_id = ? AND status = 'queued'`,
        )
        .run(input.id, now, turnId);
      if (Number(result.changes) !== 1) {
        throw new Error(`Turn is not queued: ${turnId}`);
      }

      transaction.appendEvent({
        workItemId: input.workItemId,
        sessionId: input.sessionId,
        runId: input.id,
        type: "TURN_DISPATCHED",
        actor: "system",
        target: turnId,
        payload: { turn_id: turnId },
      });
      transaction.appendEvent({
        workItemId: input.workItemId,
        sessionId: input.sessionId,
        runId: input.id,
        type: "MESSAGE_RECEIVED",
        actor: "user",
        target: turnId,
        payload: {
          message: turn.message.text,
          attachment_ids: turn.message.attachmentIds,
        },
      });
      transaction.appendEvent({
        workItemId: input.workItemId,
        sessionId: input.sessionId,
        runId: input.id,
        type: "RUN_CREATED",
        actor: "system",
        target: input.id,
        payload: {
          mode: input.mode,
          agent_id: input.agentId,
          plan_id: input.planId,
          workflow_revision: input.workflowRevision,
        },
      });
      if (input.planId) {
        const plan = database
          .prepare("SELECT * FROM plans WHERE plan_id = ?")
          .get(input.planId) as SqliteRow | undefined;
        if (!plan) throw new Error(`Plan not found: ${input.planId}`);
        transaction.appendEvent({
          workItemId: input.workItemId,
          sessionId: input.sessionId,
          runId: input.id,
          type: "PLAN_VALIDATED",
          actor: "system",
          target: input.planId,
          payload: {
            workflow_id: plan.workflow_id,
            definition_revision: plan.definition_revision,
            source: plan.source,
            step_count: (
              JSON.parse(String(plan.steps)) as unknown[]
            ).length,
          },
        });
      }
      return {
        turn: transaction.getTurn(turnId)!,
        run: toRun(
          database
            .prepare("SELECT * FROM runs WHERE id = ?")
            .get(input.id) as SqliteRow,
        ),
      };
    },

    dispatchNextTurn(sessionId) {
      const turn = transaction.nextQueuedTurn(sessionId);
      if (!turn) return null;
      const workItem = transaction.getWorkItemForSession(sessionId);
      if (!workItem) {
        throw new Error(`Session WorkItem not found: ${sessionId}`);
      }
      const plan = turn.message.plan;
      const dispatched = transaction.dispatchTurn(turn.turnId, {
        id: createId("run"),
        workItemId: workItem.id,
        sessionId,
        turnId: turn.turnId,
        mode: workItem.mode,
        agentId: workItem.agentId,
        planId: plan?.planId ?? null,
        planIrHash: plan?.planIrHash ?? null,
        workflowRevision: plan?.definitionRevision ?? null,
      });
      transaction.updateRuntime(sessionId, {
        activeRunId: dispatched.run.id,
      });
      return dispatched;
    },

    cancelTurn(turnId, expectedVersion) {
      const now = new Date().toISOString();
      const result = database
        .prepare(
          `UPDATE session_turns
           SET status = 'cancelled', version = version + 1,
             cancelled_at = ?
           WHERE turn_id = ? AND status = 'queued' AND version = ?`,
        )
        .run(now, turnId, expectedVersion);
      return Number(result.changes) === 1
        ? transaction.getTurn(turnId)
        : undefined;
    },

    updateRun(runId, patch) {
      const current = transaction.getRun(runId);
      if (!current) throw new Error(`Run not found: ${runId}`);
      const next = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      database
        .prepare(
          `UPDATE runs
           SET status = ?, terminal_reason = ?, replay_safety = ?,
             lease_owner = ?, lease_expires_at = ?,
             cancel_requested_at = ?, cancel_deadline_at = ?,
             updated_at = ?
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
      return transaction.getRun(runId)!;
    },

    updateRuntime(sessionId, patch) {
      const current = transaction.ensureRuntime(sessionId);
      const next = {
        activeRunId: patch.activeRunId === undefined
          ? current.activeRunId
          : patch.activeRunId,
        queueState: patch.queueState ?? current.queueState,
        queuePauseReason: patch.queuePauseReason === undefined
          ? current.queuePauseReason
          : patch.queuePauseReason,
      };
      database
        .prepare(
          `UPDATE session_runtime
           SET active_run_id = ?, queue_state = ?, queue_pause_reason = ?,
             version = version + 1, updated_at = ?
           WHERE session_id = ?`,
        )
        .run(
          next.activeRunId,
          next.queueState,
          next.queuePauseReason,
          new Date().toISOString(),
          sessionId,
        );
      return transaction.getRuntime(sessionId)!;
    },

    appendEvent(input) {
      return appendSessionEventInTransaction(database, input);
    },
  };

  return transaction;
}

export function appendSessionEventInTransaction(
  database: DatabaseSync,
  input: SessionEventInput,
): DomainEvent {
  const workItem = database
    .prepare("SELECT session_id FROM work_items WHERE id = ?")
    .get(input.workItemId) as
      | { session_id?: string | null }
      | undefined;
  if (!workItem) throw new Error(`WorkItem not found: ${input.workItemId}`);
  if (workItem.session_id !== input.sessionId) {
    throw new Error("WorkItem Session does not match event Session");
  }
  if (input.runId && isExecutionEvent(input.type)) {
    const run = database
      .prepare("SELECT status FROM runs WHERE id = ?")
      .get(input.runId) as { status?: string } | undefined;
    if (!run) throw new Error(`Run not found: ${input.runId}`);
    if (
      run.status === "succeeded"
      || run.status === "failed"
      || run.status === "cancelled"
      || run.status === "interrupted"
    ) {
      throw new Error("terminal Run cannot accept execution events");
    }
  }
  const sequenceRow = database
    .prepare(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM domain_events
       WHERE work_item_id = ?`,
    )
    .get(input.workItemId) as
      | { next_sequence?: number }
      | undefined;
  const event: DomainEvent = {
    schemaVersion: 1,
    eventId: createId("evt"),
    sequence: Number(sequenceRow?.next_sequence ?? 1),
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
  database
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
  database
    .prepare(
      `UPDATE session_runtime
       SET last_event_sequence = ?, updated_at = ?
       WHERE session_id = ?`,
    )
    .run(event.sequence, event.occurredAt, input.sessionId);
  const workItemStatus = statusForEvent(event.type);
  if (workItemStatus) {
    database
      .prepare(
        "UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(workItemStatus, event.occurredAt, event.workItemId);
  }
  projectSessionEvent(database, input.sessionId, event);
  return event;
}

function statusForEvent(
  eventType: DomainEventType,
): string | undefined {
  switch (eventType) {
    case "PLAN_PROPOSED":
      return "planned";
    case "APPROVAL_REQUESTED":
      return "awaiting_approval";
    case "RUN_CANCELLED":
      return "cancelled";
    case "STEP_STARTED":
      return "executing";
    case "VERIFICATION_COMPLETED":
      return "verifying";
    case "STEP_FAILED":
      return "failed";
    case "WORK_ITEM_COMPLETED":
      return "completed";
    default:
      return undefined;
  }
}

function isExecutionEvent(eventType: DomainEventType): boolean {
  return eventType === "AGENT_EVENT"
    || eventType === "APPROVAL_REQUESTED"
    || eventType === "STEP_STARTED"
    || eventType === "STEP_SUCCEEDED"
    || eventType === "STEP_SKIPPED"
    || eventType === "STEP_RETRYING"
    || eventType === "STEP_FAILED";
}

function toSessionRuntime(row: SqliteRow): SessionRuntime {
  return {
    sessionId: String(row.session_id),
    activeRunId: nullableString(row.active_run_id),
    queueState: String(row.queue_state) as QueueState,
    queuePauseReason: nullableString(
      row.queue_pause_reason,
    ) as QueuePauseReason,
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
    dispatchedRunId: nullableString(row.dispatched_run_id),
    createdAt: String(row.created_at),
    dispatchedAt: nullableString(row.dispatched_at),
    cancelledAt: nullableString(row.cancelled_at),
  };
}

function toRun(row: SqliteRow): Run {
  return {
    schemaVersion: Number(row.schema_version) as 1,
    id: String(row.id),
    workItemId: String(row.work_item_id),
    sessionId: nullableString(row.session_id),
    turnId: nullableString(row.turn_id),
    mode: String(row.mode) as WorkItemMode,
    status: String(row.status) as Run["status"],
    agentId: nullableString(row.agent_id),
    planId: nullableString(row.plan_id),
    planIrHash: nullableString(row.plan_ir_hash),
    workflowRevision: nullableString(row.workflow_revision),
    terminalReason: nullableString(row.terminal_reason),
    replaySafety: String(row.replay_safety) as ReplaySafety,
    leaseOwner: nullableString(row.lease_owner),
    leaseExpiresAt: nullableString(row.lease_expires_at),
    cancelRequestedAt: nullableString(row.cancel_requested_at),
    cancelDeadlineAt: nullableString(row.cancel_deadline_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function createId(prefix: "wi" | "evt" | "turn" | "run"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
