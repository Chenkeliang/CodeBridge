import { describe, expect, it, vi } from "vitest";
import { api, streamSessionEvents } from "./api";
import { SessionConnection } from "./session-connection";
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

function deltaEvent(sessionId: string, sequence: number, text: string): SessionEvent {
  return {
    event_id: `${sessionId}-event-${sequence}`,
    sequence,
    run_id: `${sessionId}-run`,
    type: "AGENT_EVENT",
    occurred_at: `2026-08-14T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    payload: { event: { type: "text_delta", phase: "final_answer", text } },
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function activeTail(view: SessionView): string {
  const lastTurn = view.snapshot.timeline.turns.at(-1);
  const lastBlock = lastTurn?.blocks.at(-1);
  return lastBlock?.segments.map((segment) => segment.content).join("") ?? "";
}

describe("SessionConnection", () => {
  it("applies the first streamed delta once before reconnecting", async () => {
    const store = new SessionViewStore({ schedule: (flush) => flush() });
    const openSession = vi.fn().mockResolvedValue(snapshot("sess_1", 10));
    let applied!: () => void;
    const appliedOnce = new Promise<void>((resolve) => {
      applied = resolve;
    });
    const stream = vi.fn(async (_sessionId: string, after: number, signal: AbortSignal, onEvent: (event: SessionEvent) => void) => {
      onEvent(deltaEvent("sess_1", after + 1, "hello"));
      applied();
      await waitForAbort(signal);
    });
    const connection = new SessionConnection({
      store,
      openSession: openSession as typeof api.openSession,
      stream: stream as typeof streamSessionEvents,
    });

    const pending = connection.open("sess_1");
    await appliedOnce;
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(store.get("sess_1")?.snapshot.runtime.last_event_sequence).toBe(11);
    expect(activeTail(store.get("sess_1")!)).toBe("hello");
    connection.close();
    await pending;
  });

  it("refreshes again when a streamed sequence has a gap", async () => {
    const store = new SessionViewStore({ schedule: (flush) => flush() });
    let secondRefresh!: () => void;
    const secondRefreshSeen = new Promise<void>((resolve) => {
      secondRefresh = resolve;
    });
    const openSession = vi.fn()
      .mockResolvedValueOnce(snapshot("sess_1", 10))
      .mockImplementationOnce(async () => {
        secondRefresh();
        return snapshot("sess_1", 12);
      });
    const stream = vi.fn(async (_sessionId: string, after: number, signal: AbortSignal, onEvent: (event: SessionEvent) => void) => {
      onEvent(deltaEvent("sess_1", after + 2, "gap"));
      await waitForAbort(signal);
    });
    const connection = new SessionConnection({
      store,
      openSession: openSession as typeof api.openSession,
      stream: stream as typeof streamSessionEvents,
    });

    const pending = connection.open("sess_1");
    await secondRefreshSeen;
    expect(openSession).toHaveBeenCalledTimes(2);
    connection.close();
    await pending;
  });

  it("refreshes again after an in-flight refresh when another refresh is requested", async () => {
    const store = new SessionViewStore({ schedule: (flush) => flush() });
    let finishFirst!: (snapshot: SessionSnapshot) => void;
    const firstOpen = new Promise<SessionSnapshot>((resolve) => {
      finishFirst = resolve;
    });
    const openSession = vi.fn()
      .mockImplementationOnce(() => firstOpen)
      .mockResolvedValueOnce(snapshot("sess_1", 12));
    const connection = new SessionConnection({
      store,
      openSession: openSession as typeof api.openSession,
      stream: async (_sessionId, _after, signal) => waitForAbort(signal),
    });

    const pending = connection.open("sess_1");
    await Promise.resolve();
    const second = connection.refresh("sess_1");
    finishFirst(snapshot("sess_1", 10));
    await second;
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(store.get("sess_1")?.snapshot.runtime.last_event_sequence).toBe(12);
    connection.close();
    await pending;
  });
});
