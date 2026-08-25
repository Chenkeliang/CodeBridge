import type { DatabaseSync } from "node:sqlite";
import { isFlowProjectionEvent } from "@codebridge/core";
import type { DomainEvent } from "./index.js";

type SqliteRow = Record<string, unknown>;

const MAX_SEGMENT_BYTES = 16 * 1_024;

export function projectSessionEvent(
  database: DatabaseSync,
  sessionId: string,
  event: DomainEvent,
): void {
  const cursor = database
    .prepare(
      `SELECT last_projected_sequence
       FROM session_projection_cursors
       WHERE session_id = ?`,
    )
    .get(sessionId) as
      | { last_projected_sequence?: number }
      | undefined;
  if ((cursor?.last_projected_sequence ?? 0) >= event.sequence) return;
  const projectsFlow = isFlowProjectionEvent({
    type: event.type,
    executionKind: event.executionKind,
    payload: event.payload,
  });

  switch (event.type) {
    case "TURN_DISPATCHED":
      projectTurnDispatched(database, sessionId, event);
      break;
    case "MESSAGE_RECEIVED":
      projectUserMessage(database, sessionId, event);
      break;
    case "RUN_STARTED":
      updateTurnStatus(database, event.runId, "running", event);
      ensureBlock(
        database,
        sessionId,
        event,
        `work:${event.runId}`,
        "work",
        "running",
      );
      break;
    case "AGENT_EVENT":
      projectAgentEvent(database, sessionId, event);
      break;
    case "APPROVAL_REQUESTED":
      updateTurnStatus(database, event.runId, "waiting", event);
      ensureBlock(
        database,
        sessionId,
        event,
        approvalBlockId(event),
        "approval",
        "waiting",
        {
          ...event.payload,
          capability_id: event.target,
        },
      );
      break;
    case "APPROVAL_GRANTED":
      updateApprovalBlock(database, event, "granted");
      break;
    case "APPROVAL_REJECTED":
      updateApprovalBlock(database, event, "rejected");
      break;
    case "RUN_SUCCEEDED":
      closeRun(database, event, "succeeded");
      break;
    case "RUN_FAILED":
      closeRun(database, event, "failed");
      break;
    case "RUN_CANCELLED":
      closeRun(database, event, "cancelled");
      break;
    case "RUN_INTERRUPTED":
      closeRun(database, event, "interrupted");
      break;
    case "TURN_CANCELLED":
      assertQueuedTurnHasNoTimeline(database, String(event.target));
      break;
    case "STEP_STARTED": {
      if (!projectsFlow) break;
      upsertFlowBlock(database, sessionId, event, `flow_step:${event.runId ?? "run"}:${targetOf(event)}`, "flow_step", "running", {
        step_id: targetOf(event),
        capability_id: asRecord(event.payload).capability_id ?? null,
        risk: asRecord(event.payload).risk ?? null,
      });
      break;
    }
    case "STEP_RETRYING": {
      if (!projectsFlow) break;
      upsertFlowBlock(database, sessionId, event, `flow_step:${event.runId ?? "run"}:${targetOf(event)}`, "flow_step", "retrying", {
        step_id: targetOf(event),
        attempt: asRecord(event.payload).attempt ?? null,
        max_attempts: asRecord(event.payload).max_attempts ?? null,
        error: asRecord(event.payload).error ?? null,
      });
      break;
    }
    case "STEP_SUCCEEDED": {
      if (!projectsFlow) break;
      upsertFlowBlock(database, sessionId, event, `flow_step:${event.runId ?? "run"}:${targetOf(event)}`, "flow_step", "passed", {
        step_id: targetOf(event),
        ended_at: event.occurredAt,
      });
      break;
    }
    case "STEP_FAILED": {
      if (!projectsFlow) break;
      upsertFlowBlock(database, sessionId, event, `flow_step:${event.runId ?? "run"}:${targetOf(event)}`, "flow_step", "failed", {
        step_id: targetOf(event),
        error: asRecord(event.payload).error ?? null,
        ended_at: event.occurredAt,
      });
      break;
    }
    case "STEP_SKIPPED": {
      if (!projectsFlow) break;
      upsertFlowBlock(database, sessionId, event, `flow_step:${event.runId ?? "run"}:${targetOf(event)}`, "flow_step", "skipped", {
        step_id: targetOf(event),
      });
      break;
    }
    case "PARAM_RESOLVED": {
      if (!projectsFlow) break;
      const field = typeof asRecord(event.payload).field === "string"
        ? String(asRecord(event.payload).field)
        : targetOf(event) || "?";
      upsertFlowBlock(database, sessionId, event, `flow_param:${event.runId ?? "session"}:${field}`, "flow_param", "confirmed", {
        field,
        candidate_value: asRecord(event.payload).candidate_value ?? null,
        final_value: asRecord(event.payload).final_value ?? null,
        resolution: asRecord(event.payload).resolution ?? "confirmed",
        source: asRecord(event.payload).source ?? "user",
        flow_revision: asRecord(event.payload).flow_revision ?? null,
      });
      break;
    }
    case "RUN_SNAPSHOT": {
      if (!projectsFlow) break;
      const outcome = asRecord(event.payload).outcome === "failed" ? "failed" : "succeeded";
      upsertFlowBlock(database, sessionId, event, `flow_run:${event.runId ?? "run"}:snapshot`, "flow_run", outcome, {
        flow_id: asRecord(event.payload).flow_id ?? null,
        flow_revision: asRecord(event.payload).flow_revision ?? null,
        outcome,
        resolved_inputs: asRecord(event.payload).resolved_inputs ?? [],
        steps: asRecord(event.payload).steps ?? [],
        attribution: asRecord(event.payload).attribution ?? null,
      });
      break;
    }
    case "VERIFICATION_FAILED": {
      if (!projectsFlow) break;
      const stepId = typeof asRecord(event.payload).step_id === "string"
        ? String(asRecord(event.payload).step_id)
        : targetOf(event);
      upsertFlowBlock(database, sessionId, event, `flow_failure:${event.runId ?? "run"}:${stepId}`, "flow_failure", "failed", {
        step_id: stepId,
        category: asRecord(event.payload).category ?? "verification",
        postcondition: asRecord(event.payload).postcondition ?? null,
        truncated: asRecord(event.payload).truncated === true,
      });
      break;
    }
    case "FLOW_BATCH_DRAFTED":
    case "FLOW_BATCH_CONFIRMED":
    case "FLOW_BATCH_UPDATED":
    case "FLOW_BATCH_COMPLETED": {
      if (!projectsFlow) break;
      const payload = asRecord(event.payload);
      const batchId = typeof payload.batch_id === "string"
        ? payload.batch_id
        : event.target ?? "batch";
      upsertFlowBlock(
        database,
        sessionId,
        event,
        `flow_batch:${batchId}`,
        "flow_batch",
        typeof payload.status === "string" ? payload.status : "queued",
        payload,
      );
      break;
    }
    // 已知但有意不进时间线的类型：显式 no-op（cursor 正常前进）。
    case "WORK_ITEM_CREATED":
    case "TURN_QUEUED":
    case "RUN_CREATED":
    case "PLAN_VALIDATED":
    case "RUN_CANCEL_REQUESTED":
    case "BRANCH_SELECTED":
    case "FLOW_PROPOSED":
    case "FLOW_SELECTED":
    case "FLOW_SAVED_AS_CANDIDATE":
    case "PROJECT_CANDIDATE_FOUND":
    case "ARTIFACT_CREATED":
    case "VERIFICATION_COMPLETED":
    case "WORK_ITEM_COMPLETED":
    // 迁移/水合/学习信号事件：绑定前写下的历史事件会经 backfillSessionProjection
    // 走投影，显式 no-op（否则回放命中 default 会打挂迁移）。
    case "SESSION_HISTORY_HYDRATED":
    case "PLAN_PROPOSED":
    case "DISCOVERY_STARTED":
    case "FLOW_RECOMMENDED":
    case "FLOW_REJECTED":
      break;
    default:
      // R2：未知事件不得静默跳过——抛错后 cursor 停在旧 sequence，
      // 修复投影后才能重放（appendEvent 整笔回滚）。
      throw new Error(
        `Unsupported session projection event type: ${event.type}`,
      );
  }

  database
    .prepare(
      `INSERT INTO session_projection_cursors(
        session_id, last_projected_sequence
      ) VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_projected_sequence = excluded.last_projected_sequence`,
    )
    .run(sessionId, event.sequence);
}

