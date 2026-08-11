import { describe, expect, it } from "vitest";
import { reduceConversationEvents } from "./events";
import * as eventLogic from "./events";

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
      expect.objectContaining({
        kind: "work",
        entries: [expect.objectContaining({ kind: "tool", id: "tool-1", status: "completed", output: "done" })],
      }),
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

  it("groups commentary, thought summaries, and tools into one collapsible work block", () => {
    const projection = reduceConversationEvents([
      {
        event_id: "message-1",
        sequence: 1,
        run_id: "run-1",
        type: "MESSAGE_RECEIVED",
        occurred_at: "2026-08-11T00:00:00.000Z",
        payload: { message: "检查项目" },
      },
      {
        event_id: "commentary-1",
        sequence: 2,
        run_id: "run-1",
        type: "AGENT_EVENT",
        occurred_at: "2026-08-11T00:00:01.000Z",
        payload: { event: { type: "text_delta", phase: "commentary", text: "先读取配置" } },
      },
      {
        event_id: "thought-1",
        sequence: 3,
        run_id: "run-1",
        type: "AGENT_EVENT",
        occurred_at: "2026-08-11T00:00:02.000Z",
        payload: { event: { type: "thought_delta", text: "确认配置来源" } },
      },
      {
        event_id: "tool-1",
        sequence: 4,
        run_id: "run-1",
        type: "AGENT_EVENT",
        occurred_at: "2026-08-11T00:00:03.000Z",
        payload: { event: { type: "tool_start", toolCallId: "tool-1", name: "exec", kind: "execute", input: { cmd: "pwd" } } },
      },
      {
        event_id: "tool-2",
        sequence: 5,
        run_id: "run-1",
        type: "AGENT_EVENT",
        occurred_at: "2026-08-11T00:00:04.000Z",
        payload: { event: { type: "tool_end", toolCallId: "tool-1", status: "completed", output: "/workspace" } },
      },
      {
        event_id: "answer-1",
        sequence: 6,
        run_id: "run-1",
        type: "AGENT_EVENT",
        occurred_at: "2026-08-11T00:00:05.000Z",
        payload: { event: { type: "text_delta", phase: "final_answer", text: "检查完成" } },
      },
    ]);

    expect(projection).toEqual([
      expect.objectContaining({ kind: "user", content: "检查项目" }),
      expect.objectContaining({
        kind: "work",
        entries: [
          expect.objectContaining({ kind: "commentary", content: "先读取配置" }),
          expect.objectContaining({ kind: "thought", content: "确认配置来源" }),
          expect.objectContaining({ kind: "tool", id: "tool-1", status: "completed", toolKind: "execute" }),
        ],
      }),
      expect.objectContaining({ kind: "assistant", phase: "final_answer", content: "检查完成" }),
    ]);
  });

  it("keeps final answers separated by user turns", () => {
    const event = (eventId: string, sequence: number, type: string, payload: Record<string, unknown>) => ({
      event_id: eventId,
      sequence,
      run_id: null,
      type,
      occurred_at: "2026-08-11T00:00:00.000Z",
      payload,
    });
    const projection = reduceConversationEvents([
      event("user-1", 1, "MESSAGE_RECEIVED", { message: "第一问" }),
      event("answer-1", 2, "AGENT_EVENT", { event: { type: "text_delta", phase: "final_answer", text: "第一答" } }),
      event("user-2", 3, "MESSAGE_RECEIVED", { message: "第二问" }),
      event("answer-2", 4, "AGENT_EVENT", { event: { type: "text_delta", phase: "final_answer", text: "第二答" } }),
    ]);

    expect(projection.map((item) => item.kind)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(projection.filter((item) => item.kind === "assistant").map((item) => item.content)).toEqual(["第一答", "第二答"]);
  });

  it("describes command and file tools with readable absolute targets", () => {
    const describeTool = (eventLogic as unknown as {
      describeTool?: (tool: Record<string, unknown>, cwd?: string | null) => { category: string; label: string; target?: string };
    }).describeTool;
    expect(describeTool).toBeTypeOf("function");
    if (!describeTool) return;

    expect(describeTool({ name: "exec", input: { cmd: "pnpm test" } }, "/workspace/app")).toEqual({
      category: "command",
      label: "Ran command",
      target: "pnpm test",
    });
    expect(describeTool({ name: "read_file", input: { path: "src/index.ts" } }, "/workspace/app")).toEqual({
      category: "file",
      label: "Read file",
      target: "/workspace/app/src/index.ts",
    });
    expect(describeTool({ name: "exec", input: 'await tools.exec_command({cmd:"pnpm test", workdir:"/workspace/app"})' }, "/workspace/app")).toEqual({
      category: "command",
      label: "Ran command",
      target: "pnpm test",
    });
  });

  it("deduplicates hydrated Codex messages and infers historical progress around tools", () => {
    const projection = reduceConversationEvents([
      { event_id: "user", sequence: 1, run_id: null, type: "MESSAGE_RECEIVED", occurred_at: "2026-08-11T00:00:00.000Z", payload: { message: "检查" } },
      { event_id: "progress-event", sequence: 2, run_id: null, type: "AGENT_EVENT", occurred_at: "2026-08-11T00:00:01.000Z", payload: { event: { type: "text_delta", text: "正在检查" } } },
      { event_id: "progress-response", sequence: 3, run_id: null, type: "AGENT_EVENT", occurred_at: "2026-08-11T00:00:01.001Z", payload: { event: { type: "text_delta", text: "正在检查", messageId: "message-1" } } },
      { event_id: "tool-start", sequence: 4, run_id: null, type: "AGENT_EVENT", occurred_at: "2026-08-11T00:00:02.000Z", payload: { event: { type: "tool_start", toolCallId: "tool-1", name: "exec", input: { cmd: "pwd" } } } },
      { event_id: "tool-end", sequence: 5, run_id: null, type: "AGENT_EVENT", occurred_at: "2026-08-11T00:00:03.000Z", payload: { event: { type: "tool_end", toolCallId: "tool-1", status: "completed" } } },
      { event_id: "answer-event", sequence: 6, run_id: null, type: "AGENT_EVENT", occurred_at: "2026-08-11T00:00:04.000Z", payload: { event: { type: "text_delta", text: "检查完成" } } },
      { event_id: "answer-response", sequence: 7, run_id: null, type: "AGENT_EVENT", occurred_at: "2026-08-11T00:00:04.001Z", payload: { event: { type: "text_delta", text: "检查完成", messageId: "message-2" } } },
    ]);

    expect(projection).toEqual([
      expect.objectContaining({ kind: "user", content: "检查" }),
      expect.objectContaining({
        kind: "work",
        entries: [
          expect.objectContaining({ kind: "commentary", content: "正在检查" }),
          expect.objectContaining({ kind: "tool", id: "tool-1" }),
        ],
      }),
      expect.objectContaining({ kind: "assistant", content: "检查完成" }),
    ]);
  });
});
