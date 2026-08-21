import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@codebridge/core";
import { createChannelStreamProjector } from "./channel-stream-projector.js";

function commentary(text: string, messageId?: string): AgentEvent {
  return {
    type: "text_delta",
    phase: "commentary",
    text,
    ...(messageId ? { messageId } : {}),
  };
}

describe("createChannelStreamProjector", () => {
  it("merges delta, cumulative, duplicate, and prefix rollback commentary", () => {
    const projector = createChannelStreamProjector({ showThinking: false });

    projector.apply(commentary("你好", "m1"));
    projector.apply({ type: "tool_start", toolCallId: "t1", name: "Read" });
    projector.apply({ type: "tool_end", toolCallId: "t1", name: "Read" });
    projector.apply(commentary("你好，我来帮你处理", "m1"));
    projector.apply(commentary("你好", "m2"));
    projector.apply(commentary("你好", "m2"));

    expect(projector.snapshot().progress).toBe("你好，我来帮你处理");
    expect(projector.snapshot().liveText.match(/你好/g)).toHaveLength(1);
  });

  it("appends strict deltas and removes suffix-prefix overlap", () => {
    const projector = createChannelStreamProjector();

    projector.apply(commentary("正在查订", "m1"));
    projector.apply(commentary("订单", "m1"));
    projector.apply(commentary("，请稍候", "m1"));

    expect(projector.snapshot().progress).toBe("正在查订单，请稍候");
  });

  it("replaces an unrelated checkpoint when the message id changes", () => {
    const projector = createChannelStreamProjector();

    projector.apply(commentary("P2 已完成", "m1"));
    projector.apply(commentary("P3 正在推进", "m2"));

    expect(projector.snapshot().progress).toBe("P3 正在推进");
  });

  it("treats missing message ids as one stream and deduplicates snapshots", () => {
    const projector = createChannelStreamProjector();

    projector.apply(commentary("你好"));
    projector.apply(commentary("你好，我来处理"));
    projector.apply(commentary("你好"));

    expect(projector.snapshot().progress).toBe("你好，我来处理");
  });

  it("limits progress after merging without truncating the result", () => {
    const projector = createChannelStreamProjector({ maxProgressChars: 5 });

    projector.apply(commentary("123456789", "m1"));
    projector.apply({ type: "text_delta", text: "final-result" });

    expect(projector.snapshot().progress).toBe("56789");
    expect(projector.snapshot().result).toBe("final-result");
  });

  it("keeps thinking and progress live but excludes them from final text", () => {
    const projector = createChannelStreamProjector({ showThinking: true });

    projector.apply({ type: "thought_delta", text: "内部分析" });
    projector.apply(commentary("正在处理", "m1"));
    projector.apply({
      type: "text_delta",
      phase: "final_answer",
      messageId: "final-1",
      text: "已处理完成",
    });

    const snapshot = projector.snapshot();
    expect(snapshot.liveText).toContain("内部分析");
    expect(snapshot.liveText).toContain("**最新进度**\n正在处理");
    expect(snapshot.liveText).toContain("已处理完成");
    expect(snapshot.finalText).toBe("已处理完成");
  });

  it("hides thinking when disabled and keeps errors in the final text", () => {
    const projector = createChannelStreamProjector({ showThinking: false });

    projector.apply({ type: "thought_delta", text: "不能泄漏" });
    projector.apply({ type: "tool_start", toolCallId: "t1", name: "Read" });
    projector.apply({ type: "error", message: "boom" });

    const snapshot = projector.snapshot();
    expect(snapshot.thinking).toBe("");
    expect(snapshot.liveText).not.toContain("不能泄漏");
    expect(snapshot.liveText).not.toContain("Read");
    expect(snapshot.finalText).toContain("boom");
  });

  it("returns the configured empty final text", () => {
    const projector = createChannelStreamProjector({
      emptyFinalText: "empty",
    });

    expect(projector.snapshot().finalText).toBe("empty");
  });

  it("is deterministic for the same ordered events", () => {
    const events: AgentEvent[] = [
      commentary("你好", "m1"),
      { type: "tool_start", toolCallId: "t1", name: "Read" },
      commentary("你好，我来处理", "m1"),
      { type: "text_delta", text: "完成" },
    ];
    const left = createChannelStreamProjector();
    const right = createChannelStreamProjector();

    for (const event of events) {
      left.apply(event);
      right.apply(event);
    }

    expect(left.snapshot()).toEqual(right.snapshot());
  });
});
