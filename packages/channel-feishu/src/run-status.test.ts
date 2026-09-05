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

function expectStableFourLineStatus(rendered: string): string[] {
  const lines = rendered.split("\n");
  expect(lines).toHaveLength(4);
  expect(lines[0]).toMatch(/^任务状态：/);
  expect(lines[1]).toMatch(/^运行时长：/);
  expect(lines[2]).toMatch(/^最近任务事件：/);
  expect(lines[3]).toMatch(/^当前阶段：/);
  return lines;
}

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
    const live = renderFeishuRunStatus(status, 3_000);
    expectStableFourLineStatus(live);
    expect(live).toContain("🟢 **执行中**");
    expect(live).toContain(
      "当前阶段：工具执行：Read",
    );
    const quiet = renderFeishuRunStatus(status, 5 * 60_000 + 2_000);
    expectStableFourLineStatus(quiet);
    expect(quiet).toContain(
      "🟠 **任务运行中 · 暂无新事件**",
    );
    expect(quiet).toContain(
      "当前阶段：工具执行：Read（暂无新事件）",
    );
    expect(quiet).toContain(
      "最近任务事件：",
    );
    expect(quiet).not.toContain("最近状态核验：");
    expect(quiet).not.toContain(
      "任务连接保持",
    );
  });

  it("renders Core SSE reconnecting independently from Runtime state", () => {
    const status = createFeishuRunStatus(1_000);
    recordRunVerification(status, 2_000);
    setCoreEventStream(status, "reconnecting");

    const rendered = renderFeishuRunStatus(status, 3_000);
    expectStableFourLineStatus(rendered);
    expect(rendered).toContain(
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

    const rendered = renderFeishuRunStatus(status, 99_000);
    expectStableFourLineStatus(rendered);
    expect(rendered).toContain("任务状态：✅ **已完成**");
    expect(rendered).toContain("运行时长：4 秒");
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

  it("keeps multiline terminal reasons inside the fourth status line", () => {
    const status = createFeishuRunStatus(1_000);
    applyRunSnapshot(status, {
      status: "failed",
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(5_000).toISOString(),
      leaseExpiresAt: null,
      terminalReason: "request failed\nretry exhausted",
      sessionActiveRunId: null,
      sessionQueueState: "ready",
    }, 5_000);

    const lines = expectStableFourLineStatus(
      renderFeishuRunStatus(status, 99_000),
    );
    expect(lines[3]).toBe("当前阶段：request failed retry exhausted");
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

    expectStableFourLineStatus(rendered);
    expect(rendered).toContain(`任务状态：${title}`);
    expect(rendered).toContain("运行时长：4 秒");
    expect(rendered).toContain("当前阶段：生成最终回复");
    expect(rendered).not.toContain("最近状态核验：");
    expect(rendered).not.toContain("最终阶段：");
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
