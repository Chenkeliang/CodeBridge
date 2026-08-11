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

  it("keeps user messages and plans in the conversation timeline", () => {
    const projection = reduceConversationEvents([
      {
        event_id: "message-1",
        sequence: 1,
        run_id: null,
        type: "MESSAGE_RECEIVED",
        occurred_at: "2026-08-11T00:00:00.000Z",
        payload: { message: "检查当前工作区" },
      },
      {
        event_id: "plan-1",
        sequence: 2,
        run_id: "run-1",
        type: "AGENT_EVENT",
        occurred_at: "2026-08-11T00:00:01.000Z",
        payload: {
          event: {
            type: "plan",
            entries: [{ content: "读取目录", priority: "high", status: "in_progress" }],
          },
        },
      },
    ]);

    expect(projection).toEqual([
      expect.objectContaining({ kind: "user", content: "检查当前工作区" }),
      expect.objectContaining({ kind: "plan", entries: [{ content: "读取目录", priority: "high", status: "in_progress" }] }),
    ]);
  });

  it("projects permission requests and agent errors as actionable blocks", () => {
    const projection = reduceConversationEvents([
      {
        event_id: "approval-1",
        sequence: 1,
        run_id: "run-1",
        type: "AGENT_EVENT",
        occurred_at: "2026-08-11T00:00:00.000Z",
        payload: { event: { type: "permission_request", requestId: "req-1", title: "写入当前分支" } },
      },
      {
        event_id: "error-1",
        sequence: 2,
        run_id: "run-1",
        type: "AGENT_EVENT",
        occurred_at: "2026-08-11T00:00:01.000Z",
        payload: { event: { type: "error", message: "Runner 暂时不可用" } },
      },
    ]);

    expect(projection).toEqual([
      expect.objectContaining({ kind: "approval", requestId: "req-1", title: "写入当前分支" }),
      expect.objectContaining({ kind: "error", content: "Runner 暂时不可用" }),
    ]);
  });
});
