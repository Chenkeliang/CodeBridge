import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  isBindable,
  isConsumable,
  isManageable,
  type FlowCatalogStore,
  type FlowRecord,
} from "@codebridge/flow-catalog";
import type { CapabilityRegistry, CapabilityRuntime } from "@codebridge/policy";
import { compileWorkflow, definitionHash, validatePostcondition, WorkflowValidationError } from "@codebridge/workflow-engine";
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
  app.get("/v1/flows", (c) => {
    const view = c.req.query("view") ?? "consume";
    if (view !== "manage" && view !== "consume") {
      return c.json({ error: "invalid_flow_view" }, 400);
    }
    const predicate = view === "manage" ? isManageable : isConsumable;
    return c.json({ flows: catalog.list().filter(predicate).map(toApiFlow) });
  });
  app.get("/v1/capabilities", (c) => {
    const capabilities = options.capabilities?.list() ?? [];
    return c.json({
      capabilities: capabilities.map((capability) => ({
        id: capability.id,
        adapter: capability.adapter,
        risk: capability.risk,
        description: capability.description ?? null,
        side_effects: capability.side_effects ?? null,
      })),
    });
  });
  app.get("/v1/flows/:flow_id", (c) => {
    const flow = catalog.get(c.req.param("flow_id"));
    return flow ? c.json(toApiFlow(flow)) : c.json({ error: "flow_not_found" }, 404);
  });
  app.get("/v1/flows/:flow_id/review-context", (c) => {
    const flow = catalog.get(c.req.param("flow_id"));
    if (!flow) return c.json({ error: "flow_not_found" }, 404);
    const provenance = flow.provenance;
    const base = provenance
      ? catalog.getRevision(provenance.sourceFlowId, provenance.sourceDefinitionRevision)
      : flow.parentFlowId ? catalog.get(flow.parentFlowId) : undefined;
    return c.json({
      flow: toApiFlow(flow),
      base: base ? toApiFlow(base) : null,
      diff: semanticDiff(base, flow),
      provenance: toApiProvenance(provenance),
      evidence: flowEvidence(flow, options.events),
      history: catalog.history(flow.flowId).map((entry) => ({
        id: entry.id,
        flow_id: entry.flowId,
        definition_revision: entry.definitionRevision,
        action: entry.action,
        snapshot: toApiFlow(entry.snapshot),
        created_at: entry.createdAt,
      })),
    });
  });
  app.post("/v1/flows/:flow_id/apply", async (c) => {
    if (!options.sessions) return c.json({ error: "session_catalog_unavailable" }, 503);
    const flow = catalog.get(c.req.param("flow_id"));
    if (!flow) return c.json({ error: "flow_not_found" }, 404);
    if (!isBindable(flow)) return c.json({ error: "flow_not_bindable" }, 409);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const sessionId = typeof body?.session_id === "string" ? body.session_id : undefined;
    if (!sessionId) return c.json({ error: "session_id is required" }, 400);
    const session = options.sessions.getSession(sessionId);
    if (!session) return c.json({ error: "session_not_found" }, 404);
    options.sessions.bindFlow(session.id, {
      flowId: flow.flowId,
      definitionRevision: flow.definitionRevision,
    });
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
    if (flow.status !== "candidate" || flow.kind !== "runbook") {
      return c.json({ error: "flow_not_reviewable" }, 409);
    }
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
      if (flowEvidence(flow, options.events).length === 0) {
        issues.push("successful dry-run evidence required");
      }
      if (issues.length > 0) {
        return c.json({ error: "flow_not_publishable", issues }, 409);
      }
      if (flow.kind === "runbook" && (!options.capabilities || !options.runtime)) {
        return c.json({ error: "capability_registry_unavailable" }, 409);
      }
    }
    const nextPublicationSequence = decision === "approve"
      ? Math.max(0, ...catalog.listLineage(flow.lineageRootFlowId).map((entry) => entry.publicationSequence)) + 1
      : flow.publicationSequence;
    const reviewed = catalog.save({
      ...flow,
      status: decision === "approve" ? "published" : "candidate",
      source: decision === "approve" ? "git" : flow.source,
      definitionRevision: flow.definitionRevision,
      reviewStatus: decision === "approve" ? "approved" : "rejected",
      gitRevision: decision === "approve" ? String(body!.git_revision) : flow.gitRevision,
      publicationSequence: nextPublicationSequence,
    });
    if (decision === "approve") {
      for (const prior of catalog.listLineage(flow.lineageRootFlowId)) {
        if (prior.flowId !== reviewed.flowId && prior.kind === "runbook" && prior.status === "published") {
          catalog.save({ ...prior, status: "deprecated" });
        }
      }
    }
    return c.json(toApiFlow(reviewed));
  });
  app.post("/v1/flows/:flow_id/deprecate", (c) => {
    const flow = catalog.get(c.req.param("flow_id"));
    if (!flow) return c.json({ error: "flow_not_found" }, 404);
    if (flow.kind !== "runbook" || flow.status !== "published") {
      return c.json({ error: "flow_not_deprecatable" }, 409);
    }
    return c.json(toApiFlow(catalog.save({ ...flow, status: "deprecated" })));
  });
  app.post("/v1/flows/candidates", async (c) => {
    if (!options.sessions) return c.json({ error: "session_catalog_unavailable" }, 503);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.session_id !== "string") {
      return c.json({ error: "session_id is required" }, 400);
    }
    const session = options.sessions.getSession(body.session_id);
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const input = body.flow && typeof body.flow === "object" && !Array.isArray(body.flow)
      ? body.flow as Record<string, unknown>
      : {};
    if (input.kind !== undefined && input.kind !== "runbook") {
      return c.json({ error: "invalid_flow_state" }, 400);
    }
    let derivedFrom: FlowRecord | undefined;
    let provenance: FlowRecord["provenance"] = null;
    if (body.run_id !== undefined) {
      if (typeof body.run_id !== "string" || !body.run_id.trim()) {
        return c.json({ error: "invalid_run_id" }, 400);
      }
      if (!options.events) return c.json({ error: "event_store_unavailable" }, 503);
      const run = options.events.getRun(body.run_id);
      if (!run || run.sessionId !== session.id) return c.json({ error: "run_not_found" }, 404);
      if (run.status !== "succeeded") return c.json({ error: "run_not_succeeded" }, 409);
      const plan = options.events.getPlanForRun(run.id);
      const source = plan ? catalog.get(plan.workflowId) : undefined;
      if (
        !plan
        || plan.source !== "workflow"
        || !source
        || source.kind !== "runbook"
        || source.status !== "published"
        || !source.planIrHash
        || plan.definitionRevision !== source.definitionRevision
        || plan.planIrHash !== source.planIrHash
        || run.workflowRevision !== source.definitionRevision
        || run.planIrHash !== source.planIrHash
      ) {
        return c.json({ error: "run_not_solidifiable" }, 409);
      }
      derivedFrom = source;
      provenance = {
        sourceRunId: run.id,
        sourceSessionId: session.id,
        sourceFlowId: source.flowId,
        sourceDefinitionRevision: source.definitionRevision,
      };
    }
    const flowId = typeof input.flow_id === "string" ? input.flow_id : `flow_${randomUUID().replaceAll("-", "")}`;
    const existing = catalog.get(flowId);
    if (existing && (existing.kind !== "runbook" || existing.status !== "candidate")) {
      return c.json({ error: "flow_id_conflict", flow_id: flowId }, 409);
    }
    const rawSteps = Array.isArray(input.steps)
      ? input.steps
      : derivedFrom ? derivedFrom.steps.map(toWorkflowStep) : [];
    const rawInputs = Array.isArray(input.inputs) ? input.inputs : derivedFrom?.inputs ?? [];
    const source: FlowRecord["source"] = "user_selected";
    const definition = {
      schema_version: 1,
      workflow_id: flowId,
      name: typeof input.name === "string" && input.name.trim()
        ? input.name.trim()
        : derivedFrom?.name ?? existing?.name ?? flowId,
      kind: "runbook" as const,
      status: "draft",
      description: typeof input.description === "string"
        ? input.description
        : input.description === null ? undefined : derivedFrom?.description ?? existing?.description ?? undefined,
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
        source: source === "agent_generated" ? "agent_generated" : "workflow",
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
      description: definition.description ?? null,
      kind: definition.kind,
      status: "candidate",
      source,
      definitionRevision,
      planIrHash,
      inputs: plan.inputs,
      reviewStatus: "pending",
      gitRevision: null,
      validationIssues: [],
      steps,
      lineageRootFlowId: existing?.lineageRootFlowId ?? derivedFrom?.lineageRootFlowId ?? flowId,
      parentFlowId: existing?.parentFlowId ?? derivedFrom?.flowId ?? null,
      provenance: existing?.provenance ?? provenance ?? null,
      publicationSequence: existing?.publicationSequence ?? 0,
    });
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
    description: flow.description,
    kind: flow.kind,
    status: flow.status,
    source: flow.source,
    definition_revision: flow.definitionRevision,
    plan_ir_hash: flow.planIrHash,
    inputs: flow.inputs,
    review_status: flow.reviewStatus,
    git_revision: flow.gitRevision,
    validation_issues: flow.validationIssues,
    lineage_root_flow_id: flow.lineageRootFlowId,
    parent_flow_id: flow.parentFlowId,
    provenance: toApiProvenance(flow.provenance),
    publication_sequence: flow.publicationSequence,
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

