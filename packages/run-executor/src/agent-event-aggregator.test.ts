import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEventAggregator } from "./agent-event-aggregator.js";

afterEach(() => vi.useRealTimers());

describe("AgentEventAggregator", () => {
  it("coalesces one burst by Run, Block, and delta kind", () => {
    vi.useFakeTimers();
    const emitted: unknown[] = [];
    const aggregator = new AgentEventAggregator({
      runId: "run_1",
      emit: (event) => emitted.push(event),
    });

    aggregator.accept({
      type: "text_delta",
      blockId: "answer",
      phase: "final_answer",
      text: "a",
    });
    aggregator.accept({
      type: "text_delta",
      blockId: "answer",
      phase: "final_answer",
      text: "b",
    });
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(125);
    expect(emitted).toEqual([
      {
        type: "text_delta",
        blockId: "answer",
        phase: "final_answer",
        text: "ab",
      },
    ]);
    aggregator.close();
  });

  it("flushes before semantic boundaries", () => {
    const emitted: Array<{ type: string; text?: string }> = [];
    const aggregator = new AgentEventAggregator({
      runId: "run_1",
      emit: (event) => emitted.push(event),
    });

    aggregator.accept({
      type: "thought_delta",
      blockId: "thought",
      text: "检查",
    });
    aggregator.accept({
      type: "tool_start",
      toolCallId: "tool_1",
      name: "rg",
      input: {},
    });

    expect(emitted.map((event) => event.type)).toEqual([
      "thought_delta",
      "tool_start",
    ]);
    aggregator.close();
  });

  it("splits buffers at four KiB without losing content", () => {
    const emitted: Array<{ type: string; text?: string }> = [];
    const aggregator = new AgentEventAggregator({
      runId: "run_1",
      emit: (event) => emitted.push(event),
    });
    const source = "界".repeat(2_000);
    aggregator.accept({
      type: "text_delta",
      blockId: "answer",
      phase: "final_answer",
      text: source,
    });
    aggregator.close();

    expect(emitted.length).toBeGreaterThan(1);
    expect(emitted.map((event) => event.text ?? "").join(""))
      .toBe(source);
    expect(
      emitted.every(
        (event) =>
          Buffer.byteLength(event.text ?? "", "utf8") <= 4_096,
      ),
    ).toBe(true);
  });

  it("persists before publishing an event", () => {
    const order: string[] = [];
    const aggregator = new AgentEventAggregator({
      runId: "run_1",
      emit: () => {
        order.push("persist");
        order.push("publish");
      },
    });

    aggregator.accept({ type: "done", exitCode: 0 });
    expect(order).toEqual(["persist", "publish"]);
    aggregator.close();
  });
});
