import { describe, expect, it } from "vitest";
import { mapSessionUpdate } from "./acp/acp-event-mapper.js";

describe("mapSessionUpdate", () => {
  it("maps agent_thought_chunk to thought_delta", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking…" },
    });
    expect(events).toEqual([{ type: "thought_delta", text: "thinking…" }]);
  });

  it("maps agent_message_chunk to text_delta", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    });
    expect(events).toEqual([{ type: "text_delta", text: "hello" }]);
  });

  it("maps tool_call to tool_start", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Bash",
      status: "in_progress",
    });
    expect(events[0]?.type).toBe("tool_start");
    expect(events[0]).toMatchObject({ name: "Bash" });
  });

  it("maps completed tool_call_update to tool_end", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "Bash",
      status: "completed",
      rawOutput: "ok",
    });
    expect(events[0]?.type).toBe("tool_end");
  });
});
