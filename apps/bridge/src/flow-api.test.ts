import { describe, expect, it } from "vitest";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import {
  CapabilityRegistry,
  CapabilityRuntime,
  registerDemoCapabilities,
  registerEquityCapabilities,
} from "@codebridge/policy";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SqliteEventStore } from "@codebridge/work-items";
import { createFlowApp } from "./flow-api.js";
import {
  extractRunDefinition,
  FlowSaveIntentError,
  FlowSaveIntentService,
} from "./flow-save-intent.js";

function seedWorkflowRun(
  events: SqliteEventStore,
  flow: ReturnType<FlowCatalogStore["get"]>,
  sessionId: string,
  status: "running" | "succeeded" | "failed" = "succeeded",
) {
  if (!flow) throw new Error("flow fixture is required");
  const workItem = events.createWorkItem({
    title: `Run ${flow.flowId}`,
    mode: "auto",
    conversationId: `conv_${flow.flowId}`,
    sessionId,
    workflowId: flow.flowId,
    workflowRevision: flow.definitionRevision,
    riskLevel: "read_only",
  });
  const runId = `run_${flow.flowId}_${events.listWorkItems().length}`;
  const planId = `plan_${runId}`;
  events.savePlan({
    planId,
    source: "workflow",
    workflowId: flow.flowId,
    definitionRevision: flow.definitionRevision,
    planIrHash: flow.planIrHash,
    sessionId,
    runId,
    steps: flow.steps.map((step) => ({
      id: step.id,
      capabilityId: step.capability ?? null,
      risk: step.mode === "workspace_write" || step.mode === "git_write" || step.mode === "production_write" || step.mode === "manual"
        ? step.mode
        : "read_only",
      dependsOn: step.dependsOn ?? [],
      guard: null,
      approval: step.approval ?? "none",
      branches: step.branches ?? [],
      purpose: step.purpose ?? null,
      successWhen: step.successWhen ?? null,
      retry: step.retry ?? null,
    })),
  });
  const run = events.createRun({
    id: runId,
    workItemId: workItem.id,
    sessionId,
    mode: "auto",
    executionKind: "flow",
    planId,
    planIrHash: flow.planIrHash,
    workflowRevision: flow.definitionRevision,
  });
  events.updateRunStatus(run.id, status);
  return events.getRun(run.id)!;
}

function seedAgentRun(
  sessions: SessionCatalogStore,
  events: SqliteEventStore,
  options: {
    agentId: string;
    title: string;
    proposal?: Array<{ id: string; purpose: string }>;
    tools?: string[];
    status?: "succeeded" | "failed";
  },
) {
  const session = sessions.createSession({ agentId: options.agentId });
  const workItem = events.createWorkItem({
    title: options.title,
    mode: "auto",
    conversationId: `conv_${session.id}`,
    sessionId: session.id,
    agentId: options.agentId,
    riskLevel: "read_only",
  });
  sessions.updateSession(session.id, { taskRecordId: workItem.id });
  const runId = `run_${options.agentId}_${events.listWorkItems().length}`;
  events.withSessionTransaction((tx) => {
    tx.ensureRuntime(session.id);
    const turn = tx.insertTurn(session.id, {
      text: options.title,
      attachmentIds: [],
      flowId: null,
      executionKind: "agent",
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    });
    tx.dispatchTurn(turn.turnId, {
      id: runId,
      workItemId: workItem.id,
      sessionId: session.id,
      turnId: turn.turnId,
      agentId: options.agentId,
      mode: "auto",
      executionKind: "agent",
      planId: null,
      planIrHash: null,
      workflowRevision: null,
    });
  });
  const run = events.getRun(runId)!;
  for (const [index, name] of (options.tools ?? []).entries()) {
    events.appendEvent({
      workItemId: workItem.id,
      runId: run.id,
      type: "AGENT_EVENT",
      actor: "adapter",
      target: "tool_start",
      payload: {
        event: {
          type: "tool_start",
          toolCallId: `tool_${index + 1}`,
          name,
        },
      },
    });
  }
  if (options.proposal) {
    events.appendEvent({
      workItemId: workItem.id,
      runId: run.id,
      type: "FLOW_PROPOSED",
      actor: "agent",
      target: `flow_ephemeral_${run.id}`,
      payload: {
        source: "agent_generated",
        definition_revision: `agent:${run.id}`,
        flow: {
          schema_version: 1,
          workflow_id: `flow_ephemeral_${run.id}`,
          name: options.title,
          kind: "guide",
          status: "draft",
          steps: options.proposal.map((step, index) => ({
            ...step,
            mode: "manual",
            depends_on: index ? [options.proposal![index - 1]!.id] : [],
            approval: "none",
          })),
        },
      },
    });
  }
  events.updateRunStatus(run.id, options.status ?? "succeeded");
  return { session: sessions.getSession(session.id)!, workItem, run: events.getRun(run.id)! };
}

