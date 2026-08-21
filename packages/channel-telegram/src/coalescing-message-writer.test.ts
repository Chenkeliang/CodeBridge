import { describe, expect, it } from "vitest";
import { CoalescingMessageWriter } from "./coalescing-message-writer.js";

describe("CoalescingMessageWriter", () => {
  it("keeps only the latest pending text while a write is in flight", async () => {
    const writes: string[] = [];
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writer = new CoalescingMessageWriter(async (text) => {
      writes.push(text);
      if (writes.length === 1) await firstWrite;
    });

    writer.enqueue("checkpoint-1");
    await Promise.resolve();
    writer.enqueue("checkpoint-2");
    writer.enqueue("checkpoint-3");

    expect(writes).toEqual(["checkpoint-1"]);
    releaseFirst();
    await writer.flush();

    expect(writes).toEqual(["checkpoint-1", "checkpoint-3"]);
  });

  it("serializes reentrant writes and reports failures without stopping", async () => {
    const errors: unknown[] = [];
    const writes: string[] = [];
    let writer!: CoalescingMessageWriter;
    writer = new CoalescingMessageWriter(
      async (text) => {
        writes.push(text);
        if (text === "first") {
          writer.enqueue("second");
          throw new Error("transient edit failure");
        }
      },
      (error) => errors.push(error),
    );

    writer.enqueue("first");
    await writer.flush();

    expect(writes).toEqual(["first", "second"]);
    expect(errors).toHaveLength(1);
  });

  it("ignores snapshots enqueued after close", async () => {
    const writes: string[] = [];
    const writer = new CoalescingMessageWriter(async (text) => {
      writes.push(text);
    });

    writer.enqueue("before-close");
    await writer.flush();
    writer.close();
    writer.enqueue("after-close");
    await writer.flush();

    expect(writes).toEqual(["before-close"]);
  });
});
