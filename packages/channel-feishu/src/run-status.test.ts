import { describe, expect, it } from "vitest";
import {
  applyRunSnapshot,
  createFeishuRunStatus,
  finishFeishuRunStatus,
  recordFeishuRunActivity,
  recordRunVerification,
  renderFeishuRunStatus,
  setCoreEventStream,
} from "./run-status.js";

describe("Feishu run status", () => {
  it("renders live activity and quiet without claiming a connection", () => {
    const status = createFeishuRunStatus(1_000);

    expect(
      recordFeishuRunActivity(
        status,
        { type: "tool_start", toolCallId: "t1", name: "Read" },
        2_000,
      ),
    ).toBe(true);
    recordRunVerification(status, 2_500);
    expect(renderFeishuRunStatus(status, 3_000)).toContain("🟢 **执行中**");
    expect(renderFeishuRunStatus(status, 3_000)).toContain(
      "当前阶段：工具执行：Read",
    );
    expect(renderFeishuRunStatus(status, 5 * 60_000 + 2_000)).toContain(
      "🟠 **任务运行中 · 暂无新事件**",
    );
    expect(renderFeishuRunStatus(status, 5 * 60_000 + 2_000)).toContain(
      "最近阶段：工具执行：Read",
    );
    expect(renderFeishuRunStatus(status, 5 * 60_000 + 2_000)).toContain(
      "最近任务事件：",
    );
    expect(renderFeishuRunStatus(status, 5 * 60_000 + 2_000)).toContain(
      "最近状态核验：",
    );
    expect(renderFeishuRunStatus(status, 5 * 60_000 + 2_000)).not.toContain(
      "任务连接保持",
    );
  });

  it("renders Core SSE reconnecting independently from Runtime state", () => {
    const status = createFeishuRunStatus(1_000);
    recordRunVerification(status, 2_000);
    setCoreEventStream(status, "reconnecting");

    expect(renderFeishuRunStatus(status, 3_000)).toContain(
      "⚠️ **事件流重连中 · 后台任务仍在运行**",
    );
    expect(status.state).toBe("running");
  });

  it("uses persisted Run times and never reverses a terminal snapshot", () => {
    const status = createFeishuRunStatus(90_000);
    expect(applyRunSnapshot(status, {
      status: "succeeded",
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(5_000).toISOString(),
      leaseExpiresAt: null,
      terminalReason: null,
      sessionActiveRunId: null,
      sessionQueueState: "ready",
    }, 91_000)).toBe(true);

    expect(renderFeishuRunStatus(status, 99_000)).toContain(
      "✅ **已完成** · 总耗时 4 秒",
    );
    expect(applyRunSnapshot(status, {
      status: "running",
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(6_000).toISOString(),
      leaseExpiresAt: new Date(60_000).toISOString(),
      terminalReason: null,
      sessionActiveRunId: "run_1",
      sessionQueueState: "ready",
    }, 92_000)).toBe(false);
    expect(status.state).toBe("succeeded");
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
