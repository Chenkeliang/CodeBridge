import type { FlowRecord } from "./index.js";

export type FlowState = Pick<FlowRecord, "kind" | "status">;

export class InvalidFlowStateError extends Error {
  readonly code = "invalid_flow_state";

  constructor(message = "invalid Flow kind/status combination") {
    super(message);
    this.name = "InvalidFlowStateError";
  }
}

export function isLegalFlowState(flow: FlowState): boolean {
  if (flow.kind === "guide") return flow.status === "draft";
  if (flow.kind !== "runbook") return false;
  switch (flow.status) {
    case "draft":
    case "candidate":
    case "published":
    case "deprecated":
      return true;
    default:
      return false;
  }
}

export function isManageable(flow: FlowState): boolean {
  return isLegalFlowState(flow);
}

export function isConsumable(flow: FlowState): boolean {
  return flow.kind === "runbook" && flow.status === "published";
}

export const isBindable = isConsumable;
export const isExecutable = isConsumable;

export function isDryRunnable(flow: FlowState): boolean {
  return (
    flow.kind === "runbook" &&
    (flow.status === "candidate" || flow.status === "published")
  );
}
