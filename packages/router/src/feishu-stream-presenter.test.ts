import { describe, expect, it } from "vitest";
import { createFeishuStreamPresenter } from "./feishu-stream-presenter.js";

describe("createFeishuStreamPresenter", () => {
  it("routes tool to thinking zone", () => {
    const { present } = createFeishuStreamPresenter();
    const part = present({
      type: "tool_start",
      name: "Read",
      input: { path: "/tmp/foo.ts" },
    });
    expect(part?.zone).toBe("thinking");
    expect(part?.text).toContain("Read");
  });

  it("routes text to result zone", () => {
    const { present } = createFeishuStreamPresenter();
    const part = present({ type: "text_delta", text: "hello" });
    expect(part?.zone).toBe("result");
    expect(part?.text).toBe("hello");
  });

  it("routes Codex commentary to the progress zone", () => {
    const { present } = createFeishuStreamPresenter({ showThinking: false });
    const part = present({
      type: "text_delta",
      text: "P3 正在接入板块下钻",
      messageId: "m1",
      phase: "commentary",
    });

    expect(part).toEqual({
      zone: "progress",
      text: "P3 正在接入板块下钻",
      messageId: "m1",
    });
  });

  it("keeps Codex final answers in the result zone", () => {
    const { present } = createFeishuStreamPresenter({ showThinking: false });
    expect(
      present({
        type: "text_delta",
        text: "最终结果",
        messageId: "m2",
        phase: "final_answer",
      }),
    ).toEqual({ zone: "result", text: "最终结果", messageId: "m2" });
  });

  it("routes thought to thinking zone", () => {
    const { present } = createFeishuStreamPresenter();
    const part = present({ type: "thought_delta", text: "内部推理" });
    expect(part?.zone).toBe("thinking");
    expect(part?.text).toBe("内部推理");
  });

  it("passes through streaming chunks as-is", () => {
    const { present } = createFeishuStreamPresenter();
    expect(present({ type: "text_delta", text: "hello" })?.text).toBe("hello");
    expect(present({ type: "text_delta", text: " world" })?.text).toBe(" world");
  });

  it("starts a new paragraph when the ACP message id changes", () => {
    const { present } = createFeishuStreamPresenter();

    expect(
      present({ type: "text_delta", text: "第一段", messageId: "m1" })?.text,
    ).toBe("第一段");
    expect(
      present({ type: "text_delta", text: "继续", messageId: "m1" })?.text,
    ).toBe("继续");
    expect(
      present({ type: "text_delta", text: "第二段", messageId: "m2" })?.text,
    ).toBe("\n\n第二段");
  });

  it("showThinking:false drops thought and tool events, keeps result/error", () => {
    const { present } = createFeishuStreamPresenter({ showThinking: false });
    expect(present({ type: "thought_delta", text: "内部推理" })).toBeNull();
    expect(
      present({ type: "tool_start", name: "Read", input: {} }),
    ).toBeNull();
    // 结果与错误照常呈现
    expect(present({ type: "text_delta", text: "答案" })?.zone).toBe("result");
    expect(present({ type: "error", message: "boom" })?.zone).toBe("result");
  });

  it("showThinking defaults to true when unset", () => {
    const { present } = createFeishuStreamPresenter({});
    expect(present({ type: "thought_delta", text: "x" })?.zone).toBe("thinking");
  });

  it("renders tool progress and completion in the thinking zone", () => {
    const { present } = createFeishuStreamPresenter();
    expect(
      present({
        type: "tool_update",
        toolCallId: "t1",
        name: "Bash",
        status: "in_progress",
      }),
    ).toEqual({ zone: "thinking", text: "\n  ↳ `Bash`（in_progress）\n" });
    expect(
      present({ type: "tool_end", toolCallId: "t1", name: "Bash" }),
    ).toEqual({ zone: "thinking", text: "\n✓ `Bash`\n" });
  });

  it("retains a tool name across partial ACP updates and marks failures", () => {
    const { present } = createFeishuStreamPresenter();
    present({
      type: "tool_start",
      toolCallId: "t1",
      name: "Bash",
      status: "in_progress",
    });
    expect(
      present({
        type: "tool_update",
        toolCallId: "t1",
        status: "pending",
      } as never),
    ).toEqual({ zone: "thinking", text: "\n  ↳ `Bash`（pending）\n" });
    expect(
      present({
        type: "tool_end",
        toolCallId: "t1",
        status: "failed",
      } as never),
    ).toEqual({ zone: "thinking", text: "\n✗ `Bash`（failed）\n" });
  });

  it("renders an ACP plan and usage update without dropping them", () => {
    const { present } = createFeishuStreamPresenter();
    const plan = present({
      type: "plan",
      entries: [
        { content: "Inspect", priority: "high", status: "in_progress" },
        { content: "Implement", priority: "medium", status: "pending" },
      ],
    });
    expect(plan?.zone).toBe("thinking");
    expect(plan?.text).toContain("Inspect");
    expect(plan?.text).toContain("Implement");
    expect(
      present({
        type: "usage_update",
        used: 1200,
        size: 8000,
        cost: { amount: 0.03, currency: "USD" },
      }),
    ).toBeNull();
    const usage = present({ type: "done", exitCode: 0 })?.text;
    expect(usage).toContain("1,200/8,000");
    expect(usage).toContain("0.03 USD");
  });

  it("renders and deduplicates ACP session metadata updates", () => {
    const { present } = createFeishuStreamPresenter();
    expect(
      present({ type: "current_mode_update", currentModeId: "plan" })?.text,
    ).toContain("mode: `plan`");
    expect(
      present({ type: "current_mode_update", currentModeId: "plan" }),
    ).toBeNull();
    expect(
      present({
        type: "config_option_update",
        configOptions: [
          {
            id: "model",
            name: "Model",
            currentValue: "gpt-5.6-sol",
            values: [],
          },
        ],
      })?.text,
    ).toContain("Model=`gpt-5.6-sol`");
    expect(
      present({
        type: "available_commands_update",
        availableCommands: [{ name: "compact", description: "Compact context" }],
      })?.text,
    ).toContain("/compact");
    expect(
      present({ type: "session_info_update", title: "Refactor ACP" })?.text,
    ).toContain("Refactor ACP");
  });

  it("does not show tool progress, plan, or usage when thinking is off", () => {
    const { present } = createFeishuStreamPresenter({ showThinking: false });
    expect(
      present({
        type: "tool_update",
        toolCallId: "t1",
        name: "Bash",
        status: "in_progress",
      }),
    ).toBeNull();
    expect(
      present({ type: "plan", entries: [] }),
    ).toBeNull();
    expect(
      present({ type: "usage_update", used: 1, size: 2 }),
    ).toBeNull();
  });

  it("clears plan dedupe state when ACP removes a plan", () => {
    const { present } = createFeishuStreamPresenter();
    const plan = {
      type: "plan" as const,
      entries: [
        { content: "Inspect", priority: "high" as const, status: "pending" as const },
      ],
    };
    expect(present(plan)).not.toBeNull();
    expect(present(plan)).toBeNull();
    expect(present({ type: "plan_removed", planId: "p1" })).toBeNull();
    expect(present(plan)).not.toBeNull();
  });
});
