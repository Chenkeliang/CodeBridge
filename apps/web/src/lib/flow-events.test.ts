import { describe, expect, it } from "vitest";
import { applyFlowEvent, applyFlowSaveIntentEvent } from "./flow-events";
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

describe("applyFlowSaveIntentEvent", () => {
  it("projects requested and terminal events onto one stable block", () => {
    let turns = [turn("run_1")];
    turns = applyFlowSaveIntentEvent(turns, event({
      type: "FLOW_SAVE_REQUESTED",
      execution_kind: "agent",
      sequence: 10,
      payload: {
        request_id: "fsr_one",
        source_run_id: "run_source",
        source_imported: false,
      },
    }));
    expect(turns[0]!.blocks).toHaveLength(1);
    expect(turns[0]!.blocks[0]).toMatchObject({
      block_id: "flow_save:fsr_one",
      kind: "flow_save_request",
      status: "pending",
      metadata: {
        request_id: "fsr_one",
        source_run_id: "run_source",
        source_imported: false,
      },
    });

    turns = applyFlowSaveIntentEvent(turns, event({
      type: "FLOW_SAVE_DISMISSED",
      execution_kind: "agent",
      sequence: 11,
      payload: { request_id: "fsr_one", source_run_id: "run_source" },
    }));
    expect(turns[0]!.blocks).toHaveLength(1);
    expect(turns[0]!.blocks[0]).toMatchObject({
      block_id: "flow_save:fsr_one",
      status: "dismissed",
    });

    turns = applyFlowSaveIntentEvent(turns, event({
      type: "FLOW_SAVE_FAILED",
      execution_kind: "agent",
      sequence: 12,
      payload: {
        request_id: "fsr_one",
        source_run_id: "run_source",
        code: "source_run_not_extractable",
      },
    }));
    expect(turns[0]!.blocks).toHaveLength(1);
    expect(turns[0]!.blocks[0]).toMatchObject({
      block_id: "flow_save:fsr_one",
      status: "failed",
      metadata: {
        request_id: "fsr_one",
        source_run_id: "run_source",
        source_imported: false,
        code: "source_run_not_extractable",
      },
    });

    turns = applyFlowSaveIntentEvent(turns, event({
      type: "FLOW_CANDIDATE_CREATED",
      execution_kind: "agent",
      sequence: 13,
      payload: {
        request_id: "fsr_one",
        source_run_id: "run_source",
        flow_id: "flow_candidate",
        definition_revision: "sha256:definition",
      },
    }));
    expect(turns[0]!.blocks).toHaveLength(1);
    expect(turns[0]!.blocks[0]).toMatchObject({
      block_id: "flow_save:fsr_one",
      status: "completed",
      metadata: {
        request_id: "fsr_one",
        source_run_id: "run_source",
        source_imported: false,
        flow_id: "flow_candidate",
        definition_revision: "sha256:definition",
      },
    });
  });

  it("does not let an older event regress a completed request", () => {
    let turns = [turn("run_1")];
    turns = applyFlowSaveIntentEvent(turns, event({
      type: "FLOW_SAVE_REQUESTED",
      execution_kind: "agent",
      sequence: 10,
      payload: { request_id: "fsr_one", source_run_id: "run_source" },
    }));
    turns = applyFlowSaveIntentEvent(turns, event({
      type: "FLOW_CANDIDATE_CREATED",
      execution_kind: "agent",
      sequence: 12,
      payload: { request_id: "fsr_one", flow_id: "flow_candidate" },
    }));
    const completed = turns;

    turns = applyFlowSaveIntentEvent(turns, event({
      type: "FLOW_SAVE_DISMISSED",
      execution_kind: "agent",
      sequence: 11,
      payload: { request_id: "fsr_one" },
    }));

    expect(turns).toBe(completed);
    expect(turns[0]!.blocks[0]?.status).toBe("completed");
  });

  it("updates an existing request across windowed Turns but never falls back to the latest Turn", () => {
    const current = turn("run_current");
    current.turn_id = "turn_current";
    const unmatched = event({
      type: "FLOW_SAVE_REQUESTED",
      execution_kind: "agent",
      run_id: "run_old",
      sequence: 20,
      payload: {
        request_id: "fsr_windowed",
        request_turn_id: "turn_old",
        source_run_id: "run_source",
      },
    });

    const unmatchedInput = [current];
    const unchanged = applyFlowSaveIntentEvent(unmatchedInput, unmatched);
    expect(unchanged).toBe(unmatchedInput);
    expect(unchanged[0]!.blocks).toHaveLength(0);

    const withExisting = [
      {
        ...current,
        blocks: [{
          block_id: "flow_save:fsr_windowed",
          block_index: 0,
          kind: "flow_save_request" as const,
          status: "pending",
          metadata: {
            request_id: "fsr_windowed",
            source_run_id: "run_source",
            event_sequence: 19,
          },
          segments: [],
          next_segment_cursor: null,
        }],
      },
    ];
    const updated = applyFlowSaveIntentEvent(withExisting, event({
      type: "FLOW_SAVE_DISMISSED",
      execution_kind: "agent",
      run_id: "run_old",
      sequence: 21,
      payload: { request_id: "fsr_windowed", source_run_id: "run_source" },
    }));
    expect(updated[0]!.blocks).toHaveLength(1);
    expect(updated[0]!.blocks[0]).toMatchObject({
      block_id: "flow_save:fsr_windowed",
      status: "dismissed",
    });

    const createdByTurnId = applyFlowSaveIntentEvent([current], event({
      type: "FLOW_SAVE_REQUESTED",
      execution_kind: "agent",
      run_id: "run_old",
      sequence: 22,
      payload: {
        request_id: "fsr_by_turn",
        request_turn_id: "turn_current",
        source_run_id: "run_source",
      },
    }));
    expect(createdByTurnId[0]!.blocks[0]?.block_id).toBe("flow_save:fsr_by_turn");
  });

  it("bounds display fields without dropping Flow save identity or terminal metadata", () => {
    const large = "x".repeat(17_000);
    let turns = [turn("run_1")];
    turns = applyFlowSaveIntentEvent(turns, event({
      type: "FLOW_SAVE_REQUESTED",
      execution_kind: "agent",
      sequence: 30,
      payload: {
        request_id: "fsr_large",
        request_turn_id: "run_1",
        source_run_id: "run_source",
        source_imported: true,
        user_message: large,
        intent_summary: large,
        name_hint: large,
      },
    }));
    turns = applyFlowSaveIntentEvent(turns, event({
      type: "FLOW_SAVE_FAILED",
      execution_kind: "agent",
      sequence: 31,
      payload: {
        request_id: "fsr_large",
        source_run_id: "run_source",
        code: "source_run_not_extractable",
      },
    }));

    const block = turns[0]!.blocks[0]!;
    expect(block.status).toBe("failed");
    expect(block.metadata).toMatchObject({
      request_id: "fsr_large",
      source_run_id: "run_source",
      source_imported: true,
      status: "failed",
      error_code: "source_run_not_extractable",
      truncated: true,
    });
    expect(String(block.metadata.user_message)).toHaveLength(2_048);
    expect(String(block.metadata.intent_summary)).toHaveLength(2_048);
    expect(String(block.metadata.name_hint)).toHaveLength(2_048);

    let candidateTurns = [turn("run_1")];
    candidateTurns = applyFlowSaveIntentEvent(candidateTurns, event({
      type: "FLOW_SAVE_REQUESTED",
      execution_kind: "agent",
      sequence: 40,
      payload: {
        request_id: "fsr_large_candidate",
        request_turn_id: "run_1",
        source_run_id: "run_source",
        source_imported: false,
        user_message: large,
        intent_summary: large,
        name_hint: large,
      },
    }));
    candidateTurns = applyFlowSaveIntentEvent(candidateTurns, event({
      type: "FLOW_CANDIDATE_CREATED",
      execution_kind: "agent",
      sequence: 41,
      payload: {
        request_id: "fsr_large_candidate",
        source_run_id: "run_source",
        flow_id: "flow_candidate",
        definition_revision: "sha256:definition",
      },
    }));
    expect(candidateTurns[0]!.blocks[0]).toMatchObject({
      status: "completed",
      metadata: {
        request_id: "fsr_large_candidate",
        source_run_id: "run_source",
        source_imported: false,
        status: "completed",
        flow_id: "flow_candidate",
        truncated: true,
      },
    });
  });
});
