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
      locations: [{ path: "src/index.ts", line: 4 }],
    });
    expect(events).toEqual([
      {
        type: "tool_end",
        toolCallId: "t1",
        status: "completed",
        name: "Bash",
        output: "ok",
        locations: [{ path: "src/index.ts", line: 4 }],
      },
    ]);
  });

  it("maps in-progress tool_call_update to tool_update", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "Bash",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "running" } }],
    });
    expect(events).toEqual([
      {
        type: "tool_update",
        toolCallId: "t1",
        name: "Bash",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "running" } }],
      },
    ]);
  });

  it("keeps partial tool updates patch-like instead of inventing a tool name", () => {
    expect(
      mapSessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
      }),
    ).toEqual([
      {
        type: "tool_end",
        toolCallId: "t1",
        status: "completed",
      },
    ]);
  });

  it("preserves messageId on streamed content", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: "hello" },
    });
    expect(events).toEqual([
      { type: "text_delta", text: "hello", messageId: "m1" },
    ]);
  });

  it("maps plan updates and removals", () => {
    expect(
      mapSessionUpdate({
        sessionUpdate: "plan",
        entries: [
          { content: "Inspect", priority: "high", status: "in_progress" },
        ],
      }),
    ).toEqual([
      {
        type: "plan",
        entries: [
          { content: "Inspect", priority: "high", status: "in_progress" },
        ],
      },
    ]);
    expect(
      mapSessionUpdate({
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId: "p1",
          entries: [
            { content: "Implement", priority: "medium", status: "pending" },
          ],
        },
      }),
    ).toEqual([
      {
        type: "plan_update",
        plan: {
          type: "items",
          planId: "p1",
          entries: [
            { content: "Implement", priority: "medium", status: "pending" },
          ],
        },
      },
    ]);
    expect(
      mapSessionUpdate({ sessionUpdate: "plan_removed", planId: "p1" }),
    ).toEqual([{ type: "plan_removed", planId: "p1" }]);
  });

  it("maps usage, session metadata, mode, commands, and config updates", () => {
    const bool = {
      id: "verbose",
      name: "Verbose",
      category: "_debug",
      type: "boolean",
      currentValue: true,
    } as const;
    expect(
      mapSessionUpdate({
        sessionUpdate: "usage_update",
        used: 12,
        size: 100,
        cost: { amount: 0.02, currency: "USD" },
      }),
    ).toEqual([
      {
        type: "usage_update",
        used: 12,
        size: 100,
        cost: { amount: 0.02, currency: "USD" },
      },
    ]);
    expect(
      mapSessionUpdate({
        sessionUpdate: "session_info_update",
        title: "Refactor",
        updatedAt: "2026-07-31T00:00:00Z",
      }),
    ).toEqual([
      {
        type: "session_info_update",
        title: "Refactor",
        updatedAt: "2026-07-31T00:00:00Z",
      },
    ]);
    expect(
      mapSessionUpdate({ sessionUpdate: "current_mode_update", currentModeId: "ask" }),
    ).toEqual([{ type: "current_mode_update", currentModeId: "ask" }]);
    expect(
      mapSessionUpdate({
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "compact", description: "Compact context" },
        ],
      }),
    ).toEqual([
      {
        type: "available_commands_update",
        availableCommands: [
          { name: "compact", description: "Compact context" },
        ],
      },
    ]);
    expect(
      mapSessionUpdate({ sessionUpdate: "config_option_update", configOptions: [bool] }),
    ).toEqual([
      {
        type: "config_option_update",
        configOptions: [
          {
            id: "verbose",
            name: "Verbose",
            category: "_debug",
            currentValue: "true",
            type: "boolean",
            values: [
              { value: "true", name: "On" },
              { value: "false", name: "Off" },
            ],
          },
        ],
      },
    ]);
  });
});
