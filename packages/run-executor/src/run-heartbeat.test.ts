import { afterEach, describe, expect, it, vi } from "vitest";
import { RunHeartbeat } from "./run-heartbeat.js";

afterEach(() => vi.useRealTimers());

describe("RunHeartbeat", () => {
  it("renews every fifteen seconds and stops after close", () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockReturnValue({ id: "run_1" });
    const lost = vi.fn();
    const heartbeat = new RunHeartbeat({
      runId: "run_1",
      owner: "bridge:123",
      renew,
      onLeaseLost: lost,
    });

    heartbeat.start();
    vi.advanceTimersByTime(45_000);
    expect(renew).toHaveBeenCalledTimes(3);
    heartbeat.close();
    vi.advanceTimersByTime(15_000);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(lost).not.toHaveBeenCalled();
  });

  it("reports a lost lease and stops", () => {
    vi.useFakeTimers();
    const lost = vi.fn();
    const heartbeat = new RunHeartbeat({
      runId: "run_1",
      owner: "bridge:123",
      renew: () => null,
      onLeaseLost: lost,
    });

    heartbeat.start();
    vi.advanceTimersByTime(15_000);
    expect(lost).toHaveBeenCalledOnce();
  });
});
