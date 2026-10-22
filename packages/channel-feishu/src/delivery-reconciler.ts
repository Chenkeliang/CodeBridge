export interface FeishuDeliveryReconcilerOptions {
  intervalMs: number;
  reconcile(): Promise<void>;
  onError(error: unknown): void;
}

/** Bridge 级唯一对账协调器：串行执行，并把并发触发合并为一次补跑。 */
export class FeishuDeliveryReconciler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private rerunRequested = false;
  private stopped = true;

  constructor(private readonly options: FeishuDeliveryReconcilerOptions) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.trigger();
    this.timer = setInterval(() => void this.trigger(), this.options.intervalMs);
    this.timer.unref?.();
  }

  trigger(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) {
      this.rerunRequested = true;
      return this.inFlight;
    }

    this.inFlight = this.runPasses();
    return this.inFlight;
  }

  stop(): void {
    this.stopped = true;
    this.rerunRequested = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async runPasses(): Promise<void> {
    try {
      do {
        this.rerunRequested = false;
        try {
          await this.options.reconcile();
        } catch (error) {
          this.options.onError(error);
        }
      } while (!this.stopped && this.rerunRequested);
    } finally {
      this.inFlight = undefined;
    }
  }
}
