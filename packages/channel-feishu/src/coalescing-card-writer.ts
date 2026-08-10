export class CoalescingCardWriter<T = string> {
  private pending: T | undefined;
  private draining: Promise<void> | undefined;

  constructor(
    private readonly write: (content: T) => Promise<void>,
    private readonly onError?: (error: unknown) => void,
    private readonly mergePending?: (pending: T, next: T) => T,
  ) {}

  enqueue(content: T): void {
    this.pending =
      this.pending !== undefined && this.mergePending
        ? this.mergePending(this.pending, content)
        : content;
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

  private async drain(resolveDrain: () => void): Promise<void> {
    try {
      while (this.pending !== undefined) {
        const content = this.pending;
        this.pending = undefined;
        try {
          await this.write(content);
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
