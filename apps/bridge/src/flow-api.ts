import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { FlowCatalogStore, FlowRecord } from "@codebridge/flow-catalog";
import type { CapabilityRegistry, CapabilityRuntime } from "@codebridge/policy";
import { compileWorkflow, definitionHash, WorkflowValidationError } from "@codebridge/workflow-engine";
import type { SessionCatalogStore } from "@codebridge/session-catalog";
import type { SqliteEventStore } from "@codebridge/work-items";

export interface FlowApiOptions {
  sessions?: SessionCatalogStore;
  events?: SqliteEventStore;
  capabilities?: CapabilityRegistry;
  runtime?: CapabilityRuntime;
}

export function createFlowApp(catalog: FlowCatalogStore, token: string, options: FlowApiOptions = {}) {
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
  app.post("/v1/flows/:flow_id/apply", async (c) => {
    if (!options.sessions) return c.json({ error: "session_catalog_unavailable" }, 503);
    const flow = catalog.get(c.req.param("flow_id"));
    if (!flow) return c.json({ error: "flow_not_found" }, 404);
    if (flow.status === "deprecated") return c.json({ error: "flow_deprecated" }, 409);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const sessionId = typeof body?.session_id === "string" ? body.session_id : undefined;
    if (!sessionId) return c.json({ error: "session_id is required" }, 400);
    const session = options.sessions.getSession(sessionId);
    if (!session) return c.json({ error: "session_not_found" }, 404);
    options.sessions.updateSession(session.id, { flowId: flow.flowId });
    if (options.events && session.taskRecordId) {
      options.events.appendEvent({
        workItemId: session.taskRecordId,
        type: "FLOW_SELECTED",
        actor: "user",
        target: flow.flowId,
        payload: { flow_id: flow.flowId, definition_revision: flow.definitionRevision },
      });
    }
    return c.json({
      request_id: `req_${randomUUID().replaceAll("-", "")}`,
      accepted: true,
      session_id: session.id,
      flow_id: flow.flowId,
      definition_revision: flow.definitionRevision,
    });
  });
  app.post("/v1/flows/:flow_id/review", async (c) => {
    const flow = catalog.get(c.req.param("flow_id"));
    if (!flow) return c.json({ error: "flow_not_found" }, 404);
    if (flow.status !== "candidate") return c.json({ error: "flow_not_reviewable" }, 409);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const decision = body?.decision;
    if (decision !== "approve" && decision !== "reject") {
      return c.json({ error: "decision must be approve or reject" }, 400);
    }
    if (decision === "approve" && (typeof body?.git_revision !== "string" || !body.git_revision.trim())) {
      return c.json({ error: "git_revision is required when approving a Flow" }, 400);
    }
    if (decision === "approve") {
      const issues = publishIssues(flow, options);
      if (issues.length > 0) {
        return c.json({ error: "flow_not_publishable", issues }, 409);
      }
      if (flow.kind === "runbook" && (!options.capabilities || !options.runtime)) {
        return c.json({ error: "capability_registry_unavailable" }, 409);
      }
    }
    const reviewed = catalog.save({
      ...flow,
      status: decision === "approve" ? "published" : "candidate",
      source: decision === "approve" ? "git" : flow.source,
      definitionRevision: flow.definitionRevision,
      reviewStatus: decision === "approve" ? "approved" : "rejected",
      gitRevision: decision === "approve" ? String(body!.git_revision) : flow.gitRevision,
    });
    return c.json(toApiFlow(reviewed));
  });
  app.post("/v1/flows/candidates", async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.session_id !== "string") {
      return c.json({ error: "session_id is required" }, 400);
    }
    const input = body.flow && typeof body.flow === "object" && !Array.isArray(body.flow)
      ? body.flow as Record<string, unknown>
      : {};
    const flowId = typeof input.flow_id === "string" ? input.flow_id : `flow_${randomUUID().replaceAll("-", "")}`;
    const rawSteps = Array.isArray(input.steps) ? input.steps : [];
    const rawInputs = Array.isArray(input.inputs) ? input.inputs : [];
    const definition = {
      schema_version: 1,
      workflow_id: flowId,
      name: typeof input.name === "string" && input.name.trim() ? input.name : flowId,
      kind: input.kind === "runbook" ? ("runbook" as const) : ("guide" as const),
      status: "draft",
      inputs: rawInputs,
      steps: rawSteps,
    };
    // The server owns revision computation (spec §6.2): a caller-supplied
    // definition_revision is accepted for backward compatibility but ignored.
    const definitionRevision = definitionHash(definition);
    let plan;
    try {
      // A stable planId keeps the compiled IR byte-identical across re-saves of
      // the same definition — the id is an identity, not contract content.
      plan = compileWorkflow(definition, {
        source: "agent_generated",
        definitionRevision,
        planId: `plan_${flowId}`,
      });
    } catch (error) {
      if (error instanceof WorkflowValidationError) {
        return c.json({ error: "invalid_flow", issues: error.issues }, 400);
      }
      throw error;
    }
    const planIrHash = definitionHash(plan);
    const steps = plan.steps.map((step) => ({
      id: step.id,
      capability: step.capabilityId ?? undefined,
      purpose: step.purpose ?? undefined,
      dependsOn: step.dependsOn,
      mode: step.risk,
      approval: step.approval,
      branches: step.branches,
      retry: step.retry ?? undefined,
      successWhen: step.successWhen ?? undefined,
    }));
    const flow = catalog.save({
      flowId,
      name: definition.name,
      kind: definition.kind,
      status: "candidate",
      source: "agent_generated",
      definitionRevision,
      planIrHash,
      inputs: plan.inputs,
      reviewStatus: "pending",
      validationIssues: [],
      steps,
    });
    const session = options.sessions?.getSession(String(body.session_id));
    if (options.events && session?.taskRecordId) {
      options.events.appendEvent({
        workItemId: session.taskRecordId,
        type: "FLOW_SAVED_AS_CANDIDATE",
        actor: "user",
        target: flow.flowId,
        payload: {
          flow_id: flow.flowId,
          definition_revision: flow.definitionRevision,
          review_status: flow.reviewStatus,
        },
      });
    }
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
    plan_ir_hash: flow.planIrHash,
    inputs: flow.inputs,
    review_status: flow.reviewStatus,
    git_revision: flow.gitRevision,
    validation_issues: flow.validationIssues,
    steps: flow.steps.map((step) => ({
      id: step.id,
      capability: step.capability ?? null,
      purpose: step.purpose ?? null,
      depends_on: step.dependsOn ?? [],
      mode: step.mode ?? null,
      approval: step.approval ?? "none",
      branches: step.branches ?? [],
      retry: step.retry
        ? { max_attempts: step.retry.maxAttempts, delay_ms: step.retry.delayMs }
        : null,
      success_when: step.successWhen ?? null,
    })),
    created_at: flow.createdAt,
    updated_at: flow.updatedAt,
  };
}

