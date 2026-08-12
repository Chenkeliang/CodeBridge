import { describe, expect, it } from "vitest";
import { reduceConversationEvents } from "./events";
import * as eventLogic from "./events";

describe("conversation event projection", () => {
  it("projects a running work block as soon as a Run starts", () => {
    const projection = reduceConversationEvents([
      {
        event_id: "message-1",
        sequence: 1,
        run_id: null,
        type: "MESSAGE_RECEIVED",
        occurred_at: "2026-08-11T00:00:00.000Z",
        payload: { message: "检查项目" },
      },
      {
        event_id: "run-started-1",
        sequence: 2,
        run_id: "run-1",
        type: "RUN_STARTED",
        occurred_at: "2026-08-11T00:00:01.000Z",
        payload: {},
      },
    ]);

    expect(projection).toEqual([
      expect.objectContaining({ kind: "user", content: "检查项目" }),
      expect.objectContaining({
        kind: "work",
        id: "run-started-1",
        entries: [],
        runId: "run-1",
        running: true,
      }),
    ]);
  });

  it("marks the running work block complete when the Run finishes", () => {
    const projection = reduceConversationEvents([
      {
        event_id: "run-started-1",
        sequence: 1,
        run_id: "run-1",
        type: "RUN_STARTED",
        occurred_at: "2026-08-11T00:00:01.000Z",
        payload: {},
      },
      {
        event_id: "run-succeeded-1",
        sequence: 2,
        run_id: "run-1",
        type: "RUN_SUCCEEDED",
        occurred_at: "2026-08-11T00:00:06.000Z",
        payload: {},
      },
    ]);

    expect(projection).toEqual([
      expect.objectContaining({
        kind: "work",
        runId: "run-1",
        running: false,
        endedAt: "2026-08-11T00:00:06.000Z",
      }),
    ]);
  });

  it("does not create a trailing work block for hydrated provider tool snapshots", () => {
    const event = (eventId: string, sequence: number, runId: string | null, type: string, value: Record<string, unknown> = {}) => ({
      event_id: eventId,
      sequence,
      run_id: runId,
      type,
      occurred_at: `2026-08-11T00:00:${String(sequence).padStart(2, "0")}.000Z`,
      payload: type === "AGENT_EVENT" ? { event: value } : type === "MESSAGE_RECEIVED" ? value : {},
    });
    const projection = reduceConversationEvents([
      event("message-1", 1, null, "MESSAGE_RECEIVED", { message: "检查项目" }),
      event("run-started-1", 2, "run-1", "RUN_STARTED"),
      event("tool-start-1", 3, "run-1", "AGENT_EVENT", { type: "tool_start", toolCallId: "tool-1", name: "exec" }),
      event("tool-end-1", 4, "run-1", "AGENT_EVENT", { type: "tool_end", toolCallId: "tool-1", status: "completed" }),
      event("answer-1", 5, "run-1", "AGENT_EVENT", { type: "text_delta", phase: "final_answer", text: "检查完成" }),
      event("run-succeeded-1", 6, "run-1", "RUN_SUCCEEDED"),
      event("hydrated-tool-1", 7, null, "AGENT_EVENT", { type: "tool_end", toolCallId: "tool-1", status: "completed", output: "历史快照" }),
      event("hydrated-1", 8, null, "SESSION_HISTORY_HYDRATED"),
    ]);

    expect(projection.map((item) => item.kind)).toEqual(["user", "work", "assistant"]);
    expect(projection[1]).toMatchObject({
      kind: "work",
      entries: [expect.objectContaining({ kind: "tool", id: "tool-1", output: "历史快照" })],
    });
  });

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

  it("hides provider snapshot thought and answer events already represented by streamed deltas", () => {
    const event = (eventId: string, sequence: number, runId: string | null, value: Record<string, unknown>) => ({
      event_id: eventId,
      sequence,
      run_id: runId,
      type: "AGENT_EVENT",
      occurred_at: `2026-08-11T00:00:${String(sequence).padStart(2, "0")}.000Z`,
      payload: { event: value },
    });
    const projection = reduceConversationEvents([
      { event_id: "user", sequence: 1, run_id: null, type: "MESSAGE_RECEIVED", occurred_at: "2026-08-11T00:00:00.000Z", payload: { message: "问题" } },
      event("thought-1", 2, "run-1", { type: "thought_delta", text: "**先确认" }),
      event("thought-2", 3, "run-1", { type: "thought_delta", text: "问题范围**" }),
      event("answer-1", 4, "run-1", { type: "text_delta", text: "答案的前半段" }),
      event("answer-2", 5, "run-1", { type: "text_delta", text: "，以及后半段" }),
      event("imported-thought", 6, null, { type: "thought_delta", text: "**先确认问题范围**" }),
      event("imported-answer", 7, null, { type: "text_delta", text: "答案的前半段，以及后半段" }),
    ]);
    expect(projection.map((item) => item.kind)).toEqual(["user", "work", "assistant"]);
    expect(projection[1]).toMatchObject({
      kind: "work",
      entries: [expect.objectContaining({ kind: "thought", content: "**先确认问题范围**" })],
    });
    expect(projection[2]).toMatchObject({ kind: "assistant", content: "答案的前半段，以及后半段" });
  });
});
