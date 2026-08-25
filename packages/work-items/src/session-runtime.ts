import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ChannelDeliveryInput,
  ChannelDeliveryRow,
  ChannelDeliveryRunSnapshot,
  ChannelDeliveryStatus,
  ChannelRuntimeRunStatus,
} from "@codebridge/core";
import { projectSessionEvent } from "./session-projector.js";
import type {
  DomainEvent,
  DomainEventActor,
  DomainEventType,
  ExecutionKind,
  PersistedPlanStep,
  MessageAttachmentRecord,
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
  | "stale"
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

export type FlowActorRef = {
  channel: "web" | "feishu" | "telegram";
  id: string;
};

export interface SessionTurnMessage {
  text: string;
  attachmentIds: string[];
  flowId: string | null;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  actorRef?: FlowActorRef;
  flowInvocationSource?: "none" | "request" | "binding";
  executionKind: ExecutionKind;
  plan: {
    planId: string;
    source: "workflow" | "agent_generated";
    workflowId: string;
    definitionRevision: string | null;
    planIrHash: string | null;
    steps: PersistedPlanStep[];
  } | null;
}

export function parseSessionTurnMessage(value: string): SessionTurnMessage {
  const message = JSON.parse(value) as Record<string, unknown>;
  if (message.executionKind !== "agent" && message.executionKind !== "flow") {
    throw new Error("Invalid Session Turn execution kind");
  }
  return message as unknown as SessionTurnMessage;
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
  identifiers?: Record<string, unknown>;
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

export interface ProviderHistoryImportInput {
  sessionId: string;
  providerSessionId: string;
  priorPosition: number;
  priorDigest: string;
  nextDigest: string;
  events: ImportedHistoryEntry[];
  idempotencyKey: string;
}

export interface ProviderHistoryImportResult {
  importedEvents: number;
  importedTurns: number;
  lastEventSequence: number;
}

export interface SessionRunSpec {
  id: string;
  workItemId: string;
  sessionId: string;
  turnId: string;
  mode: WorkItemMode;
  executionKind: ExecutionKind;
  agentId: string | null;
  planId: string | null;
  planIrHash: string | null;
  workflowRevision: string | null;
  providerSessionId?: string | null;
}

export type {
  ChannelDeliveryInput,
  ChannelDeliveryRow,
  ChannelDeliveryStatus,
};

const transactionBrand: unique symbol = Symbol(
  "codebridge.session-transaction",
);

export interface SessionRuntimeTransaction {
  readonly [transactionBrand]: true;
  getRuntime(sessionId: string): SessionRuntime | undefined;
  ensureRuntime(sessionId: string): SessionRuntime;
  getOrCreateWorkItem(
    sessionId: string,
    input: SessionRuntimeWorkItemInput,
  ): string;
  insertMessageAttachment(input: {
    id: string;
    workItemId: string;
    name: string;
    mimeType: string;
    dataBase64: string;
  }): MessageAttachmentRecord;
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
      providerSessionId?: string | null;
    },
  ): Run;
  claimRun(
    runId: string,
    owner: string,
    now: string,
    expiresAt: string,
  ): Run | null;
  renewRunLease(
    runId: string,
    owner: string,
    expiresAt: string,
  ): Run | null;
  listExpiredRunningRuns(now: string, limit: number): Run[];
  listCancellationDeadlineRuns(now: string, limit: number): Run[];
  updateRuntime(
    sessionId: string,
    patch: Partial<
      Pick<
        SessionRuntime,
        "activeRunId" | "queueState" | "queuePauseReason"
      >
    >,
  ): SessionRuntime;
  getProviderHistoryImportCursor(
    sessionId: string,
    providerSessionId: string,
  ): { providerDigest: string; importedPosition: number } | undefined;
  nextSessionQueuePosition(sessionId: string): number;
  insertImportedTurn(input: {
    turnId: string;
    sessionId: string;
    queuePosition: number;
    message: SessionTurnMessage;
    runId: string;
    createdAt: string;
    dispatchedAt: string;
  }): void;
  insertImportedRun(input: {
    runId: string;
    workItemId: string;
    sessionId: string;
    turnId: string;
    createdAt: string;
    updatedAt: string;
  }): void;
  upsertProviderHistoryImport(input: {
    sessionId: string;
    providerSessionId: string;
    providerDigest: string;
    importedPosition: number;
    importedAt: string;
  }): void;
  insertChannelDelivery(input: {
    turnId: string;
    sessionId: string;
    channel: string;
    conversationId: string;
    replyToMessageId: string;
    showThinking: boolean;
    acceptedSequence: number;
    runId: string | null;
    status: "pending" | "dispatched";
  }): void;
  markDeliveryDispatched(turnId: string, runId: string): void;
  markDeliveryRunTerminal(runId: string, now: string): void;
  claimDelivery(
    turnId: string,
    owner: string,
    now: string,
    expiresAt: string,
  ): boolean;
  ackDelivery(
    turnId: string,
    owner: string,
    surfaceMessageId: string,
    surfaceCardId?: string,
  ): boolean;
  completeDelivery(turnId: string, owner: string): boolean;
  listDeliveries(channel: string): ChannelDeliveryRow[];
  setSessionProviderSessionId(
    sessionId: string,
    providerSessionId: string | null,
  ): void;
  getSessionProviderSessionId(sessionId: string): string | null;
  claimProviderSession(input: {
    agentId: string;
    providerSessionId: string;
    runId: string;
    now: string;
    expiresAt: string;
  }): boolean;
  renewProviderSession(input: {
    agentId: string;
    providerSessionId: string;
    runId: string;
    expiresAt: string;
  }): boolean;
  releaseProviderSession(input: {
    agentId: string;
    providerSessionId: string;
    runId: string;
  }): boolean;
  findLiveProviderLease(
    agentId: string,
    providerSessionId: string,
    now: string,
  ): { runId: string } | undefined;
  appendEvent(input: SessionEventInput): DomainEvent;
}

