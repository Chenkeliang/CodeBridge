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
import type { DomainEvent, SqliteEventStore } from "@codebridge/work-items";
import {
  buildCandidateDefinition,
  FlowSaveIntentError,
  type FlowSaveIntentService,
  type FlowSaveRequest,
  type FlowSaveRequestState,
} from "./flow-save-intent.js";
import type {
  FlowSaveInboxRequest,
  FlowSaveInboxService,
} from "./flow-save-inbox.js";

export interface FlowApiOptions {
  sessions?: SessionCatalogStore;
  events?: SqliteEventStore;
  capabilities?: CapabilityRegistry;
  runtime?: CapabilityRuntime;
  flowSaveIntents?: FlowSaveIntentService;
  flowSaveInbox?: FlowSaveInboxService;
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
  app.get("/v1/flow-save-requests", (c) => {
    if (c.req.query("state") !== "pending") {
      return c.json({ error: "flow_save_request_state_invalid" }, 400);
    }
    const limit = parseFlowSaveInboxLimit(c.req.query("limit"));
    if (limit === null) {
      return c.json({ error: "flow_save_request_limit_invalid" }, 400);
    }
    const cursor = parseFlowSaveInboxCursor(c.req.query("cursor"));
    if (cursor === undefined) {
      return c.json({ error: "flow_save_request_cursor_invalid" }, 400);
    }
    if (!options.flowSaveInbox) {
      return c.json({ error: "flow_save_inbox_unavailable" }, 503);
    }
    const page = options.flowSaveInbox.listPending({ limit, cursor });
    return c.json({
      requests: page.requests.map(toApiFlowSaveInboxRequest),
      next_cursor: page.nextCursor ? encodeFlowSaveInboxCursor(page.nextCursor) : null,
    });
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
  app.post("/v1/sessions/:session_id/flow-save-requests", async (c) => {
    const key = c.req.header("idempotency-key")?.trim();
    if (!key) return c.json({ error: "idempotency_key_required" }, 400);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const sourceRunId = typeof body?.source_run_id === "string"
      ? body.source_run_id.trim()
      : "";
    if (!sourceRunId) return c.json({ error: "source_run_id_required" }, 400);
    if (body?.source !== "turn_action") {
      return c.json({ error: "flow_save_request_source_invalid" }, 400);
    }
    if (!options.flowSaveIntents) {
      return c.json({ error: "flow_save_intent_unavailable" }, 503);
    }
    try {
      const request = options.flowSaveIntents.requestManual({
        sessionId: c.req.param("session_id"),
        sourceRunId,
        ...(typeof body.intent_summary === "string"
          ? { intentSummary: body.intent_summary }
          : {}),
        ...(typeof body.name_hint === "string" ? { nameHint: body.name_hint } : {}),
      }, key);
      return c.json(flowSaveStateResponse({ state: "requested", request }), 201);
    } catch (error) {
      if (!(error instanceof FlowSaveIntentError)) throw error;
      const mapped = flowSaveHttpError(error);
      return c.json(mapped.body, mapped.status);
    }
  });
  app.post("/v1/flow-save-requests/:request_id/confirm", async (c) => {
    const key = c.req.header("idempotency-key")?.trim();
    if (!key) return c.json({ error: "idempotency_key_required" }, 400);
    if (!options.flowSaveIntents) {
      return c.json({ error: "flow_save_intent_unavailable" }, 503);
    }
    try {
      const prior = options.flowSaveIntents.getRequestState(c.req.param("request_id"));
      const result = await options.flowSaveIntents.confirm(c.req.param("request_id"), key);
      return c.json({
        state: "completed" as const,
        request: toApiFlowSaveRequest(result.request),
        flow: toApiFlow(result.flow),
      }, prior.state === "completed" ? 200 : 201);
    } catch (error) {
      if (!(error instanceof FlowSaveIntentError)) throw error;
      const mapped = flowSaveHttpError(error);
      return c.json(mapped.body, mapped.status);
    }
  });
  app.post("/v1/flow-save-requests/:request_id/dismiss", (c) => {
    const key = c.req.header("idempotency-key")?.trim();
    if (!key) return c.json({ error: "idempotency_key_required" }, 400);
    if (!options.flowSaveIntents) {
      return c.json({ error: "flow_save_intent_unavailable" }, 503);
    }
    try {
      const state = options.flowSaveIntents.dismiss(c.req.param("request_id"), key);
      return c.json(flowSaveStateResponse(state));
    } catch (error) {
      if (!(error instanceof FlowSaveIntentError)) throw error;
      const mapped = flowSaveHttpError(error);
      return c.json(mapped.body, mapped.status);
    }
  });
  app.get("/v1/sessions/:session_id/flow-proposals", (c) => {
    return c.json({ error: "flow_proposals_deprecated" }, 410);
  });
  app.get("/v1/sessions/:session_id/flow-recommendations", (c) => {
    if (!options.sessions) return c.json({ error: "session_catalog_unavailable" }, 503);
    if (!options.events) return c.json({ error: "event_store_unavailable" }, 503);
    const session = options.sessions.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const workItem = session.taskRecordId
      ? options.events.getWorkItem(session.taskRecordId)
      : options.events.getWorkItemBySessionId(session.id);
    if (!workItem) return c.json({ recommendations: [] });
    const sessionRunIds = new Set(
      options.events.listRuns(workItem.id)
        .filter((run) => run.sessionId === session.id && run.status === "succeeded")
        .map((run) => run.id),
    );
    const events = options.events.listEvents(workItem.id);
    const dismissed = new Set(events.flatMap((event) =>
      event.type === "FLOW_REJECTED"
      && event.payload.source === "recommendation"
      && typeof event.runId === "string"
      && typeof event.target === "string"
        ? [`${event.runId}:${event.target}`]
        : []
    ));
    return c.json({
      recommendations: events
        .filter((event) =>
          event.type === "FLOW_RECOMMENDED"
          && event.runId !== null
          && sessionRunIds.has(event.runId)
        )
        .map((event) => toApiFlowRecommendation(
          event,
          event.runId && dismissed.has(`${event.runId}:${String(event.payload.flow_id)}`)
            ? "dismissed"
            : "pending",
        )),
    });
  });
  app.post("/v1/flows/recommendations", async (c) => {
    if (!options.sessions) return c.json({ error: "session_catalog_unavailable" }, 503);
    if (!options.events) return c.json({ error: "event_store_unavailable" }, 503);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const runId = typeof body?.run_id === "string" ? body.run_id : "";
    const flowId = typeof body?.flow_id === "string" ? body.flow_id : "";
    const revision = typeof body?.definition_revision === "string" ? body.definition_revision : "";
    if (!runId || !flowId || !revision) {
      return c.json({ error: "run_id, flow_id and definition_revision are required" }, 400);
    }
    const run = options.events.getRun(runId);
    if (!run || !run.sessionId || !options.sessions.getSession(run.sessionId)) {
      return c.json({ error: "run_not_found" }, 404);
    }
    if (run.status !== "running" && run.status !== "succeeded") {
      return c.json({ error: "run_not_recommendable" }, 409);
    }
    const flow = catalog.get(flowId);
    if (!flow || !isConsumable(flow)) return c.json({ error: "flow_not_consumable" }, 409);
    if (flow.definitionRevision !== revision) {
      return c.json({ error: "flow_revision_mismatch" }, 409);
    }
    const extracted = recommendationInputs(flow, body?.extracted_inputs);
    const reason = typeof body?.reason === "string"
      ? Array.from(body.reason.trim()).slice(0, 240).join("")
      : "";
    const inputHash = `flow-recommendation:${definitionHash({ runId, flowId, revision, extracted })}`;
    const existing = options.events.listEvents(run.workItemId).find((event) =>
      event.type === "FLOW_RECOMMENDED" && event.inputHash === inputHash
    );
    const event = existing ?? options.events.appendEventOnce({
      workItemId: run.workItemId,
      runId: run.id,
      type: "FLOW_RECOMMENDED",
      actor: "agent",
      target: flow.flowId,
      inputHash,
      payload: {
        session_id: run.sessionId,
        flow_id: flow.flowId,
        definition_revision: flow.definitionRevision,
        reason,
        extracted_inputs: extracted,
      },
    });
    return c.json(toApiFlowRecommendation(event), existing ? 200 : 201);
  });
  app.post("/v1/flows/recommendations/:run_id/dismiss", async (c) => {
    if (!options.sessions) return c.json({ error: "session_catalog_unavailable" }, 503);
    if (!options.events) return c.json({ error: "event_store_unavailable" }, 503);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const sessionId = typeof body?.session_id === "string" ? body.session_id : "";
    const flowId = typeof body?.flow_id === "string" ? body.flow_id : "";
    const run = options.events.getRun(c.req.param("run_id"));
    if (!run || run.sessionId !== sessionId || !flowId) {
      return c.json({ error: "recommendation_not_found" }, 404);
    }
    const recommendation = options.events.listEvents(run.workItemId).find((event) =>
      event.type === "FLOW_RECOMMENDED"
      && event.runId === run.id
      && event.payload.flow_id === flowId
    );
    if (!recommendation) return c.json({ error: "recommendation_not_found" }, 404);
    options.events.appendEventOnce({
      workItemId: run.workItemId,
      runId: run.id,
      type: "FLOW_REJECTED",
      actor: "user",
      target: flowId,
      inputHash: `flow-recommendation-dismiss:${run.id}:${flowId}`,
      payload: { source: "recommendation", flow_id: flowId },
    });
    return c.json({ status: "dismissed", run_id: run.id, flow_id: flowId });
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
  app.post("/v1/flows/guides", async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (body && (Object.hasOwn(body, "session_id") || Object.hasOwn(body, "run_id"))) {
      return c.json({ error: "run_guide_save_deprecated" }, 410);
    }
    const parsed = parseGuideDraft(body?.flow);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const flowId = `flow_${randomUUID().replaceAll("-", "")}`;
    return c.json(toApiFlow(catalog.save({
      flowId,
      ...parsed,
      kind: "guide",
      status: "draft",
      source: "user_selected",
      definitionRevision: guideDefinitionRevision(flowId, parsed),
      planIrHash: null,
      inputs: [],
      reviewStatus: "pending",
      gitRevision: null,
      validationIssues: [],
      lineageRootFlowId: flowId,
      parentFlowId: null,
      provenance: null,
      publicationSequence: 0,
    })), 201);
  });
  app.put("/v1/flows/:flow_id/guide", async (c) => {
    const existing = catalog.get(c.req.param("flow_id"));
    if (!existing) return c.json({ error: "flow_not_found" }, 404);
    if (existing.kind !== "guide" || existing.status !== "draft") {
      return c.json({ error: "flow_not_editable" }, 409);
    }
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const parsed = parseGuideDraft(body?.flow);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    return c.json(toApiFlow(catalog.save({
      ...existing,
      ...parsed,
      definitionRevision: guideDefinitionRevision(existing.flowId, parsed),
    })));
  });
  app.patch("/v1/flows/:flow_id/summary", async (c) => {
    const existing = catalog.get(c.req.param("flow_id"));
    if (!existing) return c.json({ error: "flow_not_found" }, 404);
    if (existing.kind !== "runbook" || existing.status !== "candidate") {
      return c.json({ error: "flow_summary_not_editable" }, 409);
    }
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim() : existing.name;
    if (!name) return c.json({ error: "flow.name is required" }, 400);
    const description = typeof body?.description === "string"
      ? body.description.trim() || null
      : existing.description;
    const next = { ...existing, name, description };
    return c.json(toApiFlow(catalog.save({
      ...next,
      definitionRevision: catalogDefinitionRevision(next),
      reviewStatus: "pending",
      gitRevision: null,
    })));
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
    const guideParent = typeof input.parent_flow_id === "string"
      ? catalog.get(input.parent_flow_id)
      : undefined;
    if (input.parent_flow_id !== undefined && (!guideParent || guideParent.kind !== "guide" || guideParent.status !== "draft")) {
      return c.json({ error: "guide_parent_not_found" }, 409);
    }
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
    const flowId = typeof input.flow_id === "string" && input.flow_id.trim()
      ? input.flow_id
      : `flow_${randomUUID().replaceAll("-", "")}`;
    const existing = catalog.get(flowId);
    if (existing && (existing.kind !== "runbook" || existing.status !== "candidate")) {
      return c.json({ error: "flow_id_conflict", flow_id: flowId }, 409);
    }
    const rawSteps = Array.isArray(input.steps)
      ? input.steps
      : derivedFrom ? derivedFrom.steps.map(toWorkflowStep) : [];
    const rawInputs = Array.isArray(input.inputs) ? input.inputs : derivedFrom?.inputs ?? [];
    const source: FlowRecord["source"] = "user_selected";
    const definition = buildCandidateDefinition({
      flowId,
      name: typeof input.name === "string" && input.name.trim()
        ? input.name.trim()
        : derivedFrom?.name ?? existing?.name ?? flowId,
      description: typeof input.description === "string"
        ? input.description
        : input.description === null ? undefined : derivedFrom?.description ?? existing?.description ?? undefined,
      inputs: rawInputs,
      steps: rawSteps,
    });
    // The server owns revision computation (spec §6.2): a caller-supplied
    // definition_revision is accepted for backward compatibility but ignored.
    const definitionRevision = definitionHash(definition);
    let plan;
    try {
      // A stable planId keeps the compiled IR byte-identical across re-saves of
      // the same definition — the id is an identity, not contract content.
      plan = compileWorkflow(definition, {
        source: "workflow",
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
      lineageRootFlowId: existing?.lineageRootFlowId ?? derivedFrom?.lineageRootFlowId ?? guideParent?.lineageRootFlowId ?? flowId,
      parentFlowId: existing?.parentFlowId ?? derivedFrom?.flowId ?? guideParent?.flowId ?? null,
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

function recommendationInputs(
  flow: FlowRecord,
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const definition of flow.inputs) {
    if (definition.type === "secret_ref" || !Object.hasOwn(source, definition.id)) continue;
    const candidate = source[definition.id];
    if (definition.type === "integer") {
      if (typeof candidate === "number" && Number.isSafeInteger(candidate)) {
        result[definition.id] = candidate;
      }
      continue;
    }
    if (typeof candidate === "string") result[definition.id] = candidate;
  }
  return result;
}

type GuideDraftDefinition = Pick<FlowRecord, "name" | "description" | "steps">;

function parseGuideDraft(value: unknown): GuideDraftDefinition | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "flow is required" };
  }
  const source = value as Record<string, unknown>;
  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name) return { error: "flow.name is required" };
  const rawSteps = Array.isArray(source.steps) ? source.steps : [];
  if (rawSteps.length === 0) return { error: "flow.steps is required" };
  if (rawSteps.length > 24) return { error: "flow.steps exceeds limit" };
  const seen = new Set<string>();
  const steps = rawSteps.flatMap((raw): FlowRecord["steps"] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const step = raw as Record<string, unknown>;
    const id = typeof step.id === "string" ? step.id.trim() : "";
    const purpose = typeof step.purpose === "string" ? step.purpose.trim() : "";
    if (!id || !purpose || seen.has(id)) return [];
    seen.add(id);
    const dependsOn = Array.isArray(step.depends_on)
      ? step.depends_on.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      : [];
    return [{
      id,
      purpose,
      capability: undefined,
      mode: "manual",
      dependsOn,
      approval: "none",
      successWhen: undefined,
    }];
  });
  if (steps.length !== rawSteps.length) {
    return { error: "flow.steps require unique non-empty id and purpose" };
  }
  const stepIds = new Set(steps.map((step) => step.id));
  if (steps.some((step) => step.dependsOn?.some((dependency) => !stepIds.has(dependency)))) {
    return { error: "flow.steps contain unknown dependency" };
  }
  return {
    name,
    description: typeof source.description === "string" ? source.description.trim() || null : null,
    steps,
  };
}

function guideDefinitionRevision(flowId: string, flow: GuideDraftDefinition): string {
  return definitionHash({
    schema_version: 1,
    workflow_id: flowId,
    name: flow.name,
    description: flow.description ?? undefined,
    kind: "guide",
    status: "draft",
    inputs: [],
    steps: flow.steps.map((step) => ({
      id: step.id,
      purpose: step.purpose,
      mode: "manual",
      depends_on: step.dependsOn ?? [],
      approval: "none",
    })),
  });
}

function catalogDefinitionRevision(flow: FlowRecord): string {
  return definitionHash({
    schema_version: flow.schemaVersion,
    workflow_id: flow.flowId,
    name: flow.name ?? undefined,
    description: flow.description ?? undefined,
    kind: flow.kind,
    status: flow.status,
    inputs: flow.inputs,
    steps: flow.steps.map((step) => ({
      id: step.id,
      capability: step.capability,
      purpose: step.purpose,
      mode: step.mode,
      depends_on: step.dependsOn,
      approval: step.approval,
      branches: step.branches,
      retry: step.retry && { max_attempts: step.retry.maxAttempts, delay_ms: step.retry.delayMs },
      success_when: step.successWhen,
    })),
  });
}

function toApiFlowRecommendation(
  event: DomainEvent,
  status: "pending" | "dismissed" = "pending",
): Record<string, unknown> {
  return {
    recommendation_id: event.eventId,
    session_id: event.payload.session_id ?? null,
    run_id: event.runId,
    flow_id: event.payload.flow_id,
    definition_revision: event.payload.definition_revision,
    reason: event.payload.reason ?? "",
    extracted_inputs: event.payload.extracted_inputs ?? {},
    status,
    created_at: event.occurredAt,
  };
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

function toApiFlowSaveRequest(request: FlowSaveRequest): Record<string, unknown> {
  return {
    request_id: request.requestId,
    session_id: request.sessionId,
    request_turn_id: request.requestTurnId,
    request_run_id: request.requestRunId,
    source_turn_id: request.sourceTurnId,
    source_run_id: request.sourceRunId,
    source_title: request.sourceTitle,
    source: request.source,
    user_message: request.userMessage,
    intent_summary: request.intentSummary,
    name_hint: request.nameHint,
    source_imported: request.sourceImported,
    created_at: request.createdAt,
  };
}

function toApiFlowSaveInboxRequest(
  request: FlowSaveInboxRequest,
): Record<string, unknown> {
  return {
    ...toApiFlowSaveRequest(request),
    agent_id: request.agentId,
    session_title: request.sessionTitle,
    event_sequence: request.eventSequence,
  };
}

function parseFlowSaveInboxLimit(value: string | undefined): number | null {
  if (value === undefined) return 50;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 100 ? parsed : null;
}

function parseFlowSaveInboxCursor(
  value: string | undefined,
): { occurredAt: string; eventId: string } | null | undefined {
  if (value === undefined) return null;
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const buffer = Buffer.from(value, "base64url");
    if (buffer.toString("base64url") !== value) return undefined;
    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "event_id,occurred_at"
      || typeof record.occurred_at !== "string"
      || typeof record.event_id !== "string"
      || !record.event_id
    ) return undefined;
    const occurredAt = record.occurred_at;
    const timestamp = new Date(occurredAt);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== occurredAt) {
      return undefined;
    }
    return { occurredAt, eventId: record.event_id };
  } catch {
    return undefined;
  }
}

function encodeFlowSaveInboxCursor(cursor: {
  occurredAt: string;
  eventId: string;
}): string {
  return Buffer.from(JSON.stringify({
    occurred_at: cursor.occurredAt,
    event_id: cursor.eventId,
  })).toString("base64url");
}

function flowSaveStateResponse(state: FlowSaveRequestState): Record<string, unknown> {
  return {
    state: state.state,
    request: toApiFlowSaveRequest(state.request),
    ...(state.state === "completed"
      ? {
          flow_id: state.flowId,
          definition_revision: state.definitionRevision,
        }
      : {}),
    ...(state.state === "failed" ? { code: state.code } : {}),
  };
}

function flowSaveHttpError(error: FlowSaveIntentError): {
  status: 404 | 409 | 503;
  body: { error: string };
} {
  const code = error.code === "flow_save_request_already_completed"
    ? "flow_save_request_state_conflict"
    : error.code;
  return {
    status: error.status,
    body: { error: code },
  };
}

function toApiProvenance(provenance: FlowRecord["provenance"]): Record<string, string> | null {
  return provenance ? {
    source_run_id: provenance.sourceRunId,
    source_session_id: provenance.sourceSessionId,
    source_flow_id: provenance.sourceFlowId,
    source_definition_revision: provenance.sourceDefinitionRevision,
    ...(provenance.sourceRequestId
      ? { source_request_id: provenance.sourceRequestId }
      : {}),
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
