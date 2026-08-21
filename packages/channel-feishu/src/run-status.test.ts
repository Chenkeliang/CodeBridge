import { describe, expect, it } from "vitest";
import {
  createFeishuRunStatus,
  finishFeishuRunStatus,
  recordFeishuRunActivity,
  renderFeishuRunStatus,
} from "./run-status.js";

describe("Feishu run status", () => {
  it("renders live activity and the quiet connection state", () => {
    const status = createFeishuRunStatus(1_000);

    expect(
      recordFeishuRunActivity(
        status,
        { type: "tool_start", toolCallId: "t1", name: "Read" },
        2_000,
      ),
    ).toBe(true);
    expect(renderFeishuRunStatus(status, 3_000)).toContain("🟢 **执行中**");
    expect(renderFeishuRunStatus(status, 3_000)).toContain(
      "当前阶段：工具执行：Read",
    );
    expect(renderFeishuRunStatus(status, 5 * 60_000 + 2_000)).toContain(
      "🟠 **任务连接保持**",
    );
    expect(renderFeishuRunStatus(status, 5 * 60_000 + 2_000)).toContain(
      "最近阶段：工具执行：Read",
    );
  });

  it.each([
    ["succeeded", "✅ **已完成**"],
    ["failed", "❌ **已失败**"],
    ["cancelled", "⏹ **已停止**"],
    ["interrupted", "⚠️ **已中断**"],
  ] as const)("renders and freezes the %s terminal state", (state, title) => {
    const status = createFeishuRunStatus(1_000);
    recordFeishuRunActivity(
      status,
      { type: "text_delta", text: "完成", phase: "final_answer" },
      2_000,
    );

    expect(finishFeishuRunStatus(status, state, 5_000)).toBe(true);
    const rendered = renderFeishuRunStatus(status, 99_000);

    expect(rendered).toContain(`${title} · 总耗时 4 秒`);
    expect(rendered).toContain("最终阶段：生成最终回复");
    expect(rendered).not.toContain("最近确认活动");
  });

  it("keeps the first terminal state and rejects later activity", () => {
    const status = createFeishuRunStatus(1_000);

    expect(finishFeishuRunStatus(status, "succeeded", 5_000)).toBe(true);
    expect(finishFeishuRunStatus(status, "failed", 8_000)).toBe(false);
    expect(
      recordFeishuRunActivity(
        status,
        { type: "tool_start", toolCallId: "t2", name: "Write" },
        9_000,
      ),
    ).toBe(false);

    expect(status.state).toBe("succeeded");
    expect(status.endedAt).toBe(5_000);
    expect(status.phase).toBe("任务启动");
  });
});
