import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { submitSessionMessage } from "./submit-session-message";
import type { SessionMessageReceipt, SessionRuntimeView } from "./types";

const runtime: SessionRuntimeView = {
  active_run: null,
  queue_state: "ready",
  queue_pause_reason: null,
  queue: { turns: [], total: 0, next_cursor: null },
  version: 1,
  last_event_sequence: 1,
};

const receipt: SessionMessageReceipt = {
  event_id: "event-1",
  sequence: 1,
  acceptance: "queued",
  turn: {
    turn_id: "turn-1",
    queue_position: 1,
    status: "queued",
    version: 1,
    message: { text: "hello", attachment_ids: [] },
    created_at: "2026-08-14T00:00:00.000Z",
  },
  runtime,
};

const base = {
  sessionId: "session-1",
  idempotencyKey: "key-1",
  input: {
    message: "hello",
    flowId: null,
    model: null,
    attachments: [],
    permissionMode: null,
    effort: null,
  },
};

describe("submitSessionMessage", () => {
  it("retries an uncertain request with the same key", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(receipt);
    const result = await submitSessionMessage({ ...base, send, lookup: vi.fn() });
    expect(result).toEqual({ kind: "accepted", receipt });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[1].idempotencyKey).toBe("key-1");
    expect(send.mock.calls[1]?.[1].idempotencyKey).toBe("key-1");
  });

  it("looks up the durable receipt after two uncertain requests", async () => {
    const lookup = vi.fn().mockResolvedValue(receipt);
    const result = await submitSessionMessage({
      ...base,
      send: vi.fn().mockRejectedValue(new TypeError("network")),
      lookup,
    });
    expect(result).toEqual({ kind: "accepted", receipt });
    expect(lookup).toHaveBeenCalledWith("session-1", "key-1");
  });

  it("surfaces a definite HTTP rejection without retrying", async () => {
    const error = new ApiError(409, "version_conflict", "conflict");
    const send = vi.fn().mockRejectedValue(error);
    expect(await submitSessionMessage({ ...base, send, lookup: vi.fn() })).toEqual({ kind: "rejected", error });
    expect(send).toHaveBeenCalledOnce();
  });
});
