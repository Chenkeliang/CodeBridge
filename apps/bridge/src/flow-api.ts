import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { FlowCatalogStore } from "@codebridge/flow-catalog";

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
    const steps = rawSteps
      .filter((step): step is Record<string, unknown> => typeof step === "object" && step !== null && !Array.isArray(step))
      .filter((step) => typeof step.id === "string")
      .map((step) => ({
        id: String(step.id),
        capability: typeof step.capability === "string" ? step.capability : undefined,
        purpose: typeof step.purpose === "string" ? step.purpose : undefined,
        dependsOn: Array.isArray(step.depends_on) ? step.depends_on.filter((id): id is string => typeof id === "string") : undefined,
        mode: typeof step.mode === "string" ? step.mode : undefined,
        approval: step.approval === "required" ? "required" as const : "none" as const,
      }));
    if (!steps.length) return c.json({ error: "flow.steps must contain at least one step" }, 400);
    const flow = catalog.save({
      flowId,
      name: typeof input.name === "string" ? input.name : null,
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
    })),
    created_at: flow.createdAt,
    updated_at: flow.updatedAt,
  };
}