function projectTurnDispatched(
  database: DatabaseSync,
  sessionId: string,
  event: DomainEvent,
): void {
  const runId = requireRunId(event);
  const turnId = typeof event.payload.turn_id === "string"
    ? event.payload.turn_id
    : String(event.target);
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(timeline_index), 0) + 1 AS next_index
       FROM session_timeline_turns
       WHERE session_id = ?`,
    )
    .get(sessionId) as { next_index?: number } | undefined;
  database
    .prepare(
      `INSERT INTO session_timeline_turns (
        session_id, timeline_index, turn_id, run_id, started_sequence,
        ended_sequence, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 'dispatched', ?)`,
    )
    .run(
      sessionId,
      Number(row?.next_index ?? 1),
      turnId,
      runId,
      event.sequence,
      event.occurredAt,
    );
}

function projectUserMessage(
  database: DatabaseSync,
  sessionId: string,
  event: DomainEvent,
): void {
  const runId = requireRunId(event);
  const turn = findTimelineTurn(database, runId);
  if (!turn) throw new Error(`Timeline Turn not found for Run: ${runId}`);
  const blockId = `user:${String(turn.turn_id)}`;
  ensureBlock(
    database,
    sessionId,
    event,
    blockId,
    "user_message",
    "completed",
    {
      attachment_ids: Array.isArray(event.payload.attachment_ids)
        ? event.payload.attachment_ids
        : [],
    },
  );
  appendSegment(
    database,
    blockId,
    typeof event.payload.message === "string"
      ? event.payload.message
      : "",
    true,
  );
}

function projectAgentEvent(
  database: DatabaseSync,
  sessionId: string,
  event: DomainEvent,
): void {
  const value = event.payload.event;
  if (!value || typeof value !== "object") return;
  const agentEvent = value as Record<string, unknown>;
  const type = typeof agentEvent.type === "string"
    ? agentEvent.type
    : "";

  if (type === "available_commands_update") {
    projectCommands(database, sessionId, event.sequence, agentEvent);
    return;
  }

  if (type === "text_delta" || type === "thought_delta") {
    const runId = requireRunId(event);
    const phase = agentEvent.phase === "commentary"
      ? "commentary"
      : "final_answer";
    const kind = type === "thought_delta"
      ? "thought"
      : phase === "commentary"
        ? "work"
        : "assistant";
    if (kind !== "thought") {
      completeOpenThoughtBlocks(database, runId, event.occurredAt);
    }
    const turn = findTimelineTurn(database, runId);
    if (!turn) throw new Error(`Timeline Turn not found for Run: ${runId}`);
    const blockId = kind === "thought"
      ? resolveThoughtBlockId(database, runId, event, agentEvent)
      : stringValue(agentEvent.blockId)
        ?? stringValue(agentEvent.messageId)
        ?? `${runId}:${phase}`;
    ensureBlock(
      database,
      sessionId,
      event,
      blockId,
      kind,
      "running",
      { phase },
      kind === "thought"
        ? thoughtInsertIndex(database, String(turn.turn_id))
        : undefined,
    );
    appendSegment(
      database,
      blockId,
      typeof agentEvent.text === "string" ? agentEvent.text : "",
      false,
    );
    return;
  }

  if (
    type === "tool_start"
    || type === "tool_update"
    || type === "tool_end"
  ) {
    const runId = requireRunId(event);
    const toolCallId = stringValue(agentEvent.toolCallId)
      ?? `${runId}:tool:${event.sequence}`;
    const blockId = `tool:${toolCallId}`;
    if (type === "tool_start") {
      completeOpenThoughtBlocks(database, runId, event.occurredAt);
      sealOpenSegmentsForRun(database, runId);
      ensureBlock(
        database,
        sessionId,
        event,
        blockId,
        "tool",
        "running",
        agentEvent,
      );
      return;
    }
    updateToolBlock(database, blockId, agentEvent, type === "tool_end");
    return;
  }

  if (type === "error") {
    const runId = requireRunId(event);
    const message = typeof agentEvent.message === "string"
      ? agentEvent.message
      : "";
    if (!message) return;
    const blockId = `error:${runId}:${event.sequence}`;
    ensureBlock(
      database,
      sessionId,
      event,
      blockId,
      "error",
      "failed",
    );
    appendSegment(database, blockId, message, true);
  }
}

function projectCommands(
  database: DatabaseSync,
  sessionId: string,
  sequence: number,
  event: Record<string, unknown>,
): void {
  const commands = Array.isArray(event.availableCommands)
    ? event.availableCommands
    : [];
  database
    .prepare("DELETE FROM session_commands WHERE session_id = ?")
    .run(sessionId);
  const insert = database.prepare(
    `INSERT INTO session_commands (
      session_id, name, description, input_json, source_sequence
    ) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const value of commands) {
    if (!value || typeof value !== "object") continue;
    const command = value as Record<string, unknown>;
    if (
      typeof command.name !== "string"
      || typeof command.description !== "string"
    ) {
      continue;
    }
    const input = command.input && typeof command.input === "object"
      ? command.input
      : null;
    insert.run(
      sessionId,
      command.name,
      command.description,
      input ? JSON.stringify(input) : null,
      sequence,
    );
  }
}

