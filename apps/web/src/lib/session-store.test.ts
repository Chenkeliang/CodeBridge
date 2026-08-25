import { describe, expect, it, vi } from "vitest";
import { SessionViewStore } from "./session-store";
import type { SessionView } from "./session-store";
import type { AgentSession, SessionEvent, SessionSnapshot, SessionRuntimeView, TimelineTurnView } from "./types";

function session(sessionId: string): AgentSession {
  return {
    session_id: sessionId,
    agent_id: "codex",
    provider_session_id: null,
    task_record_id: null,
    flow_id: null,
    flow_definition_revision: null,
    model: null,
    effort: null,
    permission_mode: null,
    cwd: "/workspace",
    additional_directories: [],
    title: sessionId,
    status: "idle",
    pinned_at: null,
    archived_at: null,
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z",
  };
}

function runtime(lastEventSequence: number): SessionRuntimeView {
  return {
    active_run: null,
    queue_state: "ready",
    queue_pause_reason: null,
    queue: { turns: [], total: 0, next_cursor: null },
    version: 1,
    last_event_sequence: lastEventSequence,
  };
}

function snapshot(sessionId: string, lastEventSequence: number): SessionSnapshot {
  const turn: TimelineTurnView = {
    turn_id: `${sessionId}-turn`,
    status: "running",
    timeline_index: 0,
    run_id: `${sessionId}-run`,
    blocks: [],
  };
  return {
    session: session(sessionId),
    runtime: runtime(lastEventSequence),
    timeline: {
      turns: [{
        ...turn,
        blocks: [{
          block_id: `${sessionId}-block`,
          block_index: 0,
          kind: "assistant",
          status: "running",
          metadata: {},
          segments: [{ segment_id: `${sessionId}-segment`, segment_index: 0, content: "", byte_length: 0, sealed: false }],
          next_segment_cursor: 1,
        }],
      }],
      previous_cursor: null,
      truncated_block_ids: [],
    },
    commands: [],
  };
}

function deltaEvent(sessionId: string, sequence: number, text: string, type: "text_delta" | "thought_delta" = "text_delta"): SessionEvent {
  return {
    schema_version: 1,
    event_id: `${sessionId}-event-${sequence}`,
    sequence,
    work_item_id: `${sessionId}-work`,
    run_id: `${sessionId}-run`,
    execution_kind: "agent",
    type: "AGENT_EVENT",
    occurred_at: `2026-08-14T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    actor: "agent",
    target: type,
    input_hash: null,
    result_ref: null,
    payload: {
      event: type === "text_delta"
        ? { type, phase: "final_answer", text }
        : { type, text },
    },
  };
}

function wireEvent(
  sessionId: string,
  sequence: number,
  runId: string,
): SessionEvent {
  return {
    schema_version: 1,
    event_id: `${sessionId}-event-${sequence}`,
    sequence,
    work_item_id: `${sessionId}-work`,
    run_id: runId,
    execution_kind: "agent",
    type: "RUN_STARTED",
    occurred_at: `2026-08-14T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    actor: "system",
    target: null,
    input_hash: null,
    result_ref: null,
    payload: {},
  };
}

function activeTail(view: SessionView): string {
  const lastTurn = view.snapshot.timeline.turns.at(-1);
  const lastBlock = lastTurn?.blocks.at(-1);
  return lastBlock?.segments.map((segment) => segment.content).join("") ?? "";
}

