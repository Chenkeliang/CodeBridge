import { describe, expect, it } from "vitest";
import type { FlowKind, FlowStatus } from "./index.js";
import {
  InvalidFlowStateError,
  isBindable,
  isConsumable,
  isDryRunnable,
  isExecutable,
  isLegalFlowState,
  isManageable,
} from "./policy.js";

const legalStates = [
  ["guide", "draft"],
  ["runbook", "draft"],
  ["runbook", "candidate"],
  ["runbook", "published"],
  ["runbook", "deprecated"],
] as const;

const illegalStates = [
  ["guide", "candidate"],
  ["guide", "published"],
  ["guide", "deprecated"],
  ["ephemeral", "draft"],
  ["ephemeral", "candidate"],
  ["ephemeral", "published"],
  ["ephemeral", "deprecated"],
] as const;

function state(kind: FlowKind, status: FlowStatus) {
  return { kind, status };
}

describe("Flow policy", () => {
  it.each(legalStates)("accepts legal %s × %s", (kind, status) => {
    expect(isLegalFlowState(state(kind, status))).toBe(true);
    expect(isManageable(state(kind, status))).toBe(true);
  });

  it.each(illegalStates)("rejects illegal %s × %s", (kind, status) => {
    expect(isLegalFlowState(state(kind, status))).toBe(false);
    expect(isManageable(state(kind, status))).toBe(false);
  });

  it("rejects an unknown runtime status", () => {
    expect(
      isLegalFlowState({ kind: "runbook", status: "unknown" } as never),
    ).toBe(false);
  });

  it("only exposes Published Runbooks for consumption, binding, and execution", () => {
    for (const [kind, status] of legalStates) {
      const expected = kind === "runbook" && status === "published";
      const flow = state(kind, status);
      expect(isConsumable(flow)).toBe(expected);
      expect(isBindable(flow)).toBe(expected);
      expect(isExecutable(flow)).toBe(expected);
    }
  });

  it("only allows Candidate and Published Runbooks to dry-run", () => {
    for (const [kind, status] of [...legalStates, ...illegalStates]) {
      const expected =
        kind === "runbook" &&
        (status === "candidate" || status === "published");
      expect(isDryRunnable(state(kind, status))).toBe(expected);
    }
  });

  it("exposes a stable invalid-state error code", () => {
    expect(new InvalidFlowStateError().code).toBe("invalid_flow_state");
  });
});