type SqliteRow = Record<string, unknown>;

export function createSqliteSessionRuntimeTransaction(
  database: DatabaseSync,
): { transaction: SessionRuntimeTransaction; deactivate: () => void } {
  let active = true;
  const assertActive = (): void => {
    // active 闭包防「事务结束后继续用」；database.isTransaction 防「根本没进事务就调工厂」
    if (!active || !database.isTransaction) {
      throw new Error("session operation requires an active transaction");
    }
  };
  const transaction: SessionRuntimeTransaction = {
    [transactionBrand]: true,
    getRuntime(sessionId) {
      const row = database
        .prepare("SELECT * FROM session_runtime WHERE session_id = ?")
        .get(sessionId) as SqliteRow | undefined;
      return row ? toSessionRuntime(row) : undefined;
    },

    ensureRuntime(sessionId) {
      assertActive();
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
      assertActive();
      const existing = database
        .prepare("SELECT id FROM work_items WHERE session_id = ?")
        .get(sessionId) as { id?: string } | undefined;
      if (existing?.id) {
        if (input.identifiers !== undefined) {
          database
            .prepare(
              `UPDATE work_items
               SET identifiers = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              JSON.stringify(input.identifiers),
              new Date().toISOString(),
              String(existing.id),
            );
        }
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
          ) VALUES (?, 1, ?, 'created', ?, ?, ?, ?, NULL, NULL, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          workItemId,
          input.title,
          input.mode,
          input.conversationId,
          sessionId,
          input.agentId,
          JSON.stringify(input.workspaceScope),
          JSON.stringify(input.identifiers ?? {}),
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

    insertMessageAttachment(input) {
      assertActive();
      const now = new Date().toISOString();
      const content = Buffer.from(input.dataBase64, "base64");
      const contentHash = `sha256:${createHash("sha256")
        .update(content)
        .digest("hex")}`;
      database
        .prepare(
          `INSERT INTO message_attachments (
            id, schema_version, work_item_id, name, mime_type,
            data_base64, byte_size, content_hash, created_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.workItemId,
          input.name,
          input.mimeType,
          input.dataBase64,
          content.byteLength,
          contentHash,
          now,
        );
      return {
        schemaVersion: 1,
        id: input.id,
        workItemId: input.workItemId,
        name: input.name,
        mimeType: input.mimeType,
        dataBase64: input.dataBase64,
        byteSize: content.byteLength,
        contentHash,
        createdAt: now,
      };
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
      assertActive();
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
      assertActive();
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
      assertActive();
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
      // R3：runs.agent_id 以 WorkItem 为准；input.agentId 有值必须相等，禁止 ?? 选边。
      const workItemAgentId = nullableString(workItem.agent_id);
      const agentId = resolveRunAgentId(input.agentId, workItemAgentId);
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
          const prior = transaction.getRun(String(existingPlan.run_id));
          const terminal = prior && [
            "succeeded",
            "failed",
            "cancelled",
            "interrupted",
          ].includes(prior.status);
          if (!terminal) {
            throw new Error(
              `Plan ${frozenPlan.planId} is bound to another Run`,
            );
          }
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
            status, execution_kind, agent_id, plan_id, plan_ir_hash, workflow_revision,
            terminal_reason, replay_safety, lease_owner, lease_expires_at,
            cancel_requested_at, cancel_deadline_at, provider_session_id,
            created_at, updated_at
          ) VALUES (?, 1, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, NULL, 'safe',
            NULL, NULL, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.workItemId,
          input.sessionId,
          input.turnId,
          input.mode,
          input.executionKind,
          agentId,
          input.planId,
          input.planIrHash,
          input.workflowRevision,
          input.providerSessionId ?? null,
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
      transaction.markDeliveryDispatched(turnId, input.id);

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
          actor_ref: turn.message.actorRef ?? null,
          flow_invocation_source: turn.message.flowInvocationSource ?? "none",
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
          execution_kind: input.executionKind,
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
      assertActive();
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
        executionKind: turn.message.executionKind,
        agentId: workItem.agentId,
        planId: plan?.planId ?? null,
        planIrHash: plan?.planIrHash ?? null,
        workflowRevision: plan?.definitionRevision ?? null,
        providerSessionId: transaction.getSessionProviderSessionId(sessionId),
      });
      transaction.updateRuntime(sessionId, {
        activeRunId: dispatched.run.id,
      });
      return dispatched;
    },

    cancelTurn(turnId, expectedVersion) {
      assertActive();
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
      assertActive();
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
             provider_session_id = ?,
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
          next.providerSessionId ?? null,
          next.updatedAt,
          runId,
        );
      return transaction.getRun(runId)!;
    },

    claimRun(runId, owner, now, expiresAt) {
      assertActive();
      const result = database
        .prepare(
          `UPDATE runs
           SET status = 'running', lease_owner = ?, lease_expires_at = ?,
             updated_at = ?
           WHERE id = ? AND status = 'queued' AND lease_owner IS NULL`,
        )
        .run(owner, expiresAt, now, runId);
      return Number(result.changes) === 1
        ? transaction.getRun(runId) ?? null
        : null;
    },

    renewRunLease(runId, owner, expiresAt) {
      assertActive();
      const result = database
        .prepare(
          `UPDATE runs
           SET lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ?`,
        )
        .run(
          expiresAt,
          new Date().toISOString(),
          runId,
          owner,
        );
      return Number(result.changes) === 1
        ? transaction.getRun(runId) ?? null
        : null;
    },

    listExpiredRunningRuns(now, limit) {
      const boundedLimit = Math.max(
        1,
        Math.min(1_000, Math.floor(limit)),
      );
      const rows = database
        .prepare(
          `SELECT * FROM runs
           WHERE status = 'running'
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at < ?
           ORDER BY lease_expires_at ASC
           LIMIT ?`,
        )
        .all(now, boundedLimit) as SqliteRow[];
      return rows.map(toRun);
    },

    listCancellationDeadlineRuns(now, limit) {
      const boundedLimit = Math.max(
        1,
        Math.min(1_000, Math.floor(limit)),
      );
      const rows = database
        .prepare(
          `SELECT * FROM runs
           WHERE status = 'running'
             AND cancel_deadline_at IS NOT NULL
             AND cancel_deadline_at <= ?
           ORDER BY cancel_deadline_at ASC
           LIMIT ?`,
        )
        .all(now, boundedLimit) as SqliteRow[];
      return rows.map(toRun);
    },

    updateRuntime(sessionId, patch) {
      assertActive();
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

    getProviderHistoryImportCursor(sessionId, providerSessionId) {
      const row = database
        .prepare(
          `SELECT provider_digest, imported_position
           FROM provider_history_imports
           WHERE session_id = ? AND provider_session_id = ?`,
        )
        .get(sessionId, providerSessionId) as
          | { provider_digest?: string; imported_position?: number }
          | undefined;
      return row
        ? {
            providerDigest: String(row.provider_digest),
            importedPosition: Number(row.imported_position),
          }
        : undefined;
    },

    nextSessionQueuePosition(sessionId) {
      const row = database
        .prepare(
          `SELECT COALESCE(MAX(queue_position), 0) + 1 AS next_position
           FROM session_turns WHERE session_id = ?`,
        )
        .get(sessionId) as { next_position?: number } | undefined;
      return Number(row?.next_position ?? 1);
    },

    insertImportedTurn(input) {
      assertActive();
      database
        .prepare(
          `INSERT INTO session_turns (
            turn_id, session_id, queue_position, status, message_json,
            version, dispatched_run_id, created_at, dispatched_at,
            cancelled_at
          ) VALUES (?, ?, ?, 'dispatched', ?, 2, ?, ?, ?, NULL)`,
        )
        .run(
          input.turnId,
          input.sessionId,
          input.queuePosition,
          JSON.stringify(input.message),
          input.runId,
          input.createdAt,
          input.dispatchedAt,
        );
    },

    insertImportedRun(input) {
      assertActive();
      database
        .prepare(
          `INSERT INTO runs (
            id, schema_version, work_item_id, session_id, turn_id, mode,
            status, execution_kind, agent_id, plan_id, plan_ir_hash, workflow_revision,
            terminal_reason, replay_safety, lease_owner, lease_expires_at,
            cancel_requested_at, cancel_deadline_at, created_at, updated_at
          ) VALUES (?, 1, ?, ?, ?, 'auto', 'running', 'agent', NULL, NULL, NULL,
            NULL, NULL, 'safe', NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          input.runId,
          input.workItemId,
          input.sessionId,
          input.turnId,
          input.createdAt,
          input.updatedAt,
        );
    },

    upsertProviderHistoryImport(input) {
      assertActive();
      database
        .prepare(
          `INSERT INTO provider_history_imports (
            session_id, provider_session_id, provider_digest,
            imported_position, imported_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id, provider_session_id) DO UPDATE SET
            provider_digest = excluded.provider_digest,
            imported_position = excluded.imported_position,
            imported_at = excluded.imported_at`,
        )
        .run(
          input.sessionId,
          input.providerSessionId,
          input.providerDigest,
          input.importedPosition,
          input.importedAt,
        );
    },

    insertChannelDelivery(input) {
      assertActive();
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO channel_turn_delivery (
            turn_id, session_id, channel, conversation_id,
            reply_to_message_id, show_thinking, surface_message_id, claim_owner,
            claim_expires_at, accepted_sequence, run_id, run_terminal_at,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          input.turnId,
          input.sessionId,
          input.channel,
          input.conversationId,
          input.replyToMessageId,
          input.showThinking ? 1 : 0,
          input.acceptedSequence,
          input.runId,
          input.status,
          now,
          now,
        );
    },

    markDeliveryDispatched(turnId, runId) {
      assertActive();
      const now = new Date().toISOString();
      database
        .prepare(
          `UPDATE channel_turn_delivery
           SET run_id = ?, status = 'dispatched', updated_at = ?
           WHERE turn_id = ?`,
        )
        .run(runId, now, turnId);
    },

    markDeliveryRunTerminal(runId, now) {
      assertActive();
      database
        .prepare(
          `UPDATE channel_turn_delivery
           SET run_terminal_at = ?, updated_at = ?
           WHERE run_id = ?`,
        )
        .run(now, now, runId);
    },

    claimDelivery(turnId, owner, now, expiresAt) {
      assertActive();
      const result = database
        .prepare(
          `UPDATE channel_turn_delivery
           SET status = 'delivering', claim_owner = ?, claim_expires_at = ?,
             updated_at = ?
           WHERE turn_id = ?
             AND (
               (status = 'dispatched' AND run_id IS NOT NULL)
               OR (
                 status = 'delivering'
                 AND surface_message_id IS NULL
                 AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
               )
             )`,
        )
        .run(owner, expiresAt, now, turnId, now);
      return Number(result.changes) === 1;
    },

    ackDelivery(turnId, owner, surfaceMessageId, surfaceCardId) {
      assertActive();
      const row = database
        .prepare(
          `SELECT surface_message_id, surface_card_id, claim_owner, status
           FROM channel_turn_delivery WHERE turn_id = ?`,
        )
        .get(turnId) as
          | {
              surface_message_id?: string | null;
              surface_card_id?: string | null;
              claim_owner?: string | null;
              status?: string;
            }
          | undefined;
      if (
        !row
        || row.status !== "delivering"
        || row.claim_owner !== owner
      ) {
        return false;
      }
      if (
        row.surface_message_id !== null
        && row.surface_message_id !== undefined
      ) {
        if (String(row.surface_message_id) !== surfaceMessageId) return false;
        if (
          row.surface_card_id !== null
          && row.surface_card_id !== undefined
        ) {
          return surfaceCardId === undefined
            || String(row.surface_card_id) === surfaceCardId;
        }
        if (surfaceCardId === undefined) return true;
        const now = new Date().toISOString();
        const result = database
          .prepare(
            `UPDATE channel_turn_delivery
             SET surface_card_id = ?, updated_at = ?
             WHERE turn_id = ? AND surface_card_id IS NULL`,
          )
          .run(surfaceCardId, now, turnId);
        return Number(result.changes) === 1;
      }
      const now = new Date().toISOString();
      database
        .prepare(
          `UPDATE channel_turn_delivery
           SET surface_message_id = ?, surface_card_id = ?, updated_at = ?
           WHERE turn_id = ? AND surface_message_id IS NULL`,
        )
        .run(surfaceMessageId, surfaceCardId ?? null, now, turnId);
      return true;
    },

    completeDelivery(turnId, owner) {
      assertActive();
      const row = database
        .prepare(
          `SELECT status, claim_owner
           FROM channel_turn_delivery WHERE turn_id = ?`,
        )
        .get(turnId) as
          | { status?: string; claim_owner?: string | null }
          | undefined;
      if (!row) return false;
      if (row.status === "completed") {
        return row.claim_owner === owner;
      }
      const now = new Date().toISOString();
      const result = database
        .prepare(
          `UPDATE channel_turn_delivery
           SET status = 'completed', updated_at = ?
           WHERE turn_id = ?
             AND status = 'delivering'
             AND claim_owner = ?
             AND surface_message_id IS NOT NULL
             AND run_terminal_at IS NOT NULL`,
        )
        .run(now, turnId, owner);
      return Number(result.changes) === 1;
    },

    listDeliveries(channel) {
      const rows = database
        .prepare(
          `SELECT d.*,
                  r.status AS run_snapshot_status,
                  r.created_at AS run_snapshot_created_at,
                  r.updated_at AS run_snapshot_updated_at,
                  r.lease_expires_at AS run_snapshot_lease_expires_at,
                  r.terminal_reason AS run_snapshot_terminal_reason,
                  sr.active_run_id AS run_snapshot_active_run_id,
                  sr.queue_state AS run_snapshot_queue_state
           FROM channel_turn_delivery d
           LEFT JOIN runs r ON r.id = d.run_id
           LEFT JOIN session_runtime sr ON sr.session_id = d.session_id
           WHERE d.channel = ? AND d.status != 'completed'
           ORDER BY d.accepted_sequence ASC`,
        )
        .all(channel) as SqliteRow[];
      return rows.map(toChannelDeliveryRow);
    },

    setSessionProviderSessionId(sessionId, providerSessionId) {
      assertActive();
      // 运行时行可能尚未创建（消息入口在 submitTurn 之前同步），先 ensure。
      transaction.ensureRuntime(sessionId);
      database
        .prepare(
          "UPDATE session_runtime SET provider_session_id = ?, updated_at = ? WHERE session_id = ?",
        )
        .run(providerSessionId, new Date().toISOString(), sessionId);
    },

    getSessionProviderSessionId(sessionId) {
      const row = database
        .prepare(
          "SELECT provider_session_id FROM session_runtime WHERE session_id = ?",
        )
        .get(sessionId) as { provider_session_id?: string | null } | undefined;
      return row ? nullableString(row.provider_session_id) : null;
    },

    claimProviderSession(input) {
      assertActive();
      const result = database
        .prepare(
          `INSERT INTO provider_session_leases (
            agent_id, provider_session_id, lease_owner, lease_expires_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(agent_id, provider_session_id) DO UPDATE SET
            lease_owner = excluded.lease_owner,
            lease_expires_at = excluded.lease_expires_at
          WHERE provider_session_leases.lease_expires_at < ?
             OR provider_session_leases.lease_owner = excluded.lease_owner`,
        )
        .run(
          input.agentId,
          input.providerSessionId,
          input.runId,
          input.expiresAt,
          input.now,
        );
      return Number(result.changes) === 1;
    },

    renewProviderSession(input) {
      assertActive();
      const result = database
        .prepare(
          `UPDATE provider_session_leases
           SET lease_expires_at = ?
           WHERE agent_id = ? AND provider_session_id = ? AND lease_owner = ?`,
        )
        .run(
          input.expiresAt,
          input.agentId,
          input.providerSessionId,
          input.runId,
        );
      return Number(result.changes) === 1;
    },

    releaseProviderSession(input) {
      assertActive();
      const result = database
        .prepare(
          `DELETE FROM provider_session_leases
           WHERE agent_id = ? AND provider_session_id = ? AND lease_owner = ?`,
        )
        .run(input.agentId, input.providerSessionId, input.runId);
      return Number(result.changes) === 1;
    },

    findLiveProviderLease(agentId, providerSessionId, now) {
      const row = database
        .prepare(
          `SELECT lease_owner FROM provider_session_leases
           WHERE agent_id = ? AND provider_session_id = ? AND lease_expires_at >= ?`,
        )
        .get(agentId, providerSessionId, now) as
          | { lease_owner?: string }
          | undefined;
      return row ? { runId: String(row.lease_owner) } : undefined;
    },

    appendEvent(input) {
      assertActive();
      return appendSessionEventInTransaction(database, input);
    },
  };

  return { transaction, deactivate: () => { active = false; } };
}

export function appendSessionEventInTransaction(
  database: DatabaseSync,
  input: SessionEventInput,
): DomainEvent {
  if (!database.isTransaction) {
    throw new Error("session operation requires an active transaction");
  }
  const workItem = database
    .prepare("SELECT session_id FROM work_items WHERE id = ?")
    .get(input.workItemId) as
      | { session_id?: string | null }
      | undefined;
  if (!workItem) throw new Error(`WorkItem not found: ${input.workItemId}`);
  if (workItem.session_id !== input.sessionId) {
    throw new Error("WorkItem Session does not match event Session");
  }
  const executionKind = resolveRunExecutionKind(database, input.runId ?? null);
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
    executionKind,
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
        event_id, schema_version, sequence, work_item_id, run_id, execution_kind, type,
        occurred_at, actor, target, input_hash, result_ref, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.eventId,
      event.schemaVersion,
      event.sequence,
      event.workItemId,
      event.runId,
      event.executionKind,
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

export function resolveRunExecutionKind(
  database: DatabaseSync,
  runId: string | null,
): ExecutionKind | null {
  if (runId === null) return null;
  const row = database
    .prepare("SELECT execution_kind FROM runs WHERE id = ?")
    .get(runId) as { execution_kind?: unknown } | undefined;
  if (!row) throw new Error(`Run not found: ${runId}`);
  if (row.execution_kind === "agent" || row.execution_kind === "flow") {
    return row.execution_kind;
  }
  throw new Error(`Invalid Run execution kind: ${runId}`);
}

export function importProviderHistory(
  transaction: SessionRuntimeTransaction,
  input: ProviderHistoryImportInput,
): ProviderHistoryImportResult {
  const namespace = `session:history-import:${input.sessionId}`;
  const cached = transaction.getIdempotencyResponse<
    ProviderHistoryImportResult
  >(namespace, input.idempotencyKey);
  if (cached) return cached;

  const cursor = transaction.getProviderHistoryImportCursor(
    input.sessionId,
    input.providerSessionId,
  );
  if (
    cursor
    && (
      cursor.importedPosition !== input.priorPosition
      || cursor.providerDigest !== input.priorDigest
    )
  ) {
    throw new Error("provider_history_cursor_conflict");
  }
  if (!cursor && input.priorPosition !== 0) {
    throw new Error("provider_history_cursor_conflict");
  }

  const workItemId = transaction.getOrCreateWorkItem(input.sessionId, {
    title: "Imported Session",
    mode: "auto",
    conversationId: `conv_${input.sessionId.replace(/^sess_/, "")}`,
    agentId: null,
    workspaceScope: [],
    riskLevel: "read_only",
  });
  let active:
    | { turnId: string; runId: string }
    | undefined;
  let importedTurns = 0;

  const finishActive = () => {
    if (!active) return;
    transaction.updateRun(active.runId, {
      status: "succeeded",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    transaction.appendEvent({
      workItemId,
      sessionId: input.sessionId,
      runId: active.runId,
      type: "RUN_SUCCEEDED",
      actor: "system",
      target: active.runId,
      payload: { imported: true },
    });
    transaction.updateRuntime(input.sessionId, {
      activeRunId: null,
      queueState: "ready",
      queuePauseReason: null,
    });
    active = undefined;
  };

  const startTurn = (
    providerPosition: number,
    message?: string,
  ) => {
    const identity = createHash("sha256")
      .update(`${input.providerSessionId}\0${providerPosition}`)
      .digest("hex")
      .slice(0, 32);
    const turnId = `turn_import_${identity}`;
    const runId = `run_import_${identity}`;
    const now = new Date().toISOString();
    const position = transaction.nextSessionQueuePosition(input.sessionId);
    transaction.insertImportedTurn({
      turnId,
      sessionId: input.sessionId,
      queuePosition: position,
      message: {
        text: message ?? "",
        attachmentIds: [],
        flowId: null,
        executionKind: "agent",
        model: null,
        effort: null,
        permissionMode: null,
        plan: null,
      } satisfies SessionTurnMessage,
      runId,
      createdAt: now,
      dispatchedAt: now,
    });
    transaction.insertImportedRun({
      runId,
      workItemId,
      sessionId: input.sessionId,
      turnId,
      createdAt: now,
      updatedAt: now,
    });
    transaction.updateRuntime(input.sessionId, {
      activeRunId: runId,
      queueState: "ready",
      queuePauseReason: null,
    });
    transaction.appendEvent({
      workItemId,
      sessionId: input.sessionId,
      runId,
      type: "TURN_DISPATCHED",
      actor: "system",
      target: turnId,
      payload: { turn_id: turnId, imported: true },
    });
    if (message !== undefined) {
      transaction.appendEvent({
        workItemId,
        sessionId: input.sessionId,
        runId,
        type: "MESSAGE_RECEIVED",
        actor: "user",
        target: turnId,
        payload: { message, attachment_ids: [], imported: true },
      });
    }
    transaction.appendEvent({
      workItemId,
      sessionId: input.sessionId,
      runId,
      type: "RUN_CREATED",
      actor: "system",
      target: runId,
      payload: { mode: "auto", imported: true },
    });
    active = { turnId, runId };
    importedTurns += 1;
  };

  for (const [offset, entry] of input.events.entries()) {
    const providerPosition = input.priorPosition + offset;
    if (entry.kind === "message") {
      finishActive();
      startTurn(providerPosition, entry.text);
      continue;
    }
    if (!active) startTurn(providerPosition);
    transaction.appendEvent({
      workItemId,
      sessionId: input.sessionId,
      runId: active!.runId,
      type: "AGENT_EVENT",
      actor: "agent",
      target: String(entry.event.type ?? "agent_event"),
      payload: { event: entry.event, imported: true },
    });
  }
  finishActive();

  const importedPosition =
    input.priorPosition + input.events.length;
  transaction.upsertProviderHistoryImport({
    sessionId: input.sessionId,
    providerSessionId: input.providerSessionId,
    providerDigest: input.nextDigest,
    importedPosition,
    importedAt: new Date().toISOString(),
  });
  const result: ProviderHistoryImportResult = {
    importedEvents: input.events.length,
    importedTurns,
    lastEventSequence:
      transaction.getRuntime(input.sessionId)!.lastEventSequence,
  };
  transaction.putIdempotencyResponse(
    namespace,
    input.idempotencyKey,
    result,
  );
  return result;
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
    message: parseSessionTurnMessage(String(row.message_json)),
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
    executionKind: executionKind(row.execution_kind, String(row.id)),
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
    providerSessionId: nullableString(row.provider_session_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function executionKind(value: unknown, runId: string): ExecutionKind {
  if (value === "agent" || value === "flow") return value;
  throw new Error(`Invalid Run execution kind: ${runId}`);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function channelRuntimeRunStatus(value: unknown): ChannelRuntimeRunStatus {
  switch (value) {
    case "queued":
    case "running":
    case "waiting":
    case "succeeded":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      throw new Error(`invalid channel Runtime Run status: ${String(value)}`);
  }
}

function channelSessionQueueState(value: unknown): "ready" | "paused" {
  if (value === "ready" || value === "paused") return value;
  throw new Error(`invalid channel Session queue state: ${String(value)}`);
}

function toChannelDeliveryRunSnapshot(
  row: SqliteRow,
): ChannelDeliveryRunSnapshot | null {
  if (row.run_snapshot_status === null || row.run_snapshot_status === undefined) {
    return null;
  }
  return {
    status: channelRuntimeRunStatus(row.run_snapshot_status),
    createdAt: String(row.run_snapshot_created_at),
    updatedAt: String(row.run_snapshot_updated_at),
    leaseExpiresAt: nullableString(row.run_snapshot_lease_expires_at),
    terminalReason: nullableString(row.run_snapshot_terminal_reason),
    sessionActiveRunId: nullableString(row.run_snapshot_active_run_id),
    sessionQueueState: channelSessionQueueState(row.run_snapshot_queue_state),
  };
}

/** R3：runs.agent_id 以 WorkItem 为准；input.agentId 有值则必须相等。 */
function resolveRunAgentId(
  requested: string | null | undefined,
  workItemAgentId: string | null,
): string | null {
  const normalized = requested ?? null;
  if (
    normalized !== null
    && workItemAgentId !== null
    && normalized !== workItemAgentId
  ) {
    throw new Error(
      `Run agent mismatch: requested ${normalized} but WorkItem agent is ${workItemAgentId}`,
    );
  }
  return workItemAgentId ?? normalized;
}

function toChannelDeliveryRow(row: SqliteRow): ChannelDeliveryRow {
  return {
    turnId: String(row.turn_id),
    sessionId: String(row.session_id),
    channel: String(row.channel),
    conversationId: String(row.conversation_id),
    replyToMessageId: String(row.reply_to_message_id),
    showThinking: Number(row.show_thinking) === 1,
    surfaceMessageId: nullableString(row.surface_message_id),
    surfaceCardId: nullableString(row.surface_card_id),
    claimOwner: nullableString(row.claim_owner),
    claimExpiresAt: nullableString(row.claim_expires_at),
    acceptedSequence: Number(row.accepted_sequence),
    runId: nullableString(row.run_id),
    runTerminalAt: nullableString(row.run_terminal_at),
    status: String(row.status) as ChannelDeliveryStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    runSnapshot: toChannelDeliveryRunSnapshot(row),
  };
}

function createId(prefix: "wi" | "evt" | "turn" | "run"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