function updateTurnStatus(
  database: DatabaseSync,
  runId: string | null,
  status: string,
  event: DomainEvent,
): void {
  if (!runId) return;
  database
    .prepare(
      `UPDATE session_timeline_turns
       SET status = ?, updated_at = ?
       WHERE run_id = ?`,
    )
    .run(status, event.occurredAt, runId);
}

function ensureBlock(
  database: DatabaseSync,
  sessionId: string,
  event: DomainEvent,
  blockId: string,
  kind: string,
  status: string,
  metadata: Record<string, unknown> = {},
  insertIndex?: number,
): void {
  const existing = database
    .prepare(
      "SELECT block_id FROM session_timeline_blocks WHERE block_id = ?",
    )
    .get(blockId);
  if (existing) return;
  const runId = requireRunId(event);
  const turn = findTimelineTurn(database, runId);
  if (!turn) throw new Error(`Timeline Turn not found for Run: ${runId}`);
  const turnId = String(turn.turn_id);
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(block_index), -1) + 1 AS next_index
       FROM session_timeline_blocks
       WHERE turn_id = ?`,
    )
    .get(turnId) as
      | { next_index?: number }
      | undefined;
  const appendIndex = Number(row?.next_index ?? 0);
  const blockIndex = insertIndex ?? appendIndex;
  if (blockIndex < appendIndex) shiftBlockIndices(database, turnId, blockIndex);
  database
    .prepare(
      `INSERT INTO session_timeline_blocks (
        block_id, session_id, turn_id, run_id, block_index, kind, status,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      blockId,
      sessionId,
      turnId,
      runId,
      blockIndex,
      kind,
      status,
      JSON.stringify(boundMetadata({
        ...metadata,
        started_at: event.occurredAt,
      })),
    );
}

