import { describe, expect, it } from "vitest";
import { applyFlowEvent } from "./flow-events";
import type { SessionEvent, TimelineTurnView } from "./types";

function turn(runId: string): TimelineTurnView {
  return { timeline_index: 0, turn_id: runId, run_id: runId, status: "running", blocks: [] };
}

function event(partial: Partial<SessionEvent> & { type: string }): SessionEvent {
  return {
    event_id: "e", sequence: 1, run_id: "run_1", occurred_at: "2026-08-19T00:00:00.000Z",
    execution_kind: "flow",
    payload: {}, ...partial,
  } as SessionEvent;
}

describe("applyFlowEvent", () => {
  it("ignores STEP events from an Agent Run", () => {
    const input = [turn("run_1")];
    const output = applyFlowEvent(input, event({
      type: "STEP_STARTED",
      execution_kind: "agent",
      target: "run_1",
    }));

    expect(output).toBe(input);
  });

  it("starts a flow_step block on STEP_STARTED and completes it on STEP_SUCCEEDED", () => {
    let turns = [turn("run_1")];
    turns = applyFlowEvent(turns, event({ type: "STEP_STARTED", target: "echo", payload: { capability_id: "demo.echo", risk: "read_only" } }));
    expect(turns[0]!.blocks.at(-1)).toMatchObject({ kind: "flow_step", status: "running", metadata: { step_id: "echo", capability_id: "demo.echo" } });
    turns = applyFlowEvent(turns, event({ type: "STEP_SUCCEEDED", target: "echo" }));
    expect(turns[0]!.blocks.at(-1)).toMatchObject({ kind: "flow_step", status: "passed" });
  });

  it("merges STEP_SUCCEEDED onto the started block without dropping capability_id", () => {
    let turns = [turn("run_1")];
    turns = applyFlowEvent(turns, event({
      type: "STEP_STARTED", target: "echo",
      payload: { capability_id: "demo.echo", risk: "read_only" },
    }));
    turns = applyFlowEvent(turns, event({ type: "STEP_SUCCEEDED", target: "echo" }));
    expect(turns[0]!.blocks.at(-1)).toMatchObject({
      kind: "flow_step",
      status: "passed",
      metadata: { step_id: "echo", capability_id: "demo.echo" },
    });
  });

  it("marks a retrying step and then fails it", () => {
    let turns = [turn("run_1")];
    turns = applyFlowEvent(turns, event({ type: "STEP_STARTED", target: "deliver", payload: { capability_id: "equity.deliver" } }));
    turns = applyFlowEvent(turns, event({ type: "STEP_RETRYING", target: "deliver", payload: { attempt: 1, max_attempts: 2, error: "boom" } }));
    expect(turns[0]!.blocks.at(-1)).toMatchObject({ status: "retrying", metadata: { attempt: 1 } });
    turns = applyFlowEvent(turns, event({ type: "STEP_FAILED", target: "deliver", payload: { error: "boom" } }));
    expect(turns[0]!.blocks.at(-1)).toMatchObject({ status: "failed", metadata: { error: "boom" } });
  });

  it("records PARAM_RESOLVED on the latest turn when run_id is null", () => {
    const turns = applyFlowEvent([turn("run_1")], event({
      run_id: null,
      execution_kind: null,
      type: "PARAM_RESOLVED",
      payload: {
        flow_id: "flow_demo_echo",
        flow_revision: "sha256:plan",
        field: "text",
        final_value: "hi",
        resolution: "confirmed",
        source: "user",
      },
    }));
    expect(turns[0]!.blocks.at(-1)).toMatchObject({ kind: "flow_param", metadata: { field: "text", final_value: "hi" } });
  });

  it("builds a flow_run block from RUN_SNAPSHOT", () => {
    const turns = applyFlowEvent([turn("run_1")], event({
      type: "RUN_SNAPSHOT",
      payload: {
        flow_id: "flow_demo_echo", flow_revision: "sha256:plan", outcome: "succeeded",
        resolved_inputs: [{ field: "text", value: "hi", source: "user", resolver_version: "v1" }],
        steps: [{ step_id: "echo", capability_id: "demo.echo", capability_revision: "1", output_ref: "artifact://a1", verification_status: "passed" }],
      },
    }));
    expect(turns[0]!.blocks.at(-1)).toMatchObject({ kind: "flow_run", status: "succeeded" });
    const meta = turns[0]!.blocks.at(-1)!.metadata as Record<string, unknown>;
    expect(meta).toMatchObject({ flow_id: "flow_demo_echo", outcome: "succeeded" });
    expect(meta.steps).toHaveLength(1);
  });

  it("records a VERIFICATION_FAILED failure block", () => {
    const turns = applyFlowEvent([turn("run_1")], event({
      type: "VERIFICATION_FAILED",
      target: "concat",
      payload: { step_id: "concat", category: "verification", postcondition: "output.result exists", actual: null, truncated: false },
    }));
    expect(turns[0]!.blocks.at(-1)).toMatchObject({ kind: "flow_failure", status: "failed", metadata: { category: "verification", step_id: "concat" } });
  });

  it("keeps other event types unchanged", () => {
    const input = [turn("run_1")];
    const output = applyFlowEvent(input, event({ type: "MESSAGE_RECEIVED", payload: { message: "hi" } }));
    expect(output).toBe(input);
  });
});
