import { describe, expect, it } from "vitest";
import { parseStreamJsonLine } from "./stream-parser.js";

describe("parseStreamJsonLine cursor-agent", () => {
  it("parses assistant message content", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello from cursor" }],
      },
    });
    const events = parseStreamJsonLine(line);
    expect(events).toEqual([{ type: "text_delta", text: "hello from cursor" }]);
  });

  it("parses result with final text and session", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "bin\npkg\nsrc",
      session_id: "abc-123",
      is_error: false,
    });
    const events = parseStreamJsonLine(line);
    expect(events).toContainEqual({ type: "session", sessionId: "abc-123" });
    expect(events).toContainEqual({ type: "text_delta", text: "bin\npkg\nsrc" });
    expect(events).toContainEqual({ type: "done", exitCode: 0 });
  });

  it("parses system init session_id", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { type: "session", sessionId: "sess-1" },
    ]);
  });
});
