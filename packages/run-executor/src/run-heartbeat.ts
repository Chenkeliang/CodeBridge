import type { Run } from "@codebridge/work-items";

export class RunHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly options: {
      runId: string;
      owner: string;
      renew: (runId: string, owner: string) => Run | null;
      onLeaseLost: () => void;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.options.renew(this.options.runId, this.options.owner)) {
        this.close();
        this.options.onLeaseLost();
      }
    }, 15_000);
  }

  close(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