function isManualStep(step: FlowRecord["steps"][number]): boolean {
  if (step.mode === "manual") return true;
  const hasBranches = (step.branches?.length ?? 0) > 0;
  return !step.capability && !hasBranches;
}

function isBranchOnlyStep(step: FlowRecord["steps"][number]): boolean {
  return (step.branches?.length ?? 0) > 0 && !step.capability;
}

function publishIssues(flow: FlowRecord, options: FlowApiOptions): string[] {
  const issues: string[] = [];
  if (flow.steps.some(isManualStep)) {
    issues.push("manual steps cannot be published");
  }
  if (flow.kind !== "runbook" || !options.capabilities || !options.runtime) {
    return issues;
  }
  for (const step of flow.steps) {
    if (isBranchOnlyStep(step) || isManualStep(step)) continue;
    const capabilityId = step.capability!;
    const definition = options.capabilities.get(capabilityId);
    if (!definition) {
      issues.push(`capability not registered: ${capabilityId}`);
      continue;
    }
    if (!options.runtime.has(definition.adapter)) {
      issues.push(`adapter not registered: ${definition.adapter}`);
      continue;
    }
    const adapter = options.runtime.get(definition.adapter);
    if (definition.source?.kind === "skill" || adapter?.kind === "skill") {
      issues.push(`skill adapters cannot be published: ${capabilityId}`);
    }
  }
  return issues;
}
