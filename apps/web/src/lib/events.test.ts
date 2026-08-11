import { describe, expect, it } from "vitest";
import { reduceConversationEvents } from "./events";

describe("conversation event projection", () => {
  it("merges streamed text deltas and tool lifecycle events", () => {
    const projection = reduceConversationEvents([
      {
        event_id: "event-1",
        sequence: 1,
        run_id: "run-1",
        type: "AGENT_EVENT",
        occurred_at: "2026-08-11T00:00:00.000Z",
        payload: { event: { type: "text_delta", phase: "final_answer", text: "Hello " } },
      },
      {
        event_id: "event-2",
        sequence: 2,
        run_id: "run-1",
        type: "AGENT_EVENT",
        occurred_at: "2026-08-11T00:00:01.000Z",
        payload: { event: { type: "text_delta", phase: "final_answer", text: "world" } },
      },
      {
        event_id: "event-3",
        sequence: 3,
        run_id: "run-1",
        type: "AGENT_EVENT",
        occurred_at: "2026-08-11T00:00:02.000Z",
        payload: { event: { type: "tool_start", toolCallId: "tool-1", name: "read_file", input: { path: "README.md" } } },
      },
      {
        event_id: "event-4",
        sequence: 4,
        run_id: "run-1",
        type: "AGENT_EVENT",
        occurred_at: "2026-08-11T00:00:03.000Z",
        payload: { event: { type: "tool_end", toolCallId: "tool-1", name: "read_file", status: "completed", output: "done" } },
      },
    ]);

    expect(projection).toEqual([
      expect.objectContaining({ kind: "assistant", content: "Hello world" }),
      expect.objectContaining({ kind: "tool", id: "tool-1", status: "completed", output: "done" }),
    ]);
  });
});