function resolveThoughtBlockId(
  database: DatabaseSync,
  runId: string,
  event: DomainEvent,
  agentEvent: Record<string, unknown>,
): string {
  const running = database
    .prepare(
      `SELECT block_id FROM session_timeline_blocks
       WHERE run_id = ? AND kind = 'thought' AND status = 'running'
       ORDER BY block_index DESC
       LIMIT 1`,
    )
    .get(runId) as { block_id?: string } | undefined;
  if (running?.block_id) return String(running.block_id);

  const explicit = stringValue(agentEvent.blockId)
    ?? stringValue(agentEvent.messageId);
  if (explicit) {
    const existing = database
      .prepare(
        "SELECT status FROM session_timeline_blocks WHERE block_id = ?",
      )
      .get(explicit) as { status?: string } | undefined;
    if (!existing || existing.status === "running") return explicit;
  }
  return `${runId}:thought:${event.sequence}`;
}

function thoughtInsertIndex(database: DatabaseSync, turnId: string): number {
  const lastThought = database
    .prepare(
      `SELECT MAX(block_index) AS idx FROM session_timeline_blocks
       WHERE turn_id = ? AND kind = 'thought'`,
    )
    .get(turnId) as { idx?: number | null } | undefined;
  if (lastThought?.idx != null) return Number(lastThought.idx) + 1;
  const append = database
    .prepare(
      `SELECT COALESCE(MAX(block_index), -1) + 1 AS next_index
       FROM session_timeline_blocks
       WHERE turn_id = ?`,
    )
    .get(turnId) as { next_index?: number } | undefined;
  return Number(append?.next_index ?? 0);
}

