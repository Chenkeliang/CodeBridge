import { describe, expect, it } from "vitest";
import {
  FlowSaveInboxState,
  mergeFlowSaveInboxPages,
} from "./flow-save-inbox-state";
import type { FlowSaveInboxPage, FlowSaveInboxRequest } from "./types";

function request(requestId: string): FlowSaveInboxRequest {
  return {
    request_id: requestId,
    session_id: `sess_${requestId}`,
    agent_id: "pi",
    session_title: requestId,
    request_turn_id: `turn_request_${requestId}`,
    request_run_id: `run_request_${requestId}`,
    source_turn_id: `turn_source_${requestId}`,
    source_run_id: `run_source_${requestId}`,
    source_title: `来源 ${requestId}`,
    source: "agent_intent",
    user_message: "保存刚才的流程",
    intent_summary: null,
    name_hint: null,
    source_imported: false,
    created_at: "2026-08-26T04:00:00.000Z",
    event_sequence: 1,
  };
}

function page(...requests: FlowSaveInboxRequest[]): FlowSaveInboxPage {
  return { requests, next_cursor: null };
}

describe("FlowSaveInboxState", () => {
  it("lets a newer immediate refresh win over a late poll success", () => {
    const state = new FlowSaveInboxState({ pollIntervalMs: 15_000 });
    const first = state.begin("periodic", 1_000)!;
    const second = state.begin("immediate", 2_000)!;

    expect(first.signal.aborted).toBe(true);
    expect(state.succeed(second, [page(request("new"))], 3_000)).toBe(true);
    expect(state.succeed(first, [page(request("old"))], 4_000)).toBe(false);
    expect(state.snapshot()).toMatchObject({
      requests: [expect.objectContaining({ request_id: "new" })],
      error: null,
      nextPollAt: 18_000,
    });
  });

  it("does not let a late failure clear a newer successful snapshot", () => {
    const state = new FlowSaveInboxState({ pollIntervalMs: 15_000 });
    const first = state.begin("periodic", 1_000)!;
    const second = state.begin("immediate", 2_000)!;
    state.succeed(second, [page(request("new"))], 3_000);

    expect(state.fail(first, new Error("late"), 4_000)).toBe(false);
    expect(state.snapshot()).toMatchObject({
      requests: [expect.objectContaining({ request_id: "new" })],
      error: null,
      nextPollAt: 18_000,
    });
  });

  it("aborts the active request before starting an immediate refresh", () => {
    const state = new FlowSaveInboxState();
    const first = state.begin("periodic", 1_000)!;
    let abortedWhenSecondStarted = false;
    first.signal.addEventListener("abort", () => { abortedWhenSecondStarted = true; });

    const second = state.begin("immediate", 2_000)!;

    expect(abortedWhenSecondStarted).toBe(true);
    expect(second.generation).toBe(first.generation + 1);
  });

  it("silently ignores AbortError and keeps the last good snapshot", () => {
    const state = new FlowSaveInboxState();
    const initial = state.begin("immediate", 1_000)!;
    state.succeed(initial, [page(request("kept"))], 2_000);
    const refresh = state.begin("immediate", 3_000)!;

    expect(state.fail(refresh, new DOMException("aborted", "AbortError"), 4_000)).toBe(true);
    expect(state.snapshot()).toMatchObject({
      requests: [expect.objectContaining({ request_id: "kept" })],
      error: null,
      loading: false,
    });
  });

  it("retains the last successful list when a refresh fails", () => {
    const state = new FlowSaveInboxState();
    const initial = state.begin("immediate", 1_000)!;
    state.succeed(initial, [page(request("kept"))], 2_000);
    const refresh = state.begin("periodic", 3_000)!;

    state.fail(refresh, new Error("unavailable"), 4_000);

    expect(state.snapshot()).toMatchObject({
      requests: [expect.objectContaining({ request_id: "kept" })],
      error: "unavailable",
      loading: false,
    });
  });

  it("resets the poll deadline from immediate refresh settlement", () => {
    const state = new FlowSaveInboxState({ pollIntervalMs: 15_000 });
    const initial = state.begin("periodic", 1_000)!;
    state.succeed(initial, [page()], 2_000);
    expect(state.snapshot().nextPollAt).toBe(17_000);

    const afterCommand = state.begin("immediate", 10_000)!;
    state.succeed(afterCommand, [page()], 12_000);

    expect(state.snapshot().nextPollAt).toBe(27_000);
  });

  it("does not start a second periodic request while one is active", () => {
    const state = new FlowSaveInboxState();

    expect(state.begin("periodic", 1_000)).not.toBeNull();
    expect(state.begin("periodic", 2_000)).toBeNull();
  });

  it("merges pages in server order and deduplicates request IDs", () => {
    expect(mergeFlowSaveInboxPages([
      page(request("a"), request("b")),
      page(request("b"), request("c")),
    ]).map((entry) => entry.request_id)).toEqual(["a", "b", "c"]);
  });

  it("cancels the current request without clearing the snapshot", () => {
    const state = new FlowSaveInboxState();
    const initial = state.begin("immediate", 1_000)!;
    state.succeed(initial, [page(request("kept"))], 2_000);
    const refresh = state.begin("periodic", 3_000)!;

    state.cancel();

    expect(refresh.signal.aborted).toBe(true);
    expect(state.snapshot().requests.map((entry) => entry.request_id)).toEqual(["kept"]);
  });
});
