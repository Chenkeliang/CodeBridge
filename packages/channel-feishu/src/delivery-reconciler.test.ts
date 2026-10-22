import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuDeliveryReconciler } from "./delivery-reconciler.js";

afterEach(() => vi.useRealTimers());

describe("FeishuDeliveryReconciler", () => {
  it("runs immediately, on each tick, and stops cleanly", async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn(async () => {});
    const reconciler = new FeishuDeliveryReconciler({
      intervalMs: 15_000,
      reconcile,
      onError: vi.fn(),
    });

    reconciler.start();
    await vi.runAllTicks();
    expect(reconcile).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcile).toHaveBeenCalledTimes(3);

    reconciler.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcile).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent triggers into one follow-up pass", async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const reconcile = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined);
    const reconciler = new FeishuDeliveryReconciler({
      intervalMs: 15_000,
      reconcile,
      onError: vi.fn(),
    });

    reconciler.start();
    const triggered = reconciler.trigger();
    void reconciler.trigger();
    expect(reconcile).toHaveBeenCalledTimes(1);

    release();
    await triggered;
    expect(reconcile).toHaveBeenCalledTimes(2);
    reconciler.stop();
  });

  it("reports a failed pass and remains usable", async () => {
    const onError = vi.fn();
    const reconcile = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const reconciler = new FeishuDeliveryReconciler({
      intervalMs: 15_000,
      reconcile,
      onError,
    });

    reconciler.start();
    await reconciler.trigger();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
    reconciler.stop();
  });
});
