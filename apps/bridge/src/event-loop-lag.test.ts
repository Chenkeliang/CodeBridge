import { describe, expect, it, vi } from "vitest";
import { detectEventLoopStall, startEventLoopLagMonitor } from "./event-loop-lag.js";

describe("detectEventLoopStall", () => {
  it("warns when the actual gap is at least 5000ms over expected", () => {
    expect(detectEventLoopStall(6_000, 1_000, 5_000)).toEqual({
      stalled: true,
      lagMs: 5_000,
    });
  });

  it("stays silent below the threshold", () => {
    expect(detectEventLoopStall(5_999, 1_000, 5_000)).toEqual({
      stalled: false,
      lagMs: 4_999,
    });
  });
});

describe("startEventLoopLagMonitor", () => {
  it("logs one line with an ISO timestamp and lagMs when the loop stalls", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00.000Z"));
    const warn = vi.fn();
    const monitor = startEventLoopLagMonitor({ warn });

    // 模拟事件循环被同步任务阻塞 6 秒（超过 1000ms 的 tick 间隔 5000ms 以上）。
    vi.setSystemTime(new Date("2026-08-14T00:00:06.000Z"));
    vi.advanceTimersByTime(1_000);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T.*event_loop_stall lagMs=\d+$/,
    );
    monitor.stop();
    vi.useRealTimers();
  });

  it("does not log when ticks stay on schedule", () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const monitor = startEventLoopLagMonitor({ warn });

    vi.advanceTimersByTime(3_000);

    expect(warn).not.toHaveBeenCalled();
    monitor.stop();
    vi.useRealTimers();
  });
});
