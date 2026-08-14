import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("SessionQueue", () => {
  it("shows position, cancellation, pause recovery, and bounded paging controls", () => {
    const source = readFileSync(new URL("./session-queue.tsx", import.meta.url), "utf8");
    expect(source).toContain("下一轮队列");
    expect(source).toContain("turn.queue_position");
    expect(source).toContain("props.onCancel(turn.turn_id, turn.version)");
    expect(source).toContain("props.onResume(props.runtime.version)");
    expect(source).toContain("data-load-more-queue");
  });
});
