import {
  isDryRunnable,
  isExecutable,
  type FlowRecord,
} from "@codebridge/flow-catalog";

export type FlowInvocationSource = "request" | "binding";

export type ResolveFlowInvocationInput = {
  origin: "web" | "channel";
  hasFlowId: boolean;
  requestedFlowId: string | null | undefined;
  requestedDefinitionRevision: string | undefined;
  binding: {
    flowId: string | null;
    definitionRevision: string | null;
  } | null;
  dryRun: boolean;
  getFlow(flowId: string): FlowRecord | null | undefined;
};

export type FlowInvocationErrorBody = {
  error?: string;
  code?: string;
  source?: FlowInvocationSource;
  flow_id?: string;
  expected_definition_revision?: string;
  current_definition_revision?: string;
  requires_confirmation?: boolean;
};

export type FlowInvocationResolution =
  | { kind: "none" }
  | { kind: "unbind" }
  | {
      kind: "flow";
      flow: FlowRecord;
      source: FlowInvocationSource;
      definitionRevision: string;
    }
  | {
      kind: "error";
      status: 400 | 404 | 409;
      body: FlowInvocationErrorBody;
    };

export function resolveFlowInvocation(
  input: ResolveFlowInvocationInput,
): FlowInvocationResolution {
  if (input.hasFlowId && input.requestedFlowId == null) {
    return { kind: "unbind" };
  }

  let flowId: string;
  let expectedRevision: string | undefined;
  let source: FlowInvocationSource;
  if (input.hasFlowId) {
    flowId = input.requestedFlowId!;
    expectedRevision = input.requestedDefinitionRevision;
    source = "request";
  } else {
    if (input.requestedDefinitionRevision !== undefined) {
      return {
        kind: "error",
        status: 400,
        body: { error: "flow_id_required" },
      };
    }
    if (input.origin === "channel" || !input.binding) {
      return { kind: "none" };
    }
    if (!input.binding.flowId || !input.binding.definitionRevision) {
      return {
        kind: "error",
        status: 409,
        body: {
          error: "flow_binding_invalid",
          source: "binding",
          ...(input.binding.flowId ? { flow_id: input.binding.flowId } : {}),
          requires_confirmation: true,
        },
      };
    }
    flowId = input.binding.flowId;
    expectedRevision = input.binding.definitionRevision;
    source = "binding";
  }

  const flow = input.getFlow(flowId);
  if (!flow) {
    return {
      kind: "error",
      status: 404,
      body: { error: "flow_not_found", flow_id: flowId },
    };
  }
  if (expectedRevision !== undefined && expectedRevision !== flow.definitionRevision) {
    return {
      kind: "error",
      status: 409,
      body: {
        code: "flow_revision_mismatch",
        source,
        flow_id: flowId,
        expected_definition_revision: expectedRevision,
        current_definition_revision: flow.definitionRevision,
        requires_confirmation: true,
      },
    };
  }

  const allowed = input.dryRun ? isDryRunnable(flow) : isExecutable(flow);
  if (!allowed) {
    return {
      kind: "error",
      status: 409,
      body: { error: "flow_not_executable", flow_id: flowId },
    };
  }

  return {
    kind: "flow",
    flow,
    source,
    definitionRevision: flow.definitionRevision,
  };
}
