import type { SessionEvent, TimelineBlockView, TimelineTurnView } from "./types";
import { flowSaveIntentProjection, isFlowProjectionEvent } from "@codebridge/core";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function blockId(prefix: string, runId: string, key: string): string {
  return `${prefix}:${runId}:${key}`;
}

function findTurn(turns: TimelineTurnView[], runId: string | null): number {
  if (runId) {
    const index = turns.findIndex((candidate) => candidate.run_id === runId);
    if (index >= 0) return index;
  }
  return turns.length - 1;
}

function upsertBlock(
  turns: TimelineTurnView[],
  runId: string | null,
  block: TimelineBlockView,
): TimelineTurnView[] {
  const turnIndex = findTurn(turns, runId);
  if (turnIndex < 0) return turns;
  const nextTurns = [...turns];
  const turn = nextTurns[turnIndex]!;
  const existing = turn.blocks.findIndex((candidate) => candidate.block_id === block.block_id);
  const blocks = [...turn.blocks];
  if (existing >= 0) {
    const current = blocks[existing]!;
    blocks[existing] = {
      ...block,
      metadata: { ...current.metadata, ...block.metadata },
      segments: block.segments.length ? block.segments : current.segments,
    };
  } else {
    blocks.push(block);
  }
  nextTurns[turnIndex] = { ...turn, blocks };
  return nextTurns;
}

function sealedSegment(segmentId: string, content: string): TimelineBlockView["segments"][number] {
  return { segment_id: segmentId, segment_index: 0, content, byte_length: content.length, sealed: true };
}

function textBlock(
  id: string, kind: TimelineBlockView["kind"], status: string,
  content: string, metadata: Record<string, unknown>,
): TimelineBlockView {
  return { block_id: id, block_index: 0, kind, status, metadata, segments: [sealedSegment(`${id}:0`, content)], next_segment_cursor: null };
}

function stepBlockId(runId: string, stepId: string): string {
  return blockId("flow_step", runId, stepId);
}

export function applyFlowSaveIntentEvent(
  turns: TimelineTurnView[],
  event: SessionEvent,
): TimelineTurnView[] {
  const payload = asRecord(event.payload);
  const projection = flowSaveIntentProjection({
    type: event.type,
    sequence: event.sequence,
    occurredAt: event.occurred_at,
    payload,
  });
  if (!projection) return turns;
  const id = `flow_save:${projection.requestId}`;
  let turnIndex = turns.findIndex((turn) =>
    turn.blocks.some((block) => block.block_id === id)
  );
  if (turnIndex < 0 && event.run_id) {
    turnIndex = turns.findIndex((turn) => turn.run_id === event.run_id);
  }
  if (turnIndex < 0 && typeof payload.request_turn_id === "string") {
    turnIndex = turns.findIndex((turn) => turn.turn_id === payload.request_turn_id);
  }
  if (turnIndex < 0) return turns;
  const current = turns[turnIndex]!.blocks.find((block) => block.block_id === id);
  const currentSequence = current?.metadata.event_sequence;
  if (typeof currentSequence === "number" && currentSequence >= event.sequence) {
    return turns;
  }
  const nextBlockIndex = Math.max(
    -1,
    ...turns[turnIndex]!.blocks.map((candidate) => candidate.block_index),
  ) + 1;
  const block: TimelineBlockView = {
    block_id: id,
    block_index: current?.block_index ?? nextBlockIndex,
    kind: "flow_save_request",
    status: projection.status,
    metadata: {
      ...projection.metadata,
      ...(current ? {} : { started_at: event.occurred_at }),
    },
    segments: [],
    next_segment_cursor: null,
  };
  const nextTurns = [...turns];
  const turn = nextTurns[turnIndex]!;
  const blocks = [...turn.blocks];
  const blockIndex = blocks.findIndex((candidate) => candidate.block_id === id);
  if (blockIndex >= 0) {
    const existing = blocks[blockIndex]!;
    blocks[blockIndex] = {
      ...block,
      metadata: { ...existing.metadata, ...block.metadata },
      segments: block.segments.length ? block.segments : existing.segments,
    };
  } else {
    blocks.push(block);
  }
  nextTurns[turnIndex] = { ...turn, blocks };
  return nextTurns;
}

