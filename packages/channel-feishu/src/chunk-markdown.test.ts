import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "./bridge.js";

describe("chunkMarkdown", () => {
  it("短文本原样一块返回", () => {
    expect(chunkMarkdown("hello\nworld", 100)).toEqual(["hello\nworld"]);
  });

  it("每块都 <= maxLen", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkMarkdown(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    // 不丢内容：拼回去（按换行）应能还原全部行
    expect(chunks.join("\n").split("\n").filter(Boolean)).toEqual(
      text.split("\n"),
    );
  });

  it("超长单行被硬切", () => {
    const chunks = chunkMarkdown("x".repeat(250), 100);
    expect(chunks).toEqual(["x".repeat(100), "x".repeat(100), "x".repeat(50)]);
  });

  it("空串返回空数组", () => {
    expect(chunkMarkdown("", 100)).toEqual([]);
  });
});
