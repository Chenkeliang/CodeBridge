import { describe, expect, it } from "vitest";
import { CoalescingCardWriter } from "./coalescing-card-writer.js";

describe("CoalescingCardWriter", () => {
  it("does not block producers and only writes the latest queued snapshot", async () => {
    const writes: string[] = [];
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writer = new CoalescingCardWriter(async (content) => {
      writes.push(content);
      if (writes.length === 1) await firstWrite;
    });

    writer.enqueue("checkpoint-1");
    writer.enqueue("checkpoint-2");
    writer.enqueue("checkpoint-3");

    await Promise.resolve();
    expect(writes).toEqual(["checkpoint-3"]);
    releaseFirst();
    await writer.flush();
    expect(writes).toEqual(["checkpoint-3"]);
  });

  it("serializes a reentrant enqueue triggered by the write callback", async () => {
    let writer!: CoalescingCardWriter<string>;
    let inFlight = 0;
    let maxInFlight = 0;
    const writes: string[] = [];
    writer = new CoalescingCardWriter(async (content) => {
      writes.push(content);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (content === "first") writer.enqueue("second");
      await Promise.resolve();
      inFlight -= 1;
    });

    writer.enqueue("first");
    await writer.flush();

    expect(writes).toEqual(["first", "second"]);
    expect(maxInFlight).toBe(1);
  });

  it("lets content-critical metadata dominate a later status-only snapshot", async () => {
    type Snapshot = { content: string; statusOnly: boolean };
    const writes: Snapshot[] = [];
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writer = new CoalescingCardWriter<Snapshot>(
      async (snapshot) => {
        writes.push(snapshot);
        if (writes.length === 1) await firstWrite;
      },
      undefined,
      (pending, next) => ({
        ...next,
        statusOnly: pending.statusOnly && next.statusOnly,
      }),
    );

    writer.enqueue({ content: "initial", statusOnly: false });
    writer.enqueue({ content: "P3", statusOnly: false });
    writer.enqueue({ content: "P3 + status", statusOnly: true });
    releaseFirst();
    await writer.flush();

    expect(writes.at(-1)).toEqual({
      content: "P3 + status",
      statusOnly: false,
    });
  });
});
