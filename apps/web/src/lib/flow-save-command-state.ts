import type { FlowSaveInboxRequest, TimelineBlockView } from "@/lib/types";

export type FlowSaveCommandPhase = "request" | "confirm" | "dismiss";

export type FlowSaveCommandRecord = {
  key: string;
  startedAfterSequence: number;
};

export type FlowSaveActionGateState = {
  phase: "confirm" | "dismiss" | null;
  retry: "confirm" | "dismiss" | null;
  error?: string | null;
};

export function canStartFlowSaveAction(
  state: FlowSaveActionGateState | null | undefined,
  phase: "confirm" | "dismiss",
): boolean {
  if (state?.phase) return false;
  return state?.retry == null || state.retry === phase;
}

export function flowSaveCommandId(
  sessionId: string,
  phase: FlowSaveCommandPhase,
  sourceId: string,
): string {
  return JSON.stringify([sessionId, phase, sourceId]);
}

export function reconcileFlowSaveCommands(input: {
  sessionId: string;
  commands: ReadonlyMap<string, FlowSaveCommandRecord>;
  blocks: readonly TimelineBlockView[];
  canonicalRunIds: ReadonlySet<string>;
}): { commandIds: Set<string>; actionRequestIds: Set<string> } {
  const commandIds = new Set<string>();
  const actionRequestIds = new Set<string>();

  for (const block of input.blocks) {
    if (block.kind !== "flow_save_request") continue;
    if (block.metadata.session_id !== input.sessionId) continue;
    const eventSequence = block.metadata.event_sequence;
    if (typeof eventSequence !== "number" || !Number.isFinite(eventSequence)) continue;

    const sourceRunId = block.metadata.source_run_id;
    if (typeof sourceRunId === "string" && input.canonicalRunIds.has(sourceRunId)) {
      const requestCommandId = flowSaveCommandId(input.sessionId, "request", sourceRunId);
      const requestCommand = input.commands.get(requestCommandId);
      if (requestCommand && eventSequence > requestCommand.startedAfterSequence) {
        commandIds.add(requestCommandId);
      }
    }

    if (!["completed", "failed", "dismissed"].includes(block.status)) continue;
    const requestId = block.metadata.request_id;
    if (typeof requestId !== "string" || !requestId) continue;
    for (const phase of ["confirm", "dismiss"] as const) {
      const actionCommandId = flowSaveCommandId(input.sessionId, phase, requestId);
      const actionCommand = input.commands.get(actionCommandId);
      if (!actionCommand || eventSequence <= actionCommand.startedAfterSequence) continue;
      commandIds.add(actionCommandId);
      actionRequestIds.add(requestId);
    }
  }

  return { commandIds, actionRequestIds };
}

export function reconcileFlowSaveInboxCommands(input: {
  previousRequests: readonly FlowSaveInboxRequest[];
  currentRequests: readonly FlowSaveInboxRequest[];
  commands: ReadonlyMap<string, FlowSaveCommandRecord>;
}): { commandIds: Set<string>; actionRequestIds: Set<string> } {
  const currentIdentities = new Set(input.currentRequests.map((request) =>
    JSON.stringify([request.session_id, request.request_id])
  ));
  const commandIds = new Set<string>();
  const actionRequestIds = new Set<string>();

  for (const request of input.previousRequests) {
    const identity = JSON.stringify([request.session_id, request.request_id]);
    if (currentIdentities.has(identity)) continue;
    for (const phase of ["confirm", "dismiss"] as const) {
      const commandId = flowSaveCommandId(request.session_id, phase, request.request_id);
      if (input.commands.has(commandId)) commandIds.add(commandId);
    }
    actionRequestIds.add(request.request_id);
  }

  return { commandIds, actionRequestIds };
}
