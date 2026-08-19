import { describe, expect, it } from "vitest";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import { compileWorkflow, definitionHash } from "@codebridge/workflow-engine";
import {
  catalogPlanId,
  compileCatalogFlow,
  flowRecordToDefinition,
} from "./flow-compile.js";

describe("flow-compile", () => {
  it("recompiles stored steps to the same plan_ir_hash", () => {
    const definition = {
      schema_version: 1,
      workflow_id: "flow_demo_echo",
      name: "demo echo",
      kind: "runbook",
      status: "draft",
      inputs: [{ id: "text", type: "string", source: "user", required: true }],
      steps: [
        { id: "echo", capability: "demo.echo", mode: "read_only", success_when: "output.text exists" },
        {
          id: "concat",
          capability: "demo.concat",
          mode: "read_only",
          depends_on: ["echo"],
          success_when: "output.result exists",
        },
      ],
    };
    const plan = compileWorkflow(definition, {
      source: "workflow",
      definitionRevision: definitionHash(definition),
      planId: catalogPlanId("flow_demo_echo"),
    });
    const store = new FlowCatalogStore(":memory:");
    store.save({
      flowId: "flow_demo_echo",
      name: "demo echo",
      kind: "runbook",
      status: "candidate",
      source: "user_selected",
      definitionRevision: definitionHash(definition),
      planIrHash: definitionHash(plan),
      inputs: plan.inputs,
      steps: plan.steps.map((step) => ({
        id: step.id,
        capability: step.capabilityId ?? undefined,
        purpose: step.purpose ?? undefined,
        dependsOn: step.dependsOn,
        mode: step.risk,
        approval: step.approval,
        branches: step.branches,
        retry: step.retry ?? undefined,
        successWhen: step.successWhen ?? undefined,
      })),
    });
    const flow = store.get("flow_demo_echo")!;
    const again = compileCatalogFlow(flow);
    expect(definitionHash(again)).toBe(flow.planIrHash);
    expect(flowRecordToDefinition(flow).steps[0]).toMatchObject({
      success_when: "output.text exists",
    });
    store.close();
  });

  it("detects catalog step tampering against plan_ir_hash", () => {
    const store = new FlowCatalogStore(":memory:");
    const definition = {
      schema_version: 1,
      workflow_id: "flow_tamper",
      name: "t",
      kind: "runbook",
      status: "draft",
      inputs: [],
      steps: [{ id: "echo", capability: "demo.echo", mode: "read_only", success_when: "output.text exists" }],
    };
    const plan = compileWorkflow(definition, {
      source: "workflow",
      definitionRevision: definitionHash(definition),
      planId: catalogPlanId("flow_tamper"),
    });
    store.save({
      flowId: "flow_tamper",
      name: "t",
      kind: "runbook",
      status: "published",
      source: "user_selected",
      definitionRevision: definitionHash(definition),
      planIrHash: definitionHash(plan),
      inputs: plan.inputs,
      steps: [{ id: "echo", capability: "demo.echo", mode: "read_only", successWhen: "output.text exists" }],
    });
    const flow = store.get("flow_tamper")!;
    flow.steps[0]!.successWhen = "output.missing exists";
    expect(definitionHash(compileCatalogFlow(flow))).not.toBe(flow.planIrHash);
    store.close();
  });
});
