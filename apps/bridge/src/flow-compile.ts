import type { FlowRecord } from "@codebridge/flow-catalog";
import { compileWorkflow, type PlanIR } from "@codebridge/workflow-engine";

export function catalogPlanId(flowId: string): string {
  return `plan_${flowId}`;
}

export function flowRecordToDefinition(flow: FlowRecord): Record<string, unknown> {
  return {
    schema_version: 1,
    workflow_id: flow.flowId,
    name: flow.name ?? flow.flowId,
    kind: flow.kind === "runbook" ? "runbook" : "guide",
    status: "draft",
    inputs: flow.inputs,
    steps: flow.steps.map((step) => ({
      id: step.id,
      capability: step.capability,
      purpose: step.purpose,
      depends_on: step.dependsOn ?? [],
      mode: step.mode,
      approval: step.approval ?? "none",
      branches: step.branches ?? [],
      retry: step.retry
        ? { max_attempts: step.retry.maxAttempts, delay_ms: step.retry.delayMs }
        : undefined,
      success_when: step.successWhen,
    })),
  };
}

export function compileCatalogFlow(flow: FlowRecord): PlanIR {
  return compileWorkflow(flowRecordToDefinition(flow), {
    source: flow.source === "agent_generated" ? "agent_generated" : "workflow",
    definitionRevision: flow.definitionRevision,
    planId: catalogPlanId(flow.flowId),
  });
}