function shiftBlockIndices(
  database: DatabaseSync,
  turnId: string,
  fromIndex: number,
): void {
  const rows = database
    .prepare(
      `SELECT block_id, block_index FROM session_timeline_blocks
       WHERE turn_id = ? AND block_index >= ?
       ORDER BY block_index DESC`,
    )
    .all(turnId, fromIndex) as Array<{ block_id: string; block_index: number }>;
  const update = database.prepare(
    "UPDATE session_timeline_blocks SET block_index = ? WHERE block_id = ?",
  );
  for (const row of rows) {
    update.run(Number(row.block_index) + 1, row.block_id);
  }
}

function completeOpenThoughtBlocks(
  database: DatabaseSync,
  runId: string,
  endedAt: string,
): void {
  const rows = database
    .prepare(
      `SELECT block_id, metadata_json FROM session_timeline_blocks
       WHERE run_id = ? AND kind = 'thought' AND status = 'running'`,
    )
    .all(runId) as Array<{ block_id: string; metadata_json?: string }>;
  const update = database.prepare(
    `UPDATE session_timeline_blocks
     SET status = ?, metadata_json = ?
     WHERE block_id = ?`,
  );
  for (const row of rows) {
    const metadata = JSON.parse(row.metadata_json ?? "{}") as Record<string, unknown>;
    update.run(
      "completed",
      JSON.stringify(boundMetadata({ ...metadata, ended_at: endedAt })),
      row.block_id,
    );
    database
      .prepare(
        `UPDATE session_output_segments
         SET sealed = 1
         WHERE block_id = ? AND sealed = 0`,
      )
      .run(row.block_id);
  }
}

function appendSegment(
  database: DatabaseSync,
  blockId: string,
  text: string,
  sealAfter: boolean,
): void {
  let remaining = text;
  while (remaining) {
    let tail = database
      .prepare(
        `SELECT * FROM session_output_segments
         WHERE block_id = ?
         ORDER BY segment_index DESC
         LIMIT 1`,
      )
      .get(blockId) as SqliteRow | undefined;
    if (!tail || Number(tail.sealed) === 1) {
      const nextIndex = tail ? Number(tail.segment_index) + 1 : 0;
      const segmentId = `${blockId}:${nextIndex}`;
      database
        .prepare(
          `INSERT INTO session_output_segments (
            segment_id, block_id, segment_index, content, byte_length, sealed
          ) VALUES (?, ?, ?, '', 0, 0)`,
        )
        .run(segmentId, blockId, nextIndex);
      tail = database
        .prepare(
          "SELECT * FROM session_output_segments WHERE segment_id = ?",
        )
        .get(segmentId) as SqliteRow;
    }

    const current = String(tail.content);
    const currentBytes = Number(tail.byte_length);
    const capacity = MAX_SEGMENT_BYTES - currentBytes;
    const { head, tail: rest } = splitUtf8(remaining, capacity);
    const nextContent = current + head;
    const nextBytes = Buffer.byteLength(nextContent, "utf8");
    const sealed = rest.length > 0 || nextBytes >= MAX_SEGMENT_BYTES;
    database
      .prepare(
        `UPDATE session_output_segments
         SET content = ?, byte_length = ?, sealed = ?
         WHERE segment_id = ?`,
      )
      .run(nextContent, nextBytes, sealed ? 1 : 0, String(tail.segment_id));
    remaining = rest;
  }

  if (sealAfter) {
    database
      .prepare(
        `UPDATE session_output_segments
         SET sealed = 1
         WHERE block_id = ? AND sealed = 0`,
      )
      .run(blockId);
  }
}