describe("flow API", () => {
  it("exposes authenticated and idempotent Flow save request commands", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    try {
      const source = seedAgentRun(sessions, events, {
        agentId: "codex",
        title: "核对订单并生成结论",
        tools: ["Read File", "Search"],
      });
      const flowSaveIntents = new FlowSaveIntentService({ sessions, events, catalog });
      const app = createFlowApp(catalog, "token", {
        sessions,
        events,
        flowSaveIntents,
      });
      const jsonHeaders = {
        authorization: "Bearer token",
        "content-type": "application/json",
      };

      const unauthorized = await app.request(
        `/v1/sessions/${source.session.id}/flow-save-requests`,
        { method: "POST" },
      );
      expect(unauthorized.status).toBe(401);

      const missingKey = await app.request(
        `/v1/sessions/${source.session.id}/flow-save-requests`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ source_run_id: source.run.id, source: "turn_action" }),
        },
      );
      expect(missingKey.status).toBe(400);
      expect(await missingKey.json()).toEqual({ error: "idempotency_key_required" });

      const missingBody = await app.request(
        `/v1/sessions/${source.session.id}/flow-save-requests`,
        {
          method: "POST",
          headers: { ...jsonHeaders, "Idempotency-Key": "request-empty" },
        },
      );
      expect(missingBody.status).toBe(400);
      expect(await missingBody.json()).toEqual({ error: "source_run_id_required" });

      const invalidSource = await app.request(
        `/v1/sessions/${source.session.id}/flow-save-requests`,
        {
          method: "POST",
          headers: { ...jsonHeaders, "Idempotency-Key": "request-invalid-source" },
          body: JSON.stringify({ source_run_id: source.run.id, source: "agent_intent" }),
        },
      );
      expect(invalidSource.status).toBe(400);
      expect(await invalidSource.json()).toEqual({ error: "flow_save_request_source_invalid" });

      for (const action of ["confirm", "dismiss"]) {
        const missingActionKey = await app.request(
          `/v1/flow-save-requests/fsr_missing/${action}`,
          { method: "POST", headers: jsonHeaders },
        );
        expect(missingActionKey.status).toBe(400);
        expect(await missingActionKey.json()).toEqual({ error: "idempotency_key_required" });
      }

      const create = () => app.request(
        `/v1/sessions/${source.session.id}/flow-save-requests`,
        {
          method: "POST",
          headers: { ...jsonHeaders, "Idempotency-Key": "request-one" },
          body: JSON.stringify({ source_run_id: source.run.id, source: "turn_action" }),
        },
      );
      const created = await create();
      expect(created.status).toBe(201);
      const createdBody = await created.json() as {
        state: string;
        request: {
          request_id: string;
          session_id: string;
          source_run_id: string;
          source_title: string;
        };
      };
      expect(createdBody).toMatchObject({
        state: "requested",
        request: {
          session_id: source.session.id,
          source_run_id: source.run.id,
          source_title: "核对订单并生成结论",
          source: "turn_action",
          source_imported: false,
        },
      });
      expect(createdBody.request.request_id).toMatch(/^fsr_/);
      expect(createdBody.request).not.toHaveProperty("requestId");
      expect(createdBody.request).not.toHaveProperty("sourceRunId");

      const repeated = await create();
      expect(repeated.status).toBe(201);
      expect(await repeated.json()).toEqual(createdBody);

      const confirmed = await app.request(
        `/v1/flow-save-requests/${createdBody.request.request_id}/confirm`,
        {
          method: "POST",
          headers: { ...jsonHeaders, "Idempotency-Key": "confirm-one" },
        },
      );
      expect(confirmed.status).toBe(201);
      const confirmedBody = await confirmed.json() as {
        state: string;
        request: { request_id: string };
        flow: { flow_id: string; status: string; provenance: { source_request_id: string } };
      };
      expect(confirmedBody).toMatchObject({
        state: "completed",
        request: { request_id: createdBody.request.request_id },
        flow: {
          status: "candidate",
          provenance: { source_request_id: createdBody.request.request_id },
        },
      });

      const replayed = await app.request(
        `/v1/flow-save-requests/${createdBody.request.request_id}/confirm`,
        {
          method: "POST",
          headers: { ...jsonHeaders, "Idempotency-Key": "confirm-different-transport-key" },
        },
      );
      expect(replayed.status).toBe(200);
      expect(await replayed.json()).toEqual(confirmedBody);
      expect(catalog.list().filter((flow) => flow.provenance?.sourceRequestId === createdBody.request.request_id))
        .toHaveLength(1);

      const completedDismiss = await app.request(
        `/v1/flow-save-requests/${createdBody.request.request_id}/dismiss`,
        {
          method: "POST",
          headers: { ...jsonHeaders, "Idempotency-Key": "dismiss-completed" },
        },
      );
      expect(completedDismiss.status).toBe(409);
      expect(await completedDismiss.json()).toEqual({
        error: "flow_save_request_state_conflict",
      });

      const dismissRequest = await app.request(
        `/v1/sessions/${source.session.id}/flow-save-requests`,
        {
          method: "POST",
          headers: { ...jsonHeaders, "Idempotency-Key": "request-dismiss" },
          body: JSON.stringify({ source_run_id: source.run.id, source: "turn_action" }),
        },
      );
      const dismissRequestBody = await dismissRequest.json() as {
        request: { request_id: string };
      };
      const dismiss = () => app.request(
        `/v1/flow-save-requests/${dismissRequestBody.request.request_id}/dismiss`,
        {
          method: "POST",
          headers: { ...jsonHeaders, "Idempotency-Key": "dismiss-one" },
        },
      );
      const dismissed = await dismiss();
      expect(dismissed.status).toBe(200);
      const dismissedBody = await dismissed.json();
      expect(dismissedBody).toMatchObject({
        state: "dismissed",
        request: { request_id: dismissRequestBody.request.request_id },
      });
      const dismissReplay = await dismiss();
      expect(dismissReplay.status).toBe(200);
      expect(await dismissReplay.json()).toEqual(dismissedBody);

      const dismissedConfirm = await app.request(
        `/v1/flow-save-requests/${dismissRequestBody.request.request_id}/confirm`,
        {
          method: "POST",
          headers: { ...jsonHeaders, "Idempotency-Key": "confirm-dismissed" },
        },
      );
      expect(dismissedConfirm.status).toBe(409);
      expect(await dismissedConfirm.json()).toEqual({
        error: "flow_save_request_already_dismissed",
      });
    } finally {
      catalog.close();
      events.close();
      sessions.close();
    }
  });

  it("maps Flow save request validation and availability failures exactly", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    try {
      const extractable = seedAgentRun(sessions, events, {
        agentId: "codex",
        title: "可提取任务",
        tools: ["Read File", "Search"],
      });
      const unextractable = seedAgentRun(sessions, events, {
        agentId: "codex",
        title: "没有足够证据",
        tools: ["Read File"],
      });
      const failed = seedAgentRun(sessions, events, {
        agentId: "codex",
        title: "失败任务",
        tools: ["Read File", "Search"],
        status: "failed",
      });
      const managementOnly = seedAgentRun(sessions, events, {
        agentId: "codex",
        title: "仅保存管理动作",
        tools: ["codebridge.request_flow_save", "codebridge.request_flow_save"],
      });
      const flowSession = sessions.createSession({ agentId: "codex" });
      const publishedFlow = catalog.save({
        flowId: "flow_api_source",
        name: "Flow Runtime source",
        kind: "runbook",
        status: "published",
        source: "git",
        definitionRevision: "sha256:flow-api-source",
        planIrHash: "sha256:flow-api-source-plan",
        steps: [],
      });
      const flowRun = seedWorkflowRun(events, publishedFlow, flowSession.id);
      const service = new FlowSaveIntentService({ sessions, events, catalog });
      const app = createFlowApp(catalog, "token", {
        sessions,
        events,
        flowSaveIntents: service,
      });
      const post = (sessionId: string, sourceRunId: string, key: string) => app.request(
        `/v1/sessions/${sessionId}/flow-save-requests`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer token",
            "content-type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify({ source_run_id: sourceRunId, source: "turn_action" }),
        },
      );

      const missingSession = await post("sess_missing", extractable.run.id, "missing-session");
      expect(missingSession.status).toBe(404);
      expect(await missingSession.json()).toEqual({ error: "source_run_not_found" });

      const missingSource = await post(extractable.session.id, "run_missing", "missing-source");
      expect(missingSource.status).toBe(404);
      expect(await missingSource.json()).toEqual({ error: "source_run_not_found" });

      const wrongSession = await post(extractable.session.id, unextractable.run.id, "wrong-session");
      expect(wrongSession.status).toBe(404);
      expect(await wrongSession.json()).toEqual({ error: "source_run_not_found" });

      const noEvidence = await post(unextractable.session.id, unextractable.run.id, "unextractable");
      expect(noEvidence.status).toBe(409);
      expect(await noEvidence.json()).toEqual({ error: "source_run_not_extractable" });

      const notSucceeded = await post(failed.session.id, failed.run.id, "not-succeeded");
      expect(notSucceeded.status).toBe(409);
      expect(await notSucceeded.json()).toEqual({ error: "source_run_not_succeeded" });

      const managementSource = await post(
        managementOnly.session.id,
        managementOnly.run.id,
        "management-source",
      );
      expect(managementSource.status).toBe(409);
      expect(await managementSource.json()).toEqual({ error: "source_run_not_extractable" });

      const runtimeSource = await post(flowSession.id, flowRun.id, "runtime-source");
      expect(runtimeSource.status).toBe(409);
      expect(await runtimeSource.json()).toEqual({ error: "source_run_not_extractable" });

      const missingRequest = await app.request("/v1/flow-save-requests/fsr_missing/confirm", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "Idempotency-Key": "confirm-missing",
        },
      });
      expect(missingRequest.status).toBe(404);
      expect(await missingRequest.json()).toEqual({ error: "flow_save_request_not_found" });

      const unavailableService = new FlowSaveIntentService({ sessions, events });
      const unavailableApp = createFlowApp(catalog, "token", {
        sessions,
        events,
        flowSaveIntents: unavailableService,
      });
      const pending = await unavailableApp.request(
        `/v1/sessions/${extractable.session.id}/flow-save-requests`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer token",
            "content-type": "application/json",
            "Idempotency-Key": "catalog-pending",
          },
          body: JSON.stringify({ source_run_id: extractable.run.id, source: "turn_action" }),
        },
      );
      const pendingBody = await pending.json() as { request: { request_id: string } };
      const catalogUnavailable = await unavailableApp.request(
        `/v1/flow-save-requests/${pendingBody.request.request_id}/confirm`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer token",
            "Idempotency-Key": "catalog-confirm",
          },
        },
      );
      expect(catalogUnavailable.status).toBe(503);
      expect(await catalogUnavailable.json()).toEqual({ error: "flow_catalog_unavailable" });
      expect(unavailableService.getRequestState(pendingBody.request.request_id).state).toBe("requested");
    } finally {
      catalog.close();
      events.close();
      sessions.close();
    }
  });

  it("persists a deterministic confirm failure and rejects every stale retry", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    try {
      const source = seedAgentRun(sessions, events, {
        agentId: "codex",
        title: "确认前仍可提取的任务",
        tools: ["Read File", "Search"],
      });
      let sourceRemainsExtractable = true;
      const service = new FlowSaveIntentService({
        sessions,
        events,
        catalog,
        extract: (input) => sourceRemainsExtractable
          ? extractRunDefinition(input)
          : {
              ok: false as const,
              code: "run_not_extractable" as const,
              reason: "来源证据在确认前失效",
            },
      });
      const app = createFlowApp(catalog, "token", {
        sessions,
        events,
        flowSaveIntents: service,
      });
      const commandHeaders = (key: string) => ({
        authorization: "Bearer token",
        "content-type": "application/json",
        "Idempotency-Key": key,
      });

      const requested = await app.request(
        `/v1/sessions/${source.session.id}/flow-save-requests`,
        {
          method: "POST",
          headers: commandHeaders("request-before-invalidation"),
          body: JSON.stringify({ source_run_id: source.run.id, source: "turn_action" }),
        },
      );
      expect(requested.status).toBe(201);
      const requestedBody = await requested.json() as {
        request: { request_id: string };
      };

      sourceRemainsExtractable = false;
      const failedConfirm = await app.request(
        `/v1/flow-save-requests/${requestedBody.request.request_id}/confirm`,
        {
          method: "POST",
          headers: commandHeaders("confirm-after-invalidation"),
        },
      );
      expect(failedConfirm.status).toBe(409);
      const failedBody = await failedConfirm.json();
      expect(failedBody).toEqual({ error: "source_run_not_extractable" });
      expect(failedBody).not.toHaveProperty("sourceRunId");
      expect(service.getRequestState(requestedBody.request.request_id)).toMatchObject({
        state: "failed",
        code: "source_run_not_extractable",
      });
      expect(events.listEventsByTarget(requestedBody.request.request_id)
        .filter((event) => event.type === "FLOW_SAVE_FAILED"))
        .toHaveLength(1);

      for (const action of ["confirm", "dismiss"]) {
        const stale = await app.request(
          `/v1/flow-save-requests/${requestedBody.request.request_id}/${action}`,
          {
            method: "POST",
            headers: commandHeaders(`stale-${action}-key`),
          },
        );
        expect(stale.status).toBe(409);
        expect(await stale.json()).toEqual({
          error: "flow_save_request_state_conflict",
        });
      }
    } finally {
      catalog.close();
      events.close();
      sessions.close();
    }
  });

  it.each([
    {
      domainCode: "future_flow_save_missing",
      domainStatus: 404 as const,
      responseCode: "future_flow_save_missing",
    },
    {
      domainCode: "future_flow_save_unavailable",
      domainStatus: 503 as const,
      responseCode: "future_flow_save_unavailable",
    },
    {
      domainCode: "flow_save_request_already_completed",
      domainStatus: 404 as const,
      responseCode: "flow_save_request_state_conflict",
    },
  ])(
    "uses domain status $domainStatus for $domainCode",
    async ({ domainCode, domainStatus, responseCode }) => {
      const catalog = new FlowCatalogStore(":memory:");
      try {
        const service = {
          requestManual() {
            throw new FlowSaveIntentError(domainCode, domainStatus);
          },
        } as unknown as FlowSaveIntentService;
        const app = createFlowApp(catalog, "token", { flowSaveIntents: service });

        const response = await app.request("/v1/sessions/sess_1/flow-save-requests", {
          method: "POST",
          headers: {
            authorization: "Bearer token",
            "content-type": "application/json",
            "Idempotency-Key": `key-${domainCode}`,
          },
          body: JSON.stringify({ source_run_id: "run_1", source: "turn_action" }),
        });

        expect(response.status).toBe(domainStatus);
        expect(await response.json()).toEqual({ error: responseCode });
      } finally {
        catalog.close();
      }
    },
  );

  it("computes the same Candidate revision as save intent for the same raw definition", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    try {
      const source = seedAgentRun(sessions, events, {
        agentId: "codex",
        title: "核对订单并生成结论",
        tools: ["Read File", "Search"],
      });
      const saveIntent = new FlowSaveIntentService({ sessions, events, catalog });
      const request = saveIntent.requestManual({
        sessionId: source.session.id,
        sourceRunId: source.run.id,
      }, "same-definition-source");
      const confirmed = await saveIntent.confirm(request.requestId, "confirm-source");
      const app = createFlowApp(catalog, "token", { sessions, events });

      const response = await app.request("/v1/flows/candidates", {
        method: "POST",
        headers: { authorization: "Bearer token", "content-type": "application/json" },
        body: JSON.stringify({
          session_id: source.session.id,
          flow: {
            flow_id: confirmed.flow.flowId,
            name: confirmed.flow.name,
            description: confirmed.flow.description,
            inputs: [],
            steps: confirmed.flow.steps.map((step) => ({
              id: step.id,
              purpose: step.purpose,
              depends_on: step.dependsOn,
              mode: "manual",
              approval: "none",
            })),
          },
        }),
      });

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        flow_id: confirmed.flow.flowId,
        definition_revision: confirmed.flow.definitionRevision,
      });
    } finally {
      catalog.close();
      events.close();
      sessions.close();
    }
  });

  it("exposes source_request_id in Candidate provenance", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    catalog.save({
      flowId: "flow-save-request",
      name: "Save Request Candidate",
      kind: "runbook",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: "sha256:save-request",
      provenance: {
        sourceRunId: "run-source",
        sourceSessionId: "sess-source",
        sourceFlowId: "flow-source",
        sourceDefinitionRevision: "sha256:source",
        sourceRequestId: "fsr-source",
      },
      steps: [{ id: "inspect", purpose: "核对来源" }],
    });
    const app = createFlowApp(catalog, "token");

    const response = await app.request("/v1/flows/flow-save-request", {
      headers: { authorization: "Bearer token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      provenance: { source_request_id: "fsr-source" },
    });
    catalog.close();
  });

  it("creates and updates only server-revisioned Guide drafts", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const app = createFlowApp(catalog, "token");
    const headers = { authorization: "Bearer token", "content-type": "application/json" };
    const created = await app.request("/v1/flows/guides", {
      method: "POST",
      headers,
      body: JSON.stringify({ flow: {
        name: "订单排查草稿",
        description: "人工整理",
        steps: [
          { id: "lookup", purpose: "查询订单" },
          { id: "verify", purpose: "核对仓配", depends_on: ["lookup"] },
        ],
      } }),
    });
    expect(created.status).toBe(201);
    const guide = await created.json() as { flow_id: string; definition_revision: string };
    expect(guide).toMatchObject({ kind: "guide", status: "draft", source: "user_selected" });
    expect(guide.definition_revision).toMatch(/^sha256:/);

    const updated = await app.request(`/v1/flows/${guide.flow_id}/guide`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ flow: {
        name: "订单排查草稿 v2",
        description: "更新说明",
        steps: [{ id: "lookup", purpose: "查询并核对订单" }],
      } }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      flow_id: guide.flow_id,
      name: "订单排查草稿 v2",
      kind: "guide",
      status: "draft",
      steps: [{ id: "lookup", capability: null, mode: "manual" }],
    });
    expect(catalog.get(guide.flow_id)?.definitionRevision).not.toBe(guide.definition_revision);
    expect(catalog.list().filter((flow) => flow.flowId === guide.flow_id)).toHaveLength(1);

    const invalid = await app.request("/v1/flows/guides", {
      method: "POST",
      headers,
      body: JSON.stringify({ flow: { name: "空步骤", steps: [{ id: "", purpose: "" }] } }),
    });
    expect(invalid.status).toBe(400);
    catalog.close();
  });

  it("updates only Candidate summary fields with a server revision", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    catalog.save({
      flowId: "flow_candidate_summary", name: "旧名称", description: "旧说明",
      kind: "runbook", status: "candidate", source: "user_selected", definitionRevision: "sha256:old",
      inputs: [], steps: [{ id: "lookup", capability: "demo.echo", mode: "read_only", successWhen: "output exists" }],
    });
    const app = createFlowApp(catalog, "token");
    const response = await app.request("/v1/flows/flow_candidate_summary/summary", {
      method: "PATCH",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ name: "新名称", description: "新说明" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      flow_id: "flow_candidate_summary", name: "新名称", description: "新说明",
      status: "candidate", steps: [{ id: "lookup", capability: "demo.echo" }],
    });
    expect(catalog.get("flow_candidate_summary")?.definitionRevision).toMatch(/^sha256:/);
    expect(catalog.get("flow_candidate_summary")?.definitionRevision).not.toBe("sha256:old");
    catalog.close();
  });

  it("promotes a Guide into a separate Candidate lineage record", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "codex" });
    const guide = catalog.save({
      flowId: "flow_guide_parent", name: "Guide", kind: "guide", status: "draft",
      source: "user_selected", definitionRevision: "sha256:guide",
      steps: [{ id: "lookup", purpose: "查询", mode: "manual", approval: "none" }],
    });
    const app = createFlowApp(catalog, "token", { sessions });
    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        flow: {
          parent_flow_id: guide.flowId, name: "Guide Candidate", kind: "runbook", inputs: [],
          steps: [{ id: "lookup", capability: "demo.echo", purpose: "查询", mode: "read_only", approval: "none", success_when: "output exists" }],
        },
      }),
    });
    expect(response.status).toBe(201);
    const candidate = await response.json() as { flow_id: string };
    expect(candidate.flow_id).not.toBe(guide.flowId);
    expect(catalog.get(candidate.flow_id)).toMatchObject({
      kind: "runbook", status: "candidate", parentFlowId: guide.flowId, lineageRootFlowId: guide.flowId,
    });
    sessions.close();
    catalog.close();
  });

  it("records only validated, idempotent Agent Flow recommendations", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    const fixture = seedAgentRun(sessions, events, {
      agentId: "codex",
      title: "检查订单",
      tools: ["lookup", "verify"],
    });
    catalog.save({
      flowId: "flow_order_check",
      name: "订单核验",
      kind: "runbook",
      status: "published",
      source: "git",
      definitionRevision: "sha256:published",
      inputs: [
        { id: "oid", type: "integer", source: "user", required: true },
        { id: "token", type: "secret_ref", source: "user", required: false },
      ],
      steps: [{ id: "lookup", capability: "demo.echo", mode: "read_only", successWhen: "output exists" }],
    });
    const app = createFlowApp(catalog, "token", { sessions, events });
    const headers = { authorization: "Bearer token", "content-type": "application/json" };
    const body = JSON.stringify({
      run_id: fixture.run.id,
      flow_id: "flow_order_check",
      definition_revision: "sha256:published",
      reason: "用户目标与订单核验一致",
      extracted_inputs: { oid: 1644460, token: "must-not-persist", extra: "ignored" },
    });

    const first = await app.request("/v1/flows/recommendations", { method: "POST", headers, body });
    const duplicate = await app.request("/v1/flows/recommendations", { method: "POST", headers, body });
    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual(await first.json());

    const listed = await app.request(
      `/v1/sessions/${fixture.session.id}/flow-recommendations`,
      { headers },
    );
    const listedBody = await listed.json();
    expect(listedBody).toMatchObject({
      recommendations: [{
        run_id: fixture.run.id,
        flow_id: "flow_order_check",
        definition_revision: "sha256:published",
        status: "pending",
        extracted_inputs: { oid: 1644460 },
      }],
    });
    const serialized = JSON.stringify(listedBody);
    expect(serialized).not.toContain("must-not-persist");

    const dismissed = await app.request(
      `/v1/flows/recommendations/${fixture.run.id}/dismiss`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          session_id: fixture.session.id,
          flow_id: "flow_order_check",
        }),
      },
    );
    expect(dismissed.status).toBe(200);
    const afterDismiss = await app.request(
      `/v1/sessions/${fixture.session.id}/flow-recommendations`,
      { headers },
    );
    expect(await afterDismiss.json()).toMatchObject({
      recommendations: [{ status: "dismissed" }],
    });

    const stale = await app.request("/v1/flows/recommendations", {
      method: "POST",
      headers,
      body: JSON.stringify({
        run_id: fixture.run.id,
        flow_id: "flow_order_check",
        definition_revision: "sha256:stale",
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "flow_revision_mismatch" });

    events.close();
    sessions.close();
    catalog.close();
  });

  it("retires implicit Flow proposals and run-based Guide writes with hard 410 responses", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const app = createFlowApp(catalog, "token");
    const headers = { authorization: "Bearer token", "content-type": "application/json" };

    const proposals = await app.request(
      "/v1/sessions/sess_legacy/flow-proposals",
      { headers },
    );
    expect(proposals.status).toBe(410);
    expect(await proposals.json()).toEqual({ error: "flow_proposals_deprecated" });

    const runBasedGuide = await app.request("/v1/flows/guides", {
      method: "POST",
      headers,
      body: JSON.stringify({
        session_id: "sess_legacy",
        run_id: "run_legacy",
      }),
    });
    expect(runBasedGuide.status).toBe(410);
    expect(await runBasedGuide.json()).toEqual({ error: "run_guide_save_deprecated" });

    const mixedGuide = await app.request("/v1/flows/guides", {
      method: "POST",
      headers,
      body: JSON.stringify({
        session_id: null,
        run_id: "",
        flow: {
          name: "不得由混合合同创建",
          steps: [{ id: "lookup", purpose: "不应写入 Catalog" }],
        },
      }),
    });
    expect(mixedGuide.status).toBe(410);
    expect(await mixedGuide.json()).toEqual({ error: "run_guide_save_deprecated" });
    expect(catalog.list()).toEqual([]);

    catalog.close();
  });

  it("rejects malformed Guide draft bodies without treating them as legacy run saves", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const app = createFlowApp(catalog, "token");
    const headers = { authorization: "Bearer token", "content-type": "application/json" };

    for (const body of [JSON.stringify({}), JSON.stringify({ flow: null }), "{", "null"]) {
      const response = await app.request("/v1/flows/guides", {
        method: "POST",
        headers,
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "flow is required" });
    }
    expect(catalog.list()).toEqual([]);

    catalog.close();
  });

  it("separates management and consumption views behind auth", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    for (const flow of [
      { flowId: "guide-draft", kind: "guide", status: "draft" },
      { flowId: "runbook-draft", kind: "runbook", status: "draft" },
      { flowId: "runbook-candidate", kind: "runbook", status: "candidate" },
      { flowId: "runbook-published", kind: "runbook", status: "published" },
      { flowId: "runbook-deprecated", kind: "runbook", status: "deprecated" },
    ] as const) {
      catalog.save({
        ...flow,
        name: flow.flowId,
        source: "git",
        definitionRevision: `git:${flow.flowId}`,
        steps: [],
      });
    }
    const app = createFlowApp(catalog, "token");
    expect((await app.request("/v1/flows")).status).toBe(401);
    const manage = await app.request("/v1/flows?view=manage", { headers: { authorization: "Bearer token" } });
    expect(manage.status).toBe(200);
    expect((await manage.json() as { flows: Array<{ flow_id: string }> }).flows.map((flow) => flow.flow_id).sort()).toEqual([
      "guide-draft",
      "runbook-candidate",
      "runbook-deprecated",
      "runbook-draft",
      "runbook-published",
    ]);

    const consume = await app.request("/v1/flows?view=consume", { headers: { authorization: "Bearer token" } });
    expect(consume.status).toBe(200);
    expect((await consume.json() as { flows: Array<{ flow_id: string }> }).flows.map((flow) => flow.flow_id)).toEqual([
      "runbook-published",
    ]);

    const safeDefault = await app.request("/v1/flows", { headers: { authorization: "Bearer token" } });
    expect(safeDefault.status).toBe(200);
    expect((await safeDefault.json() as { flows: Array<{ flow_id: string }> }).flows).toEqual([
      expect.objectContaining({ flow_id: "runbook-published" }),
    ]);

    const invalid = await app.request("/v1/flows?view=other", { headers: { authorization: "Bearer token" } });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_flow_view" });
    catalog.close();
  });

  it("saves a Session-generated Flow as a candidate", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    const app = createFlowApp(catalog, "token", { sessions });
    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        definition_revision: "sha256:one",
        flow: {
          flow_id: "flow-candidate",
          name: "当前流程",
          steps: [{
            id: "inspect",
            capability: "context.inspect",
            mode: "read_only",
            retry: { max_attempts: 3, delay_ms: 10 },
          }],
        },
      }),
    });
    expect(response.status).toBe(201);
    expect((await response.json() as { status: string; flow_id: string })).toMatchObject({
      kind: "runbook",
      status: "candidate",
      flow_id: "flow-candidate",
      steps: [{ retry: { max_attempts: 3, delay_ms: 10 } }],
    });
    sessions.close();
    catalog.close();
  });

  it("rejects a candidate with a nonexistent Session before writing the Catalog", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const app = createFlowApp(catalog, "token", { sessions });

    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "sess_missing",
        flow: {
          flow_id: "flow-untraceable",
          steps: [{ id: "inspect", capability: "context.inspect", mode: "read_only" }],
        },
      }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "session_not_found" });
    expect(catalog.get("flow-untraceable")).toBeUndefined();
    sessions.close();
    catalog.close();
  });

  it("does not let a candidate overwrite an existing Published Flow", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    catalog.save({
      flowId: "flow-stable",
      name: "Stable",
      kind: "runbook",
      status: "published",
      source: "git",
      definitionRevision: "sha256:published",
      steps: [{ id: "inspect", capability: "context.inspect", mode: "read_only" }],
    });
    const app = createFlowApp(catalog, "token", { sessions });

    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        flow: {
          flow_id: "flow-stable",
          steps: [{ id: "replace", capability: "context.inspect", mode: "read_only" }],
        },
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "flow_id_conflict",
      flow_id: "flow-stable",
    });
    expect(catalog.get("flow-stable")).toMatchObject({
      status: "published",
      definitionRevision: "sha256:published",
      steps: [expect.objectContaining({ id: "inspect" })],
    });
    sessions.close();
    catalog.close();
  });

  it.each(["guide", "ephemeral"])("rejects an explicit %s candidate kind", async (kind) => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    const app = createFlowApp(catalog, "token", { sessions });
    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        flow: { flow_id: `flow-${kind}`, kind, steps: [] },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_flow_state" });
    expect(catalog.get(`flow-${kind}`)).toBeUndefined();
    sessions.close();
    catalog.close();
  });

  it("rejects a candidate that violates the Workflow DSL", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    const app = createFlowApp(catalog, "token", { sessions });
    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        definition_revision: "sha256:invalid",
        flow: { flow_id: "invalid-flow", steps: [{ id: "release", capability: "release.execute", mode: "production_write" }] },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_flow" });
    expect(catalog.get("invalid-flow")).toBeUndefined();
    sessions.close();
    catalog.close();
  });

  it("requires a Git revision before publishing a candidate", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    const candidate = catalog.save({
      flowId: "flow-review",
      name: "Review me",
      kind: "runbook",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: "sha256:one",
      planIrHash: "sha256:review-plan",
      steps: [],
    });
    seedWorkflowRun(events, candidate, "sess-review");
    const capabilities = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    const app = createFlowApp(catalog, "token", { capabilities, runtime, events });
    const missingRevision = await app.request("/v1/flows/flow-review/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(missingRevision.status).toBe(400);

    const approved = await app.request("/v1/flows/flow-review/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc123" }),
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: "published", review_status: "approved", git_revision: "abc123", definition_revision: "sha256:one" });
    events.close();
    capabilities.close();
    catalog.close();
  });

  it("binds a published Flow to the next Run of a Session", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    catalog.save({
      flowId: "flow-bind",
      name: "Bind me",
      kind: "runbook",
      status: "published",
      source: "git",
      definitionRevision: "git:one",
      steps: [{ id: "inspect", capability: "context.inspect", mode: "read_only" }],
    });
    const app = createFlowApp(catalog, "token", { sessions });
    const response = await app.request("/v1/flows/flow-bind/apply", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ session_id: session.id }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true, session_id: session.id, flow_id: "flow-bind", definition_revision: "git:one" });
    expect(sessions.getSession(session.id)?.flowId).toBe("flow-bind");
    expect(sessions.getSession(session.id)?.flowDefinitionRevision).toBe("git:one");
    sessions.close();
    catalog.close();
  });

  it.each([
    ["guide", "draft"],
    ["runbook", "draft"],
    ["runbook", "candidate"],
    ["runbook", "deprecated"],
  ] as const)("rejects applying a %s %s without changing the existing binding", async (kind, status) => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    sessions.bindFlow(session.id, { flowId: "flow-current", definitionRevision: "sha256:current" });
    catalog.save({
      flowId: `flow-${kind}-${status}`,
      name: "Not bindable",
      kind,
      status,
      source: "git",
      definitionRevision: "sha256:new",
      steps: [],
    });
    const app = createFlowApp(catalog, "token", { sessions });
    const response = await app.request(`/v1/flows/flow-${kind}-${status}/apply`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ session_id: session.id }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "flow_not_bindable" });
    expect(sessions.getSession(session.id)).toMatchObject({
      flowId: "flow-current",
      flowDefinitionRevision: "sha256:current",
    });
    sessions.close();
    catalog.close();
  });

  it("records Flow selection and candidate persistence on the Session event stream", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    const workItem = events.createWorkItem({
      title: "flow events",
      mode: "auto",
      conversationId: "conv_flow_events",
      riskLevel: "read_only",
    });
    const session = sessions.createSession({ agentId: "pi", taskRecordId: workItem.id });
    catalog.save({
      flowId: "flow-select",
      name: "Select",
      kind: "runbook",
      status: "published",
      source: "git",
      definitionRevision: "git:select",
      steps: [{ id: "inspect", capability: "context.inspect", mode: "read_only" }],
    });
    const app = createFlowApp(catalog, "token", { sessions, events });
    await app.request("/v1/flows/flow-select/apply", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ session_id: session.id }),
    });
    await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        definition_revision: "agent:one",
        flow: {
          flow_id: "flow-generated",
          steps: [{ id: "inspect", capability: "context.inspect", mode: "read_only" }],
        },
      }),
    });

    expect(events.listEvents(workItem.id).filter((event) => event.type.startsWith("FLOW_")).map((event) => event.type)).toEqual([
      "FLOW_SELECTED",
      "FLOW_SAVED_AS_CANDIDATE",
    ]);
    events.close();
    sessions.close();
    catalog.close();
  });

  // Enforces spec rule PROTO-FLOW-REVISION-001 (server-owned content-hash revisions) — docs/spec/RULES.md.
  it("computes content-hash revisions server-side and stores the compile tuple", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    const app = createFlowApp(catalog, "token", { sessions });
    const body = {
      session_id: session.id,
      definition_revision: "agent:caller-supplied-will-be-ignored",
      flow: {
        flow_id: "flow-hashed",
        name: "Hashed",
        kind: "runbook",
        inputs: [{ id: "company_id", type: "string", source: "user", required: true }],
        steps: [{ id: "deliver", capability: "equity.deliver", mode: "read_only" }],
      },
    };
    const headers = { authorization: "Bearer token", "content-type": "application/json" };
    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    const flow = catalog.get("flow-hashed");
    expect(flow?.definitionRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(flow?.planIrHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(flow?.definitionRevision).not.toBe(flow?.planIrHash);
    // Typed inputs must survive the API boundary end-to-end (not silently dropped).
    expect(flow?.inputs).toEqual([{ id: "company_id", type: "string", source: "user", required: true }]);
    // Re-posting the identical definition yields identical hashes (deterministic).
    await app.request("/v1/flows/candidates", { method: "POST", headers, body: JSON.stringify(body) });
    expect(catalog.get("flow-hashed")?.definitionRevision).toBe(flow?.definitionRevision);
    expect(catalog.get("flow-hashed")?.planIrHash).toBe(flow?.planIrHash);
    sessions.close();
    catalog.close();
  });

  it("persists success_when from the candidate body", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    const app = createFlowApp(catalog, "token", { sessions });
    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        flow: {
          flow_id: "flow-when",
          kind: "runbook",
          steps: [{
            id: "echo",
            capability: "demo.echo",
            mode: "read_only",
            success_when: "output.text exists",
          }],
        },
      }),
    });
    expect(response.status).toBe(201);
    expect(catalog.get("flow-when")?.steps[0]?.successWhen).toBe("output.text exists");
    const body = await response.json() as { steps: Array<{ success_when: string | null }> };
    expect(body.steps[0]?.success_when).toBe("output.text exists");
    sessions.close();
    catalog.close();
  });

  it("rejects publishing a runbook with a manual step", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    catalog.save({
      flowId: "flow-manual",
      name: "Manual",
      kind: "runbook",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: "sha256:one",
      steps: [{ id: "ask", mode: "manual", purpose: "confirm" }],
    });
    const app = createFlowApp(catalog, "token");
    const approved = await app.request("/v1/flows/flow-manual/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc" }),
    });
    expect(approved.status).toBe(409);
    expect(await approved.json()).toMatchObject({ error: "flow_not_publishable" });
    expect(catalog.get("flow-manual")?.status).toBe("candidate");
    catalog.close();
  });

  it("rejects publishing a runbook step without success_when", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const capabilities = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    registerDemoCapabilities(capabilities, runtime);
    catalog.save({
      flowId: "flow-no-when",
      name: "No when",
      kind: "runbook",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: "sha256:one",
      steps: [{ id: "echo", capability: "demo.echo", mode: "read_only" }],
    });
    const app = createFlowApp(catalog, "token", { capabilities, runtime });
    const approved = await app.request("/v1/flows/flow-no-when/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc" }),
    });
    expect(approved.status).toBe(409);
    expect(await approved.json()).toMatchObject({
      error: "flow_not_publishable",
      issues: expect.arrayContaining(["success_when required: echo"]),
    });
    expect(catalog.get("flow-no-when")?.status).toBe("candidate");
    capabilities.close();
    catalog.close();
  });

  it("rejects publishing a runbook whose success_when fails static validation", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const capabilities = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    registerDemoCapabilities(capabilities, runtime);
    catalog.save({
      flowId: "flow-bad-when",
      name: "Bad when",
      kind: "runbook",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: "sha256:one",
      steps: [{
        id: "echo",
        capability: "demo.echo",
        mode: "read_only",
        successWhen: "output.a ===",
      }],
    });
    const app = createFlowApp(catalog, "token", { capabilities, runtime });
    const approved = await app.request("/v1/flows/flow-bad-when/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc" }),
    });
    expect(approved.status).toBe(409);
    const body = await approved.json() as { error: string; issues: string[] };
    expect(body.error).toBe("flow_not_publishable");
    expect(body.issues.some((issue) => issue.includes("invalid success_when for echo"))).toBe(true);
    expect(catalog.get("flow-bad-when")?.status).toBe("candidate");
    capabilities.close();
    catalog.close();
  });

  it("publishes a runbook whose demo capabilities are registered", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    const capabilities = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    const events = new SqliteEventStore(":memory:");
    registerDemoCapabilities(capabilities, runtime);
    const app = createFlowApp(catalog, "token", { capabilities, runtime, sessions, events });
    const created = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        flow: {
          flow_id: "flow_demo_echo",
          kind: "runbook",
          inputs: [{ id: "text", type: "string", source: "user", required: true }],
          steps: [
            {
              id: "echo",
              capability: "demo.echo",
              mode: "read_only",
              success_when: "output.text exists",
            },
            {
              id: "concat",
              capability: "demo.concat",
              mode: "read_only",
              depends_on: ["echo"],
              success_when: "output.result exists",
            },
          ],
        },
      }),
    });
    expect(created.status).toBe(201);
    seedWorkflowRun(events, catalog.get("flow_demo_echo"), session.id);
    const approved = await app.request("/v1/flows/flow_demo_echo/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc" }),
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: "published" });
    events.close();
    capabilities.close();
    sessions.close();
    catalog.close();
  });

  it("publishes a runbook whose equity capability is registered", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    const capabilities = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    const events = new SqliteEventStore(":memory:");
    registerEquityCapabilities(capabilities, runtime);
    const app = createFlowApp(catalog, "token", { capabilities, runtime, sessions, events });
    const created = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        flow: {
          flow_id: "flow_equity_balance",
          name: "Equity Balance",
          kind: "runbook",
          inputs: [{ id: "user_id", type: "string", source: "user", required: true }],
          steps: [{
            id: "lookup",
            capability: "equity.balance",
            mode: "read_only",
            success_when: "output.balance exists",
          }],
        },
      }),
    });
    expect(created.status).toBe(201);
    seedWorkflowRun(events, catalog.get("flow_equity_balance"), session.id);
    const approved = await app.request("/v1/flows/flow_equity_balance/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc" }),
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: "published" });
    expect(catalog.get("flow_equity_balance")?.status).toBe("published");
    events.close();
    capabilities.close();
    sessions.close();
    catalog.close();
  });

  it("rejects publishing a runbook whose capability is not registered", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    catalog.save({
      flowId: "flow-equity",
      name: "Equity",
      kind: "runbook",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: "sha256:one",
      steps: [{ id: "deliver", capability: "equity.deliver", mode: "read_only" }],
    });
    const capabilities = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    const app = createFlowApp(catalog, "token", { capabilities, runtime });
    const approved = await app.request("/v1/flows/flow-equity/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc" }),
    });
    expect(approved.status).toBe(409);
    expect(await approved.json()).toMatchObject({ error: "flow_not_publishable" });
    expect(catalog.get("flow-equity")?.status).toBe("candidate");
    capabilities.close();
    catalog.close();
  });

  it("rejects review for a Guide draft", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    catalog.save({
      flowId: "flow-skill-guide",
      name: "Skill guide",
      kind: "guide",
      status: "draft",
      source: "agent_generated",
      definitionRevision: "sha256:one",
      steps: [{ id: "investigate", capability: "skill.investigate", mode: "read_only" }],
    });
    const app = createFlowApp(catalog, "token");
    const approved = await app.request("/v1/flows/flow-skill-guide/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc" }),
    });
    expect(approved.status).toBe(409);
    expect(await approved.json()).toMatchObject({ error: "flow_not_reviewable" });
    expect(catalog.get("flow-skill-guide")?.status).toBe("draft");
    catalog.close();
  });

  it("derives a traceable Candidate from a succeeded Published Runbook Run", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    const source = catalog.save({
      flowId: "flow-source-run",
      name: "Source Runbook",
      description: "A proven baseline",
      kind: "runbook",
      status: "published",
      source: "git",
      definitionRevision: "sha256:source-run",
      planIrHash: "sha256:source-plan",
      inputs: [{ id: "text", type: "string", source: "user", required: true }],
      steps: [{
        id: "echo",
        capability: "demo.echo",
        mode: "read_only",
        successWhen: "output.text exists",
      }],
    });
    const run = seedWorkflowRun(events, source, session.id);
    const app = createFlowApp(catalog, "token", { sessions, events });

    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ session_id: session.id, run_id: run.id }),
    });

    expect(response.status).toBe(201);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      kind: "runbook",
      status: "candidate",
      source: "user_selected",
      name: "Source Runbook",
      description: "A proven baseline",
      lineage_root_flow_id: source.flowId,
      parent_flow_id: source.flowId,
      provenance: {
        source_run_id: run.id,
        source_session_id: session.id,
        source_flow_id: source.flowId,
        source_definition_revision: source.definitionRevision,
      },
      inputs: [expect.objectContaining({ id: "text" })],
      steps: [expect.objectContaining({ id: "echo", capability: "demo.echo" })],
    });
    expect(body.flow_id).not.toBe(source.flowId);
    events.close();
    sessions.close();
    catalog.close();
  });

  it.each([
    ["running", "run_not_succeeded"],
    ["failed", "run_not_succeeded"],
  ] as const)("rejects deriving from a %s Run without writing a Candidate", async (status, error) => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    const source = catalog.save({
      flowId: `flow-${status}`,
      name: status,
      kind: "runbook",
      status: "published",
      source: "git",
      definitionRevision: `sha256:${status}`,
      planIrHash: `sha256:plan-${status}`,
      steps: [],
    });
    const run = seedWorkflowRun(events, source, session.id, status);
    const before = catalog.list().length;
    const app = createFlowApp(catalog, "token", { sessions, events });
    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ session_id: session.id, run_id: run.id }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error });
    expect(catalog.list()).toHaveLength(before);
    events.close();
    sessions.close();
    catalog.close();
  });

  it("returns capability mappings and structured Candidate review context", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const capabilities = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    registerDemoCapabilities(capabilities, runtime);
    const source = catalog.save({
      flowId: "flow-context-source",
      name: "Before",
      description: "Before description",
      kind: "runbook",
      status: "published",
      source: "git",
      definitionRevision: "sha256:before",
      planIrHash: "sha256:before-plan",
      steps: [{ id: "echo", capability: "demo.echo", mode: "read_only", successWhen: "output.text exists" }],
    });
    const candidate = catalog.save({
      flowId: "flow-context-candidate",
      name: "After",
      description: "After description",
      kind: "runbook",
      status: "candidate",
      source: "user_selected",
      definitionRevision: "sha256:after",
      planIrHash: "sha256:after-plan",
      lineageRootFlowId: source.flowId,
      parentFlowId: source.flowId,
      provenance: {
        sourceRunId: "run-source",
        sourceSessionId: "sess-source",
        sourceFlowId: source.flowId,
        sourceDefinitionRevision: source.definitionRevision,
      },
      steps: [
        { id: "echo", capability: "demo.echo", mode: "read_only", successWhen: "output.text exists" },
        { id: "concat", capability: "demo.concat", mode: "read_only", successWhen: "output.result exists" },
      ],
    });
    const app = createFlowApp(catalog, "token", { capabilities, runtime });

    const capabilityResponse = await app.request("/v1/capabilities", {
      headers: { authorization: "Bearer token" },
    });
    expect(capabilityResponse.status).toBe(200);
    expect(await capabilityResponse.json()).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({ id: "demo.echo", adapter: "demo.echo", risk: "read_only" }),
      ]),
    });

    const contextResponse = await app.request(`/v1/flows/${candidate.flowId}/review-context`, {
      headers: { authorization: "Bearer token" },
    });
    expect(contextResponse.status).toBe(200);
    expect(await contextResponse.json()).toMatchObject({
      flow: { flow_id: candidate.flowId },
      base: { flow_id: source.flowId, definition_revision: source.definitionRevision },
      diff: {
        name_changed: true,
        description_changed: true,
        steps: { added: ["concat"], removed: [], changed: [], reordered: false },
      },
      provenance: { source_run_id: "run-source" },
      evidence: [],
      history: expect.any(Array),
    });
    capabilities.close();
    catalog.close();
  });

  it("requires exact successful Dry-run evidence before publishing and replaces the Published parent", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    const capabilities = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    registerDemoCapabilities(capabilities, runtime);
    const parent = catalog.save({
      flowId: "flow-review-parent",
      name: "Review parent",
      kind: "runbook",
      status: "published",
      source: "git",
      definitionRevision: "sha256:review-parent",
      planIrHash: "sha256:review-parent-plan",
      publicationSequence: 1,
      steps: [{ id: "echo", capability: "demo.echo", mode: "read_only", successWhen: "output.text exists" }],
    });
    const candidate = catalog.save({
      flowId: "flow-review-candidate",
      name: "Review candidate",
      kind: "runbook",
      status: "candidate",
      source: "user_selected",
      definitionRevision: "sha256:review-candidate",
      planIrHash: "sha256:review-candidate-plan",
      lineageRootFlowId: parent.flowId,
      parentFlowId: parent.flowId,
      provenance: {
        sourceRunId: "run-parent",
        sourceSessionId: "sess-review",
        sourceFlowId: parent.flowId,
        sourceDefinitionRevision: parent.definitionRevision,
      },
      steps: [{ id: "echo", capability: "demo.echo", mode: "read_only", successWhen: "output.text exists" }],
    });
    const app = createFlowApp(catalog, "token", { events, capabilities, runtime });
    const headers = { authorization: "Bearer token", "content-type": "application/json" };

    const withoutEvidence = await app.request(`/v1/flows/${candidate.flowId}/review`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "approve", git_revision: "abc123" }),
    });
    expect(withoutEvidence.status).toBe(409);
    expect(await withoutEvidence.json()).toMatchObject({
      error: "flow_not_publishable",
      issues: expect.arrayContaining(["successful dry-run evidence required"]),
    });

    seedWorkflowRun(events, candidate, "sess-review");
    const approved = await app.request(`/v1/flows/${candidate.flowId}/review`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "approve", git_revision: "abc123" }),
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      status: "published",
      review_status: "approved",
      publication_sequence: 2,
    });
    expect(catalog.get(parent.flowId)?.status).toBe("deprecated");
    expect(catalog.listLineage(parent.flowId).filter((flow) => flow.status === "published"))
      .toHaveLength(1);
    events.close();
    capabilities.close();
    catalog.close();
  });

  it("rejects a Candidate without evidence and supports explicit Published deprecation", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const candidate = catalog.save({
      flowId: "flow-reject-candidate",
      name: "Reject candidate",
      kind: "runbook",
      status: "candidate",
      source: "user_selected",
      definitionRevision: "sha256:reject",
      planIrHash: "sha256:reject-plan",
      steps: [],
    });
    const published = catalog.save({
      flowId: "flow-explicit-deprecate",
      name: "Deprecate",
      kind: "runbook",
      status: "published",
      source: "git",
      definitionRevision: "sha256:deprecate",
      planIrHash: "sha256:deprecate-plan",
      steps: [],
    });
    const app = createFlowApp(catalog, "token");
    const headers = { authorization: "Bearer token", "content-type": "application/json" };
    const rejected = await app.request(`/v1/flows/${candidate.flowId}/review`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "reject" }),
    });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({ status: "candidate", review_status: "rejected" });

    const deprecated = await app.request(`/v1/flows/${published.flowId}/deprecate`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(deprecated.status).toBe(200);
    expect(await deprecated.json()).toMatchObject({ status: "deprecated" });
    const again = await app.request(`/v1/flows/${published.flowId}/deprecate`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "flow_not_deprecatable" });
    catalog.close();
  });

  it("rejects cross-Session and Agent-plan promotion attempts", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    const owner = sessions.createSession({ agentId: "pi" });
    const attacker = sessions.createSession({ agentId: "pi" });
    const agentSession = sessions.createSession({ agentId: "pi" });
    const source = catalog.save({
      flowId: "flow-promotion-source",
      name: "Promotion source",
      kind: "runbook",
      status: "published",
      source: "git",
      definitionRevision: "sha256:promotion",
      planIrHash: "sha256:promotion-plan",
      steps: [],
    });
    const ownedRun = seedWorkflowRun(events, source, owner.id);
    const app = createFlowApp(catalog, "token", { sessions, events });
    const headers = { authorization: "Bearer token", "content-type": "application/json" };
    const crossSession = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers,
      body: JSON.stringify({ session_id: attacker.id, run_id: ownedRun.id }),
    });
    expect(crossSession.status).toBe(404);
    expect(await crossSession.json()).toEqual({ error: "run_not_found" });

    const workItem = events.createWorkItem({
      title: "Agent plan",
      mode: "auto",
      conversationId: "conv-agent-plan",
      sessionId: agentSession.id,
      riskLevel: "read_only",
    });
    events.savePlan({
      planId: "plan-agent-generated",
      source: "agent_generated",
      workflowId: source.flowId,
      definitionRevision: source.definitionRevision,
      planIrHash: source.planIrHash,
      sessionId: agentSession.id,
      runId: "run-agent-generated",
      steps: [],
    });
    events.createRun({
      id: "run-agent-generated",
      workItemId: workItem.id,
      sessionId: agentSession.id,
      mode: "auto",
      executionKind: "agent",
      planId: "plan-agent-generated",
      planIrHash: source.planIrHash,
      workflowRevision: source.definitionRevision,
    });
    events.updateRunStatus("run-agent-generated", "succeeded");
    const agentPlan = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers,
      body: JSON.stringify({ session_id: agentSession.id, run_id: "run-agent-generated" }),
    });
    expect(agentPlan.status).toBe(409);
    expect(await agentPlan.json()).toEqual({ error: "run_not_solidifiable" });
    events.close();
    sessions.close();
    catalog.close();
  });

  it("does not let successful evidence from an old revision approve a changed Candidate", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    const capabilities = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    const candidate = catalog.save({
      flowId: "flow-stale-evidence",
      name: "Before",
      kind: "runbook",
      status: "candidate",
      source: "user_selected",
      definitionRevision: "sha256:before",
      planIrHash: "sha256:before-plan",
      steps: [],
    });
    seedWorkflowRun(events, candidate, "sess-stale");
    catalog.save({
      ...candidate,
      name: "After",
      definitionRevision: "sha256:after",
      planIrHash: "sha256:after-plan",
    });
    const app = createFlowApp(catalog, "token", { events, capabilities, runtime });
    const response = await app.request(`/v1/flows/${candidate.flowId}/review`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "git-after" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "flow_not_publishable",
      issues: expect.arrayContaining(["successful dry-run evidence required"]),
    });
    expect(catalog.get(candidate.flowId)?.status).toBe("candidate");
    events.close();
    capabilities.close();
    catalog.close();
  });
});