function toApiProvenance(provenance: FlowRecord["provenance"]): Record<string, string> | null {
  return provenance ? {
    source_run_id: provenance.sourceRunId,
    source_session_id: provenance.sourceSessionId,
    source_flow_id: provenance.sourceFlowId,
    source_definition_revision: provenance.sourceDefinitionRevision,
  } : null;
}

function toWorkflowStep(step: FlowRecord["steps"][number]): Record<string, unknown> {
  return {
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
  };
}

function semanticDiff(base: FlowRecord | undefined, flow: FlowRecord): Record<string, unknown> {
  const baseInputs = new Map((base?.inputs ?? []).map((input) => [input.id, input]));
  const nextInputs = new Map(flow.inputs.map((input) => [input.id, input]));
  const baseSteps = new Map((base?.steps ?? []).map((step) => [step.id, step]));
  const nextSteps = new Map(flow.steps.map((step) => [step.id, step]));
  const inputIds = new Set([...baseInputs.keys(), ...nextInputs.keys()]);
  const stepIds = new Set([...baseSteps.keys(), ...nextSteps.keys()]);
  const commonBaseOrder = (base?.steps ?? []).map((step) => step.id).filter((id) => nextSteps.has(id));
  const commonNextOrder = flow.steps.map((step) => step.id).filter((id) => baseSteps.has(id));
  return {
    name_changed: (base?.name ?? null) !== flow.name,
    description_changed: (base?.description ?? null) !== flow.description,
    inputs: {
      added: [...inputIds].filter((id) => !baseInputs.has(id)),
      removed: [...inputIds].filter((id) => !nextInputs.has(id)),
      changed: [...inputIds].filter((id) => {
        const before = baseInputs.get(id);
        const after = nextInputs.get(id);
        return before !== undefined && after !== undefined && JSON.stringify(before) !== JSON.stringify(after);
      }),
    },
    steps: {
      added: [...stepIds].filter((id) => !baseSteps.has(id)),
      removed: [...stepIds].filter((id) => !nextSteps.has(id)),
      changed: [...stepIds].filter((id) => {
        const before = baseSteps.get(id);
        const after = nextSteps.get(id);
        return before !== undefined && after !== undefined && JSON.stringify(before) !== JSON.stringify(after);
      }),
      reordered: JSON.stringify(commonBaseOrder) !== JSON.stringify(commonNextOrder),
    },
  };
}