describe("SessionViewStore", () => {
  it("keeps cached Session windows isolated", () => {
    const store = new SessionViewStore({ schedule: (flush) => flush() });
    store.hydrate(snapshot("sess_1", 10));
    store.hydrate(snapshot("sess_2", 20));
    store.receive("sess_1", deltaEvent("sess_1", 11, "A"));
    expect(store.get("sess_1")?.snapshot.runtime.last_event_sequence).toBe(11);
    expect(store.get("sess_2")?.snapshot.runtime.last_event_sequence).toBe(20);
  });

  it("ignores duplicates and detects Sequence gaps", () => {
    const store = new SessionViewStore({ schedule: (flush) => flush() });
    store.hydrate(snapshot("sess_1", 10));
    expect(store.receive("sess_1", deltaEvent("sess_1", 10, "A"))).toBe("duplicate");
    expect(store.receive("sess_1", deltaEvent("sess_1", 12, "B"))).toBe("gap");
    expect(store.get("sess_1")?.status).toBe("recovering");
  });

  it("does not overwrite a newer cache with an older snapshot", () => {
    const store = new SessionViewStore({ schedule: (flush) => flush() });
    store.hydrate(snapshot("sess_1", 10));
    store.receive("sess_1", deltaEvent("sess_1", 11, "new"));
    store.hydrate(snapshot("sess_1", 10));
    expect(store.get("sess_1")?.snapshot.runtime.last_event_sequence).toBe(11);
    expect(activeTail(store.get("sess_1")!)).toBe("new");
  });

  it("batches subscribers while applying only the active tail", () => {
    const scheduled: Array<() => void> = [];
    const store = new SessionViewStore({ schedule: (flush) => scheduled.push(flush) });
    store.hydrate(snapshot("sess_1", 10));
    const listener = vi.fn();
    store.subscribe("sess_1", listener);
    store.receive("sess_1", deltaEvent("sess_1", 11, "a"));
    store.receive("sess_1", deltaEvent("sess_1", 12, "b"));
    expect(listener).not.toHaveBeenCalled();
    scheduled.shift()?.();
    expect(listener).toHaveBeenCalledOnce();
    expect(activeTail(store.get("sess_1")!)).toBe("ab");
  });

  it("shows a new user message without blocking later thought deltas", () => {
    const store = new SessionViewStore({ schedule: (flush) => flush() });
    store.hydrate(snapshot("sess_1", 10));
    expect(store.receive("sess_1", {
      ...wireEvent("sess_1", 11, "sess_1-run-2"),
      event_id: "sess_1-user-11",
      type: "MESSAGE_RECEIVED",
      payload: { message: "离散分布呢" },
    })).toBe("applied");
    expect(store.receive("sess_1", {
      ...wireEvent("sess_1", 12, "sess_1-run-2"),
      event_id: "sess_1-run-12",
    })).toBe("refresh_required");
    expect(store.receive("sess_1", {
      ...wireEvent("sess_1", 13, "sess_1-run-2"),
      event_id: "sess_1-thought-13",
      type: "AGENT_EVENT",
      actor: "agent",
      target: "thought_delta",
      payload: { event: { type: "thought_delta", text: "正在推理" } },
    })).toBe("applied");

    const turns = store.get("sess_1")!.snapshot.timeline.turns;
    expect(turns.map((turn) => turn.run_id)).toEqual(["sess_1-run", "sess_1-run-2"]);
    expect(turns[0]?.blocks).toHaveLength(1);
    expect(turns[1]?.blocks.map((block) => block.kind)).toEqual(["user_message", "thought"]);
    expect(turns[1]?.blocks[0]?.segments[0]?.content).toBe("离散分布呢");
    expect(turns[1]?.blocks.at(-1)?.next_segment_cursor).toBeNull();
    expect(store.get("sess_1")?.status).toBe("ready");
  });

  it("keeps resumed thought above Agent and freezes the previous thought clock", () => {
    const store = new SessionViewStore({ schedule: (flush) => flush() });
    store.hydrate(snapshot("sess_1", 10));
    expect(store.receive("sess_1", deltaEvent("sess_1", 11, "先推理", "thought_delta"))).toBe("applied");
    expect(store.receive("sess_1", deltaEvent("sess_1", 12, "部分回复"))).toBe("applied");
    expect(store.receive("sess_1", deltaEvent("sess_1", 13, "再推理", "thought_delta"))).toBe("applied");

    const blocks = store.get("sess_1")!.snapshot.timeline.turns[0]!.blocks;
    expect(blocks.map((block) => block.kind)).toEqual(["thought", "thought", "assistant"]);
    expect(blocks[0]?.status).toBe("completed");
    expect(blocks[0]?.metadata.ended_at).toBe("2026-08-14T00:00:12.000Z");
    expect(blocks[0]?.segments[0]?.content).toBe("先推理");
    expect(blocks[1]?.status).toBe("running");
    expect(blocks[1]?.metadata.started_at).toBe("2026-08-14T00:00:13.000Z");
    expect(blocks[1]?.segments[0]?.content).toBe("再推理");
    expect(blocks[2]?.segments.map((segment) => segment.content).join("")).toBe("部分回复");
  });

  it("does not treat live output as truncated", () => {
    const store = new SessionViewStore({ schedule: (flush) => flush() });
    store.hydrate(snapshot("sess_1", 10));
    store.receive("sess_1", deltaEvent("sess_1", 11, "hello"));
    expect(store.get("sess_1")?.snapshot.timeline.turns[0]?.blocks[0]?.next_segment_cursor).toBeNull();
  });

  it("merges earlier Timeline pages without duplicating Turns", () => {
    const store = new SessionViewStore({ schedule: (flush) => flush() });
    store.hydrate(snapshot("sess_1", 10));
    store.mergeTimelinePage("sess_1", {
      turns: [{
        turn_id: "earlier",
        run_id: "earlier-run",
        timeline_index: -1,
        status: "succeeded",
        blocks: [],
      }],
      previous_cursor: 3,
      truncated_block_ids: [],
    });
    expect(store.get("sess_1")?.snapshot.timeline.turns.map((turn) => turn.turn_id)).toEqual([
      "earlier",
      "sess_1-turn",
    ]);
    expect(store.get("sess_1")?.snapshot.timeline.previous_cursor).toBe(3);
  });

  it("merges Segment and Queue pages into the authoritative snapshot", () => {
    const store = new SessionViewStore({ schedule: (flush) => flush() });
    const initial = snapshot("sess_1", 10);
    initial.runtime.queue = {
      turns: [{
        turn_id: "turn-1",
        queue_position: 1,
        status: "queued",
        version: 1,
        message: { text: "one", attachment_ids: [] },
        created_at: "2026-08-14T00:00:00.000Z",
      }],
      total: 2,
      next_cursor: 1,
    };
    store.hydrate(initial);
    store.mergeSegmentPage("sess_1", "sess_1-block", {
      segments: [{ segment_id: "segment-2", segment_index: 1, content: "more", byte_length: 4, sealed: true }],
      next_cursor: null,
    });
    store.mergeQueuePage("sess_1", {
      turns: [{
        turn_id: "turn-2",
        queue_position: 2,
        status: "queued",
        version: 1,
        message: { text: "two", attachment_ids: [] },
        created_at: "2026-08-14T00:00:01.000Z",
      }],
      total: 2,
      next_cursor: null,
    });
    const next = store.get("sess_1")!.snapshot;
    expect(next.timeline.turns[0]?.blocks[0]?.segments.map((segment) => segment.content)).toEqual(["", "more"]);
    expect(next.runtime.queue.turns.map((turn) => turn.turn_id)).toEqual(["turn-1", "turn-2"]);
  });
});
