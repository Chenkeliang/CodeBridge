import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { FlowCatalogStore } from "@codebridge/flow-catalog";
import { compileWorkflow, WorkflowValidationError } from "@codebridge/workflow-engine";

export function createFlowApp(catalog: FlowCatalogStore, token: string) {
  const app = new Hono();
  app.use("/v1/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.get("/v1/flows", (c) => c.json({ flows: catalog.list().map(toApiFlow) }));
  app.get("/v1/flows/:flow_id", (c) => {
    const flow = catalog.get(c.req.param("flow_id"));
    return flow ? c.json(toApiFlow(flow)) : c.json({ error: "flow_not_found" }, 404);
  });
  app.post("/v1/flows/candidates", async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.session_id !== "string" || typeof body.definition_revision !== "string") {
      return c.json({ error: "session_id and definition_revision are required" }, 400);
    }
    const input = body.flow && typeof body.flow === "object" && !Array.isArray(body.flow)
      ? body.flow as Record<string, unknown>
      : {};
    const flowId = typeof input.flow_id === "string" ? input.flow_id : `flow_${randomUUID().replaceAll("-", "")}`;
    const rawSteps = Array.isArray(input.steps) ? input.steps : [];
    const definition = {
      schema_version: 1,
      workflow_id: flowId,
      name: typeof input.name === "string" && input.name.trim() ? input.name : flowId,
      kind: input.kind === "runbook" ? "runbook" : "guide",
      status: "draft",
      steps: rawSteps,
    };
    let plan;
    try {
      plan = compileWorkflow(definition, {
        source: "agent_generated",
        definitionRevision: body.definition_revision,
      });
    } catch (error) {
      if (error instanceof WorkflowValidationError) {
        return c.json({ error: "invalid_flow", issues: error.issues }, 400);
      }
      throw error;
    }
    const steps = plan.steps.map((step) => ({
      id: step.id,
      capability: step.capabilityId ?? undefined,
      purpose: step.purpose ?? undefined,
      dependsOn: step.dependsOn,
      mode: step.risk,
      approval: step.approval,
      branches: step.branches,
    }));
    const flow = catalog.save({
      flowId,
      name: typeof input.name === "string" && input.name.trim() ? input.name : flowId,
      kind: input.kind === "runbook" ? "runbook" : "guide",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: body.definition_revision,
      steps,
    });
    return c.json(toApiFlow(flow), 201);
  });
  return app;
}

function toApiFlow(flow: ReturnType<FlowCatalogStore["get"]>): Record<string, unknown> {
  if (!flow) throw new Error("flow is required");
  return {
    schema_version: flow.schemaVersion,
    flow_id: flow.flowId,
    name: flow.name,
    kind: flow.kind,
    status: flow.status,
    source: flow.source,
    definition_revision: flow.definitionRevision,
    steps: flow.steps.map((step) => ({
      id: step.id,
      capability: step.capability ?? null,
      purpose: step.purpose ?? null,
      depends_on: step.dependsOn ?? [],
      mode: step.mode ?? null,
      approval: step.approval ?? "none",
      branches: step.branches ?? [],
    })),
    created_at: flow.createdAt,
    updated_at: flow.updatedAt,
  };
}
