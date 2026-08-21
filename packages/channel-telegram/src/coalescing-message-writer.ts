/** Serializes Telegram edits and collapses queued snapshots to the latest text. */
export class CoalescingMessageWriter {
  private pending: string | undefined;
  private draining: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly write: (text: string) => Promise<void>,
    private readonly onError?: (error: unknown) => void,
  ) {}

  enqueue(text: string): void {
    if (this.closed) return;
    this.pending = text;
    if (this.draining) return;

    let resolveDrain!: () => void;
    this.draining = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    queueMicrotask(() => void this.drain(resolveDrain));
  }

  async flush(): Promise<void> {
    while (this.draining || this.pending !== undefined) {
      if (!this.draining) this.enqueue(this.pending!);
      await this.draining;
    }
  }

  close(): void {
    this.closed = true;
    this.pending = undefined;
  }

  private async drain(resolveDrain: () => void): Promise<void> {
    try {
      while (this.pending !== undefined) {
        const text = this.pending;
        this.pending = undefined;
        try {
          await this.write(text);
        } catch (error) {
          this.onError?.(error);
        }
      }
    } finally {
      this.draining = undefined;
      resolveDrain();
      if (this.pending !== undefined) this.enqueue(this.pending);
    }
  }
}
