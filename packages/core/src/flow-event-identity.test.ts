import { describe, expect, it } from "vitest";
import { isFlowProjectionEvent } from "./flow-event-identity.js";

describe("isFlowProjectionEvent", () => {
  it("rejects generic Agent steps and accepts explicit Flow steps", () => {
    expect(isFlowProjectionEvent({
      type: "STEP_STARTED",
      executionKind: "agent",
      payload: {},
    })).toBe(false);
    expect(isFlowProjectionEvent({
      type: "STEP_STARTED",
      executionKind: "flow",
      payload: {},
    })).toBe(true);
  });

  it("requires complete Flow identity for snapshots and runless parameters", () => {
    expect(isFlowProjectionEvent({
      type: "RUN_SNAPSHOT",
      executionKind: "flow",
      payload: { flow_id: "flow_1" },
    })).toBe(false);
    expect(isFlowProjectionEvent({
      type: "PARAM_RESOLVED",
      executionKind: null,
      payload: { flow_id: "flow_1", flow_revision: "sha256:rev" },
    })).toBe(true);
  });

  it("keeps Flow batch events independent from the source Agent Run", () => {
    expect(isFlowProjectionEvent({
      type: "FLOW_BATCH_UPDATED",
      executionKind: "agent",
      payload: {
        flow_id: "flow_1",
        definition_revision: "sha256:rev",
      },
    })).toBe(true);
  });
});