function updateToolBlock(
  database: DatabaseSync,
  blockId: string,
  update: Record<string, unknown>,
  ended: boolean,
): void {
  const row = database
    .prepare(
      `SELECT metadata_json FROM session_timeline_blocks
       WHERE block_id = ?`,
    )
    .get(blockId) as { metadata_json?: string } | undefined;
  if (!row) return;
  const current = JSON.parse(
    row.metadata_json ?? "{}",
  ) as Record<string, unknown>;
  const status = ended
    ? update.status === "failed"
      ? "failed"
      : "completed"
    : "running";
  database
    .prepare(
      `UPDATE session_timeline_blocks
       SET status = ?, metadata_json = ?
       WHERE block_id = ?`,
    )
    .run(
      status,
      JSON.stringify(boundMetadata({ ...current, ...update })),
      blockId,
    );
}

function closeRun(
  database: DatabaseSync,
  event: DomainEvent,
  status: "succeeded" | "failed" | "cancelled" | "interrupted",
): void {
  const runId = requireRunId(event);
  const nextStatus = status === "succeeded" ? "completed" : status;
  database
    .prepare(
      `UPDATE session_timeline_turns
       SET status = ?, ended_sequence = ?, updated_at = ?
       WHERE run_id = ?`,
    )
    .run(status, event.sequence, event.occurredAt, runId);
  const openBlocks = database
    .prepare(
      `SELECT block_id, metadata_json FROM session_timeline_blocks
       WHERE run_id = ? AND status IN ('running', 'waiting')`,
    )
    .all(runId) as Array<{ block_id: string; metadata_json?: string }>;
  const updateBlock = database.prepare(
    `UPDATE session_timeline_blocks
     SET status = ?, metadata_json = ?
     WHERE block_id = ?`,
  );
  for (const block of openBlocks) {
    const metadata = JSON.parse(block.metadata_json ?? "{}") as Record<string, unknown>;
    updateBlock.run(
      nextStatus,
      JSON.stringify(boundMetadata({ ...metadata, ended_at: event.occurredAt })),
      block.block_id,
    );
  }
  sealOpenSegmentsForRun(database, runId);
}

