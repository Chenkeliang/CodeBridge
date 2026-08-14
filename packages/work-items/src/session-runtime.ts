import type {
  DomainEvent,
  DomainEventActor,
  DomainEventType,
  PersistedPlanStep,
  RiskLevel,
  Run,
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
  dispatchTurn(
    turnId: string,
    run: SessionRunSpec,
  ): { turn: SessionTurn; run: Run };
  cancelTurn(
    turnId: string,
    expectedVersion: number,
  ): SessionTurn | undefined;
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
