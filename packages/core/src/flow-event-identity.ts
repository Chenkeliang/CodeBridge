export interface FlowProjectionEventIdentity {
  type: string;
  executionKind: "agent" | "flow" | null;
  payload: Record<string, unknown>;
}

const RUN_SCOPED_FLOW_EVENTS = new Set([
  "STEP_STARTED",
  "STEP_RETRYING",
  "STEP_SUCCEEDED",
  "STEP_FAILED",
  "STEP_SKIPPED",
  "ARTIFACT_CREATED",
  "VERIFICATION_FAILED",
  "APPROVAL_REQUESTED",
  "APPROVAL_GRANTED",
  "APPROVAL_REJECTED",
]);

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function isFlowProjectionEvent(
  event: FlowProjectionEventIdentity,
): boolean {
  if (event.type.startsWith("FLOW_BATCH_")) {
    return nonEmptyString(event.payload.flow_id)
      && nonEmptyString(event.payload.definition_revision);
  }
  if (event.type === "PARAM_RESOLVED") {
    return nonEmptyString(event.payload.flow_id)
      && nonEmptyString(event.payload.flow_revision);
  }
  if (event.type === "RUN_SNAPSHOT") {
    return event.executionKind === "flow"
      && nonEmptyString(event.payload.flow_id)
      && nonEmptyString(event.payload.flow_revision);
  }
  return event.executionKind === "flow"
    && RUN_SCOPED_FLOW_EVENTS.has(event.type);
}