function flowEvidence(flow: FlowRecord, events: SqliteEventStore | undefined): Array<Record<string, unknown>> {
  if (!events || !flow.planIrHash) return [];
  const evidence: Array<Record<string, unknown>> = [];
  for (const workItem of events.listWorkItems()) {
    for (const run of events.listRuns(workItem.id)) {
      if (run.status !== "succeeded") continue;
      const plan = events.getPlanForRun(run.id);
      if (
        plan?.source !== "workflow"
        || plan.workflowId !== flow.flowId
        || plan.definitionRevision !== flow.definitionRevision
        || plan.planIrHash !== flow.planIrHash
        || run.workflowRevision !== flow.definitionRevision
        || run.planIrHash !== flow.planIrHash
      ) continue;
      evidence.push({
        run_id: run.id,
        session_id: run.sessionId,
        status: run.status,
        definition_revision: flow.definitionRevision,
        plan_ir_hash: flow.planIrHash,
        created_at: run.createdAt,
        updated_at: run.updatedAt,
      });
    }
  }
  return evidence.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
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
  const capabilities = options.capabilities;
  const runtime = options.runtime;
  if (!capabilities || !runtime) {
    return issues;
  }
  for (const step of flow.steps) {
    if (isBranchOnlyStep(step) || isManualStep(step)) continue;
    if (flow.kind === "runbook") {
      const successWhen = step.successWhen?.trim();
      if (!successWhen) {
        issues.push(`success_when required: ${step.id}`);
      } else {
        const invalid = validatePostcondition(successWhen);
        if (invalid) issues.push(`invalid success_when for ${step.id}: ${invalid}`);
      }
    }
    const capabilityId = step.capability;
    if (!capabilityId) continue;
    const definition = capabilities.get(capabilityId);
    if (!definition) {
      if (flow.kind === "runbook") {
        issues.push(`capability not registered: ${capabilityId}`);
      }
      continue;
    }
    const adapter = runtime.get(definition.adapter);
    if (definition.source?.kind === "skill" || adapter?.kind === "skill") {
      issues.push(`skill adapters cannot be published: ${capabilityId}`);
    }
    if (flow.kind === "runbook" && !adapter) {
      issues.push(`adapter not registered: ${definition.adapter}`);
    }
  }
  return issues;
}
