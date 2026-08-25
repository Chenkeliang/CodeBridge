import { describe, expect, it } from "vitest";
import { parseSessionEventWire } from "./session-event-wire.js";

function wireEvent(): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: "evt_1",
    sequence: 1,
    work_item_id: "work_1",
    run_id: "run_1",
    type: "RUN_SUCCEEDED",
    occurred_at: "2026-08-24T00:00:00.000Z",
    actor: "system",
    target: null,
    input_hash: null,
    result_ref: null,
    payload: {},
  };
}

describe("SessionEventWire", () => {
  it("accepts the canonical snake_case event", () => {
    expect(parseSessionEventWire(wireEvent())).toEqual(wireEvent());
  });

  it("rejects a camelCase transport event", () => {
    const event = wireEvent();
    delete event.run_id;
    event.runId = "run_1";

    expect(() => parseSessionEventWire(event)).toThrow(
      "session_event_schema_mismatch",
    );
  });
});