function sealOpenSegmentsForRun(
  database: DatabaseSync,
  runId: string,
): void {
  database
    .prepare(
      `UPDATE session_output_segments
       SET sealed = 1
       WHERE sealed = 0 AND block_id IN (
         SELECT block_id FROM session_timeline_blocks WHERE run_id = ?
       )`,
    )
    .run(runId);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function targetOf(event: DomainEvent): string {
  return typeof event.target === "string" ? event.target : "";
}

function approvalIdOf(event: DomainEvent): string {
  const approvalId = asRecord(event.payload).approval_id;
  if (typeof approvalId !== "string" || !approvalId) {
    throw new Error(`Approval event missing approval_id: ${event.eventId}`);
  }
  return approvalId;
}

function approvalBlockId(event: DomainEvent): string {
  return `approval:${approvalIdOf(event)}`;
}

function updateApprovalBlock(
  database: DatabaseSync,
  event: DomainEvent,
  status: "granted" | "rejected",
): void {
  const preferredBlockId = approvalBlockId(event);
  const legacyBlockId = event.target ? `approval:${event.target}` : null;
  const candidates = legacyBlockId
    ? [preferredBlockId, legacyBlockId]
    : [preferredBlockId];
  let blockId: string | null = null;
  let metadata: Record<string, unknown> = {};
  for (const candidate of candidates) {
    const row = database
      .prepare(
        `SELECT metadata_json FROM session_timeline_blocks
         WHERE block_id = ?`,
      )
      .get(candidate) as { metadata_json?: string } | undefined;
    if (!row) continue;
    blockId = candidate;
    metadata = JSON.parse(row.metadata_json ?? "{}") as Record<string, unknown>;
    break;
  }
  if (!blockId) return;
  database
    .prepare(
      `UPDATE session_timeline_blocks
       SET status = ?, metadata_json = ?
       WHERE block_id = ?`,
    )
    .run(
      status,
      JSON.stringify(boundMetadata({
        ...metadata,
        ...event.payload,
        capability_id: event.target ?? metadata.capability_id ?? null,
        resolved_at: event.occurredAt,
      })),
      blockId,
    );
}

function resolveFlowTurn(
  database: DatabaseSync,
  sessionId: string,
  event: DomainEvent,
): { turnId: string; runId: string } | undefined {
  if (event.runId) {
    const turn = findTimelineTurn(database, event.runId);
    if (!turn) return undefined;
    return { turnId: String(turn.turn_id), runId: event.runId };
  }
  const latest = database
    .prepare(
      `SELECT turn_id, run_id FROM session_timeline_turns
       WHERE session_id = ?
       ORDER BY timeline_index DESC
       LIMIT 1`,
    )
    .get(sessionId) as { turn_id?: string; run_id?: string } | undefined;
  if (!latest?.turn_id || !latest.run_id) return undefined;
  return { turnId: String(latest.turn_id), runId: String(latest.run_id) };
}

function upsertFlowBlock(
  database: DatabaseSync,
  sessionId: string,
  event: DomainEvent,
  blockId: string,
  kind: string,
  status: string,
  metadata: Record<string, unknown>,
): void {
  const turn = resolveFlowTurn(database, sessionId, event);
  if (!turn) return;
  const existing = database
    .prepare(
      `SELECT metadata_json FROM session_timeline_blocks WHERE block_id = ?`,
    )
    .get(blockId) as { metadata_json?: string } | undefined;
  if (existing) {
    const current = JSON.parse(existing.metadata_json ?? "{}") as Record<string, unknown>;
    database
      .prepare(
        `UPDATE session_timeline_blocks
         SET status = ?, metadata_json = ?
         WHERE block_id = ?`,
      )
      .run(
        status,
        JSON.stringify(boundMetadata({ ...current, ...metadata })),
        blockId,
      );
    return;
  }
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(block_index), -1) + 1 AS next_index
       FROM session_timeline_blocks
       WHERE turn_id = ?`,
    )
    .get(turn.turnId) as { next_index?: number } | undefined;
  database
    .prepare(
      `INSERT INTO session_timeline_blocks (
        block_id, session_id, turn_id, run_id, block_index, kind, status,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      blockId,
      sessionId,
      turn.turnId,
      turn.runId,
      Number(row?.next_index ?? 0),
      kind,
      status,
      JSON.stringify(boundMetadata({
        ...metadata,
        started_at: event.occurredAt,
      })),
    );
}

function assertQueuedTurnHasNoTimeline(
  database: DatabaseSync,
  turnId: string,
): void {
  const turn = database
    .prepare("SELECT status FROM session_turns WHERE turn_id = ?")
    .get(turnId) as { status?: string } | undefined;
  if (turn?.status === "dispatched") {
    throw new Error("dispatched Turn cannot be cancelled");
  }
  const timeline = database
    .prepare(
      "SELECT 1 FROM session_timeline_turns WHERE turn_id = ? LIMIT 1",
    )
    .get(turnId);
  if (timeline) throw new Error("queued Turn cannot have a timeline");
}

function findTimelineTurn(
  database: DatabaseSync,
  runId: string,
): SqliteRow | undefined {
  return database
    .prepare(
      "SELECT * FROM session_timeline_turns WHERE run_id = ?",
    )
    .get(runId) as SqliteRow | undefined;
}

function requireRunId(event: DomainEvent): string {
  if (!event.runId) {
    throw new Error(`${event.type} requires a Run`);
  }
  return event.runId;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function splitUtf8(
  value: string,
  maximumBytes: number,
): { head: string; tail: string } {
  if (maximumBytes <= 0) return { head: "", tail: value };
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return { head: value.slice(0, end), tail: value.slice(end) };
}

function boundMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const serialized = JSON.stringify(metadata);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_SEGMENT_BYTES) {
    return metadata;
  }
  return {
    type: metadata.type,
    name: metadata.name,
    status: metadata.status,
    truncated: true,
  };
}
