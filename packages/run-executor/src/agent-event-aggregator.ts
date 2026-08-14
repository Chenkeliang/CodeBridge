import type { AgentEvent } from "@codebridge/core";

const FLUSH_MS = 125;
const MAX_BYTES = 4_096;
type Delta = Extract<
  AgentEvent,
  { type: "text_delta" | "thought_delta" }
>;

function deltaKey(runId: string, event: Delta): string {
  return [
    runId,
    event.blockId ?? event.messageId ?? "",
    event.type,
    "phase" in event ? event.phase ?? "" : "",
  ].join(":");
}

export class AgentEventAggregator {
  private buffer: Delta | null = null;
  private key: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly options: {
      runId: string;
      emit: (event: AgentEvent) => void;
    },
  ) {}

  accept(event: AgentEvent): void {
    if (this.closed) throw new Error("AgentEventAggregator is closed");
    if (event.type !== "text_delta" && event.type !== "thought_delta") {
      this.flush();
      this.options.emit(event);
      return;
    }

    const key = deltaKey(this.options.runId, event);
    if (this.buffer && this.key !== key) this.flush();
    if (!this.buffer) {
      this.buffer = { ...event };
      this.key = key;
    } else {
      this.buffer = {
        ...this.buffer,
        text: this.buffer.text + event.text,
      };
    }

    this.flushOversized();
    if (this.buffer && !this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.buffer) return;
    const event = this.buffer;
    this.buffer = null;
    this.key = null;
    this.options.emit(event);
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
  }

  private flushOversized(): void {
    while (
      this.buffer &&
      Buffer.byteLength(this.buffer.text, "utf8") >= MAX_BYTES
    ) {
      const { head, tail } = splitUtf8(this.buffer.text, MAX_BYTES);
      this.options.emit({ ...this.buffer, text: head });
      this.buffer = tail ? { ...this.buffer, text: tail } : null;
    }
  }
}

function splitUtf8(
  value: string,
  maximumBytes: number,
): { head: string; tail: string } {
  let end = Math.min(value.length, maximumBytes);
  while (
    Buffer.byteLength(value.slice(0, end), "utf8") > maximumBytes
  ) {
    end -= 1;
  }
  return { head: value.slice(0, end), tail: value.slice(end) };
}
