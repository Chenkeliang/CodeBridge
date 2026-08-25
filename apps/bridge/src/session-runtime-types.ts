import type { AgentSession } from "@codebridge/session-catalog";
import type { SessionEventWire } from "@codebridge/core/session-event-wire";
import type {
  DomainEvent,
  Run,
  SessionTimelineTurn,
  SessionTurn,
} from "@codebridge/work-items";

export function toApiSessionEvent(event: DomainEvent): SessionEventWire {
  return {
    schema_version: event.schemaVersion,
    event_id: event.eventId,
    sequence: event.sequence,
    work_item_id: event.workItemId,
    run_id: event.runId,
    type: event.type,
    occurred_at: event.occurredAt,
    actor: event.actor,
    target: event.target,
    input_hash: event.inputHash,
    result_ref: event.resultRef,
    payload: event.payload,
  };
}

export function toApiSession(session: AgentSession) {
  return {
    schema_version: session.schemaVersion,
    session_id: session.id,
    agent_id: session.agentId,
    provider_session_id: session.providerSessionId,
    task_record_id: session.taskRecordId,
    flow_id: session.flowId,
    flow_definition_revision: session.flowDefinitionRevision,
    model: session.model,
    effort: session.effort,
    config_overrides: session.configOverrides,
    permission_mode: session.permissionMode,
    folder_id: session.folderId,
    cwd: session.cwd,
    additional_directories: session.additionalDirectories,
    title: session.title,
    status: session.status,
    pinned_at: session.pinnedAt,
    archived_at: session.archivedAt,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

export function toApiRun(run: Run, sessionId: string) {
  return {
    schema_version: run.schemaVersion,
    run_id: run.id,
    session_id: sessionId,
    work_item_id: run.workItemId,
    turn_id: run.turnId,
    agent_id: run.agentId,
    plan_id: run.planId,
    workflow_revision: run.workflowRevision,
    mode: run.mode,
    status: run.status,
    terminal_reason: run.terminalReason,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
}

export function toApiSessionTurn(turn: SessionTurn) {
  return {
    turn_id: turn.turnId,
    queue_position: turn.queuePosition,
    status: turn.status,
    version: turn.version,
    message: {
      text: turn.message.text,
      attachment_ids: turn.message.attachmentIds,
    },
    created_at: turn.createdAt,
  };
}

export function toApiTimeline(input: {
  turns: SessionTimelineTurn[];
  previousCursor: number | null;
  truncatedBlockIds: string[];
}) {
  return {
    turns: input.turns.map((turn) => ({
      timeline_index: turn.timelineIndex,
      turn_id: turn.turnId,
      run_id: turn.runId,
      status: turn.status,
      blocks: turn.blocks.map((block) => ({
        block_id: block.blockId,
        block_index: block.blockIndex,
        kind: block.kind,
        status: block.status,
        metadata: block.metadata,
        segments: block.segments.map((segment) => ({
          segment_id: segment.segmentId,
          segment_index: segment.segmentIndex,
          content: segment.content,
          byte_length: segment.byteLength,
          sealed: segment.sealed,
        })),
        next_segment_cursor: block.nextSegmentCursor,
      })),
    })),
    previous_cursor: input.previousCursor,
    truncated_block_ids: input.truncatedBlockIds,
  };
}

export type ApiSession = ReturnType<typeof toApiSession>;
export type ApiRun = ReturnType<typeof toApiRun>;
export type ApiSessionTurn = ReturnType<typeof toApiSessionTurn>;
export type ApiTimeline = ReturnType<typeof toApiTimeline>;