export function applyFlowEvent(turns: TimelineTurnView[], event: SessionEvent): TimelineTurnView[] {
  const runId = event.run_id;
  const payload = asRecord(event.payload);
  const target = typeof event.target === "string" ? event.target : "";
  if (!isFlowProjectionEvent({
    type: event.type,
    executionKind: event.execution_kind,
    payload,
  })) return turns;

  switch (event.type) {
    case "STEP_STARTED": {
      const block = textBlock(stepBlockId(runId ?? "run", target), "flow_step", "running", "", {
        step_id: target,
        capability_id: payload.capability_id ?? null,
        risk: payload.risk ?? null,
        started_at: event.occurred_at,
      });
      return upsertBlock(turns, runId, block);
    }
    case "STEP_RETRYING": {
      const block = textBlock(stepBlockId(runId ?? "run", target), "flow_step", "retrying", "", {
        step_id: target,
        attempt: payload.attempt ?? null,
        max_attempts: payload.max_attempts ?? null,
        error: payload.error ?? null,
        updated_at: event.occurred_at,
      });
      return upsertBlock(turns, runId, block);
    }
    case "STEP_SUCCEEDED": {
      const block = textBlock(stepBlockId(runId ?? "run", target), "flow_step", "passed", "", {
        step_id: target,
        ended_at: event.occurred_at,
      });
      return upsertBlock(turns, runId, block);
    }
    case "STEP_FAILED": {
      const block = textBlock(stepBlockId(runId ?? "run", target), "flow_step", "failed", String(payload.error ?? ""), {
        step_id: target,
        error: payload.error ?? null,
        ended_at: event.occurred_at,
      });
      return upsertBlock(turns, runId, block);
    }
    case "STEP_SKIPPED": {
      const block = textBlock(stepBlockId(runId ?? "run", target), "flow_step", "skipped", "", { step_id: target });
      return upsertBlock(turns, runId, block);
    }
    case "PARAM_RESOLVED": {
      const field = typeof payload.field === "string" ? payload.field : "?";
      const block = textBlock(blockId("flow_param", runId ?? "session", field), "flow_param", "confirmed", "", {
        field,
        candidate_value: payload.candidate_value ?? null,
        final_value: payload.final_value ?? null,
        resolution: payload.resolution ?? "confirmed",
        source: payload.source ?? "user",
        flow_revision: payload.flow_revision ?? null,
      });
      return upsertBlock(turns, runId, block);
    }
    case "RUN_SNAPSHOT": {
      const outcome = payload.outcome === "failed" ? "failed" : "succeeded";
      const block = textBlock(blockId("flow_run", runId ?? "run", "snapshot"), "flow_run", outcome, "", {
        flow_id: payload.flow_id ?? null,
        flow_revision: payload.flow_revision ?? null,
        outcome,
        resolved_inputs: payload.resolved_inputs ?? [],
        steps: payload.steps ?? [],
        attribution: payload.attribution ?? null,
        occurred_at: event.occurred_at,
      });
      return upsertBlock(turns, runId, block);
    }
    case "VERIFICATION_FAILED": {
      const stepId = typeof payload.step_id === "string" ? payload.step_id : target;
      const block = textBlock(blockId("flow_failure", runId ?? "run", stepId), "flow_failure", "failed", "", {
        step_id: stepId,
        category: payload.category ?? "verification",
        postcondition: payload.postcondition ?? null,
        truncated: payload.truncated === true,
        occurred_at: event.occurred_at,
      });
      return upsertBlock(turns, runId, block);
    }
    default:
      return turns;
  }
}
