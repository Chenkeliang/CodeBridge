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
});
