import { Hono } from "hono";
import type {
  ChannelCommandContext,
  ChannelConsumableFlow,
  ChannelDeliveryRow,
  ChannelFlowInput,
  ChannelFlowBatchDraft,
  ChannelFlowBatchSnapshot,
  ChannelFlowReviewSummary,
  ChannelManageableFlow,
  ChannelRuntimeApproval,
  ChannelSessionEvent,
  ChannelSessionIngress,
  ChannelSessionMessage,
  ChannelSlot,
  ChannelSubmitReceipt,
} from "@codebridge/core";
import { parseSessionEventWire } from "@codebridge/core/session-event-wire";

function toChannelSessionEvent(input: unknown): ChannelSessionEvent {
  const event = parseSessionEventWire(input);
  return {
    type: event.type,
    sequence: event.sequence,
    runId: event.run_id,
    occurredAt: event.occurred_at,
    target: event.target,
    resultRef: event.result_ref,
    payload: event.payload,
  };
}

function requireSessionEventContentType(
  response: Response,
  expected: "text/event-stream" | "application/json",
): void {
  const actual = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!actual.includes(expected)) {
    throw new Error("session_event_transport_mismatch");
  }
}

export function createChannelIngressApi(
  sessionApp: Hono,
  flowApp: Hono,
  flowBatchApp?: Hono,
): Hono {
  const app = new Hono();
  app.route("/", sessionApp);
  app.route("/", flowApp);
  if (flowBatchApp) app.route("/", flowBatchApp);
  return app;
}

export function createChannelSessionIngress(
  app: Hono,
  token: string,
): ChannelSessionIngress {
  const auth = { authorization: `Bearer ${token}` };

  const readRuntimeVersion = async (
    sessionId: string,
  ): Promise<number> => {
    const response = await app.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      { headers: auth },
    );
    if (!response.ok) {
      throw new Error(
        `read runtime failed (${response.status}): ${await response.text()}`,
      );
    }
    const body = await response.json() as {
      runtime?: { version?: number };
    };
    if (typeof body.runtime?.version !== "number") {
      throw new Error("runtime version missing in snapshot");
    }
    return body.runtime.version;
  };

  const submit = async (
    message: ChannelSessionMessage,
  ): Promise<ChannelSubmitReceipt> => {
    if ((message.flowId === undefined) !== (message.flowDefinitionRevision === undefined)) {
      throw new Error("flow_invocation_incomplete");
    }
    const accepted = await app.request(
      `/v1/channels/${encodeURIComponent(message.channel)}/conversations/${encodeURIComponent(message.conversationId)}/messages`,
      {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          ...(message.idempotencyKey
            ? { "idempotency-key": message.idempotencyKey }
            : {}),
        },
        body: JSON.stringify({
          message: message.message,
          agent_id: message.agentId,
          cwd: message.cwd,
          model: message.model,
          ...(message.flowId !== undefined ? { flow_id: message.flowId } : {}),
          ...(message.flowDefinitionRevision !== undefined
            ? { definition_revision: message.flowDefinitionRevision }
            : {}),
          ...(message.inputs !== undefined ? { inputs: message.inputs } : {}),
          ...(message.actorRef !== undefined ? { actor_ref: message.actorRef } : {}),
          generation: message.generation,
          reply_to_message_id: message.replyToMessageId,
          attachments: message.attachments?.map((attachment) => ({
            name: attachment.name,
            mime_type: attachment.mimeType,
            data_base64: attachment.dataBase64,
          })),
        }),
      },
    );
    if (!accepted.ok) {
      throw new Error(
        `Channel submit failed (${accepted.status}): ${await accepted.text()}`,
      );
    }
    const result = await accepted.json() as {
      session_id: string;
      turn_id: string;
      run_id: string | null;
      acceptance: "dispatched" | "queued";
      queue_state: "ready" | "paused";
      event_sequence: number;
    };
    return {
      sessionId: result.session_id,
      turnId: result.turn_id,
      runId: result.run_id,
      acceptance: result.acceptance,
      queueState: result.queue_state,
      eventSequence: result.event_sequence,
    };
  };

  const listConsumableFlows = async (): Promise<ChannelConsumableFlow[]> => {
    const response = await app.request("/v1/flows?view=consume", {
      headers: auth,
    });
    if (!response.ok) {
      throw new Error(
        `list consumable Flows failed (${response.status}): ${await response.text()}`,
      );
    }
    const body = await response.json() as {
      flows: Array<{
        flow_id: string;
        name: string | null;
        definition_revision: string;
        inputs?: ChannelFlowInput[];
        steps?: Array<{
          id: string;
          purpose?: string | null;
          mode?: string | null;
          approval?: "none" | "required";
        }>;
      }>;
    };
    return body.flows.map((flow) => ({
      flowId: flow.flow_id,
      name: flow.name ?? flow.flow_id,
      definitionRevision: flow.definition_revision,
      inputs: flow.inputs ?? [],
      steps: (flow.steps ?? []).map((step) => ({
        id: step.id,
        purpose: step.purpose ?? null,
        mode: step.mode ?? null,
        approval: step.approval ?? "none",
      })),
    }));
  };

  const listManageableFlows = async (): Promise<ChannelManageableFlow[]> => {
    const response = await app.request("/v1/flows?view=manage", { headers: auth });
    if (!response.ok) throw new Error(`list manageable Flows failed (${response.status}): ${await response.text()}`);
    const body = await response.json() as { flows: Array<Record<string, unknown>> };
    return body.flows.map(toChannelManageableFlow);
  };

  const saveLatestGuide = async (sessionId: string): Promise<ChannelManageableFlow> => {
    const proposals = await app.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/flow-proposals`,
      { headers: auth },
    );
    if (!proposals.ok) throw new Error(`list Flow proposals failed (${proposals.status}): ${await proposals.text()}`);
    const body = await proposals.json() as { proposals: Array<{ run_id: string; saveable: boolean }> };
    const proposal = body.proposals.find((entry) => entry.saveable);
    if (!proposal) throw new Error("当前 Session 没有可保存的成功 Agent Run");
    const response = await app.request("/v1/flows/guides", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, run_id: proposal.run_id }),
    });
    if (!response.ok) throw new Error(`save Guide failed (${response.status}): ${await response.text()}`);
    return toChannelManageableFlow(await response.json() as Record<string, unknown>);
  };

  const getFlowReviewSummary = async (flowId: string): Promise<ChannelFlowReviewSummary> => {
    const response = await app.request(`/v1/flows/${encodeURIComponent(flowId)}/review-context`, { headers: auth });
    if (!response.ok) throw new Error(`read Flow review failed (${response.status}): ${await response.text()}`);
    const body = await response.json() as {
      flow: Record<string, unknown>;
      diff: { name_changed?: boolean; description_changed?: boolean; inputs?: { added?: string[]; removed?: string[]; changed?: string[] }; steps?: { added?: string[]; removed?: string[]; changed?: string[]; reordered?: boolean } };
      provenance?: { source_run_id?: string; source_session_id?: string } | null;
      evidence?: unknown[];
    };
    const changedFields = [
      body.diff.name_changed ? "name" : null,
      body.diff.description_changed ? "description" : null,
      ...(body.diff.inputs?.added ?? []).map((id) => `input +${id}`),
      ...(body.diff.inputs?.removed ?? []).map((id) => `input -${id}`),
      ...(body.diff.inputs?.changed ?? []).map((id) => `input ~${id}`),
      ...(body.diff.steps?.added ?? []).map((id) => `step +${id}`),
      ...(body.diff.steps?.removed ?? []).map((id) => `step -${id}`),
      ...(body.diff.steps?.changed ?? []).map((id) => `step ~${id}`),
      body.diff.steps?.reordered ? "steps reordered" : null,
    ].filter((value): value is string => Boolean(value));
    const flow = toChannelManageableFlow(body.flow);
    return {
      flow,
      changedFields,
      provenance: body.provenance?.source_run_id && body.provenance.source_session_id
        ? { sourceRunId: body.provenance.source_run_id, sourceSessionId: body.provenance.source_session_id }
        : null,
      evidenceCount: body.evidence?.length ?? 0,
      validationIssues: Array.isArray(body.flow.validation_issues)
        ? body.flow.validation_issues.filter((value): value is string => typeof value === "string")
        : [],
    };
  };

  const updateCandidateSummary = async (
    flowId: string,
    patch: { name?: string; description?: string },
  ): Promise<ChannelManageableFlow> => {
    const response = await app.request(`/v1/flows/${encodeURIComponent(flowId)}/summary`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error(`update Candidate summary failed (${response.status}): ${await response.text()}`);
    return toChannelManageableFlow(await response.json() as Record<string, unknown>);
  };

  const rejectCandidate = async (flowId: string): Promise<ChannelManageableFlow> => {
    const response = await app.request(`/v1/flows/${encodeURIComponent(flowId)}/review`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject" }),
    });
    if (!response.ok) throw new Error(`reject Candidate failed (${response.status}): ${await response.text()}`);
    return toChannelManageableFlow(await response.json() as Record<string, unknown>);
  };

  const listRuntimeApprovals = async (
    runId: string,
  ): Promise<ChannelRuntimeApproval[]> => {
    const response = await app.request(
      `/v1/runs/${encodeURIComponent(runId)}/approvals`,
      { headers: auth },
    );
    if (!response.ok) {
      throw new Error(
        `list Runtime approvals failed (${response.status}): ${await response.text()}`,
      );
    }
    const body = await response.json() as {
      approvals: Array<{
        id: string;
        run_id: string;
        step_id?: string | null;
        capability_id?: string | null;
        status: string;
        environment?: string | null;
        target_resource?: string | null;
        expires_at?: string | null;
      }>;
    };
    return body.approvals.map(toChannelRuntimeApproval);
  };

  const resolveRuntimeApproval = async (
    runId: string,
    approvalId: string,
    decision: "approve" | "reject",
  ): Promise<ChannelRuntimeApproval> => {
    const response = await app.request(
      `/v1/runs/${encodeURIComponent(runId)}/${decision}`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ approval_id: approvalId }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `resolve Runtime approval failed (${response.status}): ${await response.text()}`,
      );
    }
    const body = await response.json() as {
      approval_id: string;
      status: string;
    };
    return {
      id: body.approval_id,
      runId,
      stepId: null,
      capabilityId: null,
      status: body.status,
      environment: null,
      targetResource: null,
      expiresAt: null,
    };
  };

  const getFlowBatchDraft = async (
    draftId: string,
  ): Promise<ChannelFlowBatchDraft> => {
    const response = await app.request(
      `/v1/flow-invocation-drafts/${encodeURIComponent(draftId)}`,
      { headers: auth },
    );
    if (!response.ok) {
      throw new Error(`read Flow batch draft failed (${response.status}): ${await response.text()}`);
    }
    return toChannelFlowBatchDraft(await response.json() as Record<string, unknown>);
  };

  const confirmFlowBatchDraft = async (
    draftId: string,
    revision: number,
    idempotencyKey: string,
  ): Promise<ChannelFlowBatchSnapshot> => {
    const response = await app.request(
      `/v1/flow-invocation-drafts/${encodeURIComponent(draftId)}/confirm`,
      {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          draft_revision: revision,
          created_by: "channel",
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`confirm Flow batch failed (${response.status}): ${await response.text()}`);
    }
    return toChannelFlowBatchSnapshot(await response.json() as Record<string, unknown>);
  };

  const getFlowBatch = async (
    batchId: string,
  ): Promise<ChannelFlowBatchSnapshot> => {
    const response = await app.request(
      `/v1/flow-batches/${encodeURIComponent(batchId)}`,
      { headers: auth },
    );
    if (!response.ok) {
      throw new Error(`read Flow batch failed (${response.status}): ${await response.text()}`);
    }
    return toChannelFlowBatchSnapshot(await response.json() as Record<string, unknown>);
  };

  const cancelFlowBatch = async (
    batchId: string,
  ): Promise<ChannelFlowBatchSnapshot> => {
    const response = await app.request(
      `/v1/flow-batches/${encodeURIComponent(batchId)}/cancel`,
      { method: "POST", headers: auth },
    );
    if (!response.ok) {
      throw new Error(`cancel Flow batch failed (${response.status}): ${await response.text()}`);
    }
    return toChannelFlowBatchSnapshot(await response.json() as Record<string, unknown>);
  };

  const retryFailedFlowBatch = async (
    batchId: string,
    idempotencyKey: string,
  ): Promise<ChannelFlowBatchSnapshot> => {
    const response = await app.request(
      `/v1/flow-batches/${encodeURIComponent(batchId)}/retry-failed`,
      {
        method: "POST",
        headers: { ...auth, "idempotency-key": idempotencyKey },
      },
    );
    if (!response.ok) {
      throw new Error(`retry Flow batch failed (${response.status}): ${await response.text()}`);
    }
    return toChannelFlowBatchSnapshot(await response.json() as Record<string, unknown>);
  };

  const events = async function* (
    sessionId: string,
    opts: { afterSequence: number; signal: AbortSignal },
  ): AsyncGenerator<ChannelSessionEvent> {
    const response = await app.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events?live=true&after_sequence=${opts.afterSequence}`,
      { headers: auth, signal: opts.signal },
    );
    if (!response.ok || !response.body) {
      throw new Error(`Channel event stream failed (${response.status})`);
    }
    requireSessionEventContentType(response, "text/event-stream");
    for await (const event of readSessionEvents(response.body, opts.signal)) {
      yield toChannelSessionEvent(event);
    }
  };

  const replayEvents = async (
    sessionId: string,
    opts: { afterSequence: number },
  ): Promise<ChannelSessionEvent[]> => {
    const replayed: ChannelSessionEvent[] = [];
    let cursor = opts.afterSequence;
    while (true) {
      const response = await app.request(
        `/v1/sessions/${encodeURIComponent(sessionId)}/events?after_sequence=${cursor}&limit=500`,
        { headers: auth },
      );
      if (!response.ok) {
        throw new Error(`Channel event replay failed (${response.status})`);
      }
      requireSessionEventContentType(response, "application/json");
      const page = await response.json() as Record<string, unknown>;
      if (
        !Array.isArray(page.events)
        || !Number.isInteger(page.next_sequence)
        || typeof page.has_more !== "boolean"
      ) {
        throw new Error("session_event_schema_mismatch");
      }
      replayed.push(...page.events.map(toChannelSessionEvent));
      if (!page.has_more) return replayed;
      const next = page.next_sequence as number;
      if (next <= cursor) throw new Error("session_event_schema_mismatch");
      cursor = next;
    }
  };

  const listDeliveries = async (
    channel: string,
  ): Promise<ChannelDeliveryRow[]> => {
    const response = await app.request(
      `/v1/deliveries?channel=${encodeURIComponent(channel)}`,
      { headers: auth },
    );
    if (!response.ok) {
      throw new Error(`list deliveries failed (${response.status})`);
    }
    const body = await response.json() as { deliveries: ChannelDeliveryRow[] };
    return body.deliveries;
  };

  const claimDelivery = async (
    turnId: string,
    owner: string,
  ): Promise<boolean> => {
    const response = await app.request(
      `/v1/deliveries/${encodeURIComponent(turnId)}/claim`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ owner }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `claim delivery failed (${response.status}): ${await response.text()}`,
      );
    }
    return (await response.json() as { claimed?: boolean }).claimed === true;
  };

  const ackDelivery = async (
    turnId: string,
    owner: string,
    surfaceMessageId: string,
    surfaceCardId?: string,
  ): Promise<boolean> => {
    const response = await app.request(
      `/v1/deliveries/${encodeURIComponent(turnId)}/ack`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          owner,
          surface_message_id: surfaceMessageId,
          ...(surfaceCardId ? { surface_card_id: surfaceCardId } : {}),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `ack delivery failed (${response.status}): ${await response.text()}`,
      );
    }
    return (await response.json() as { acked?: boolean }).acked === true;
  };

  const completeDelivery = async (
    turnId: string,
    owner: string,
  ): Promise<boolean> => {
    const response = await app.request(
      `/v1/deliveries/${encodeURIComponent(turnId)}/complete`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ owner }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `complete delivery failed (${response.status}): ${await response.text()}`,
      );
    }
    return (await response.json() as { completed?: boolean }).completed === true;
  };

  const getSlotCommandContext = async (
    slot: ChannelSlot,
  ): Promise<ChannelCommandContext> => {
    const response = await app.request(
      "/v1/channels/command-context",
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          slot: {
            channel: slot.channel,
            conversation_id: slot.conversationId,
            agent_id: slot.agentId,
            workspace_key: slot.workspaceKey,
            generation: slot.generation,
          },
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `command context failed (${response.status}): ${await response.text()}`,
      );
    }
    const body = await response.json() as {
      session_id: string | null;
      active_run_id: string | null;
      provider_session_id: string | null;
    };
    return {
      sessionId: body.session_id,
      activeRunId: body.active_run_id,
      providerSessionId: body.provider_session_id ?? null,
    };
  };

  const resolvePermission = async (
    runId: string,
    approve: boolean,
  ): Promise<boolean> => {
    const response = await app.request(
      `/v1/runs/${encodeURIComponent(runId)}/permission`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ approve }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `resolve permission failed (${response.status}): ${await response.text()}`,
      );
    }
    return (await response.json() as { resolved?: boolean }).resolved === true;
  };

  const cancelRun = async (
    sessionId: string,
    runId: string,
  ): Promise<boolean> => {
    const version = await readRuntimeVersion(sessionId);
    const response = await app.request(
      `/v1/runs/${encodeURIComponent(runId)}/cancel`,
      {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          "idempotency-key": `cancel:${runId}`,
          "if-match": String(version),
        },
        body: "{}",
      },
    );
    if (!response.ok) {
      throw new Error(
        `cancel run failed (${response.status}): ${await response.text()}`,
      );
    }
    return (await response.json() as { disposition?: string }).disposition !== undefined;
  };

  const steerRun = async (
    runId: string,
    prompt: string,
  ): Promise<{ ok: boolean; outcome?: string; error?: string }> => {
    const response = await app.request(
      `/v1/runs/${encodeURIComponent(runId)}/steer`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      },
    );
    if (!response.ok) {
      let message = `steer run failed (${response.status})`;
      try {
        const body = await response.json() as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // 非 JSON 错误体，保留默认消息
      }
      throw new Error(message);
    }
    return response.json() as Promise<{
      ok: boolean;
      outcome?: string;
      error?: string;
    }>;
  };

  const resumeQueue = async (
    sessionId: string,
  ): Promise<{ queueState: "ready" | "paused" }> => {
    const version = await readRuntimeVersion(sessionId);
    const response = await app.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/queue/resume`,
      {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          "idempotency-key": `resume:${sessionId}`,
          "if-match": String(version),
        },
        body: "{}",
      },
    );
    if (!response.ok) {
      throw new Error(
        `resume queue failed (${response.status}): ${await response.text()}`,
      );
    }
    const body = await response.json() as {
      runtime?: { queue_state?: "ready" | "paused" };
    };
    return { queueState: body.runtime?.queue_state ?? "ready" };
  };

  const resetSlot = async (slot: ChannelSlot): Promise<boolean> => {
    const response = await app.request(
      `/v1/channels/${encodeURIComponent(slot.channel)}/conversations/${encodeURIComponent(slot.conversationId)}/reset`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: slot.agentId,
          workspace_key: slot.workspaceKey,
          generation: slot.generation,
        }),
      },
    );
    if (!response.ok) return false;
    return (await response.json() as { reset?: boolean }).reset === true;
  };

  const resumeProviderSession = async (
    slot: ChannelSlot,
    providerSessionId: string,
  ): Promise<{ sessionId: string }> => {
    const response = await app.request(
      `/v1/channels/${encodeURIComponent(slot.channel)}/conversations/${encodeURIComponent(slot.conversationId)}/resume`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: slot.agentId,
          workspace_key: slot.workspaceKey,
          generation: slot.generation,
          provider_session_id: providerSessionId,
        }),
      },
    );
    if (!response.ok) {
      let message = `resume provider session failed (${response.status})`;
      let detail: string | undefined;
      try {
        const body = await response.json() as {
          error?: string;
          detail?: string;
        };
        if (body.error) message = body.error;
        detail = body.detail;
      } catch {
        // 非 JSON 错误体，保留默认消息
      }
      // 只 throw 错误码（detail 挂到 Error.detail），便于 bridge 按码精确匹配。
      const error = new Error(message) as Error & { detail?: string };
      if (detail) error.detail = detail;
      throw error;
    }
    const body = await response.json() as { session_id: string };
    return { sessionId: body.session_id };
  };

  return {
    submit,
    listConsumableFlows,
    listManageableFlows,
    saveLatestGuide,
    getFlowReviewSummary,
    updateCandidateSummary,
    rejectCandidate,
    listRuntimeApprovals,
    resolveRuntimeApproval,
    getFlowBatchDraft,
    confirmFlowBatchDraft,
    getFlowBatch,
    cancelFlowBatch,
    retryFailedFlowBatch,
    events,
    replayEvents,
    listDeliveries,
    claimDelivery,
    ackDelivery,
    completeDelivery,
    getSlotCommandContext,
    resumeProviderSession,
    cancelRun,
    steerRun,
    resolvePermission,
    resumeQueue,
    resetSlot,
  };
}

function toChannelRuntimeApproval(input: {
  id: string;
  run_id: string;
  step_id?: string | null;
  capability_id?: string | null;
  status: string;
  environment?: string | null;
  target_resource?: string | null;
  expires_at?: string | null;
}): ChannelRuntimeApproval {
  return {
    id: input.id,
    runId: input.run_id,
    stepId: input.step_id ?? null,
    capabilityId: input.capability_id ?? null,
    status: input.status,
    environment: input.environment ?? null,
    targetResource: input.target_resource ?? null,
    expiresAt: input.expires_at ?? null,
  };
}

function toChannelFlowBatchDraft(
  input: Record<string, unknown>,
): ChannelFlowBatchDraft {
  const items = Array.isArray(input.items) ? input.items : [];
  const blocking = items.filter((item) =>
    item && typeof item === "object" && Array.isArray((item as Record<string, unknown>).issues)
      && ((item as Record<string, unknown>).issues as unknown[]).some((issue) =>
        issue && typeof issue === "object"
          && (issue as Record<string, unknown>).blocking === true
      )
  ).length;
  return {
    draftId: String(input.draft_id ?? ""),
    sessionId: String(input.session_id ?? ""),
    flowId: String(input.flow_id ?? ""),
    definitionRevision: String(input.definition_revision ?? ""),
    status: input.status as ChannelFlowBatchDraft["status"],
    revision: Number(input.revision ?? 0),
    total: items.length,
    blocking,
  };
}

function toChannelFlowBatchSnapshot(
  input: Record<string, unknown>,
): ChannelFlowBatchSnapshot {
  const counts = input.counts && typeof input.counts === "object"
    ? input.counts as Record<string, unknown>
    : {};
  return {
    batchId: String(input.batch_id ?? ""),
    draftId: String(input.draft_id ?? ""),
    sessionId: String(input.session_id ?? ""),
    flowId: String(input.flow_id ?? ""),
    definitionRevision: String(input.definition_revision ?? ""),
    status: input.status as ChannelFlowBatchSnapshot["status"],
    counts: {
      total: Number(counts.total ?? 0),
      queued: Number(counts.queued ?? 0),
      running: Number(counts.running ?? 0),
      waiting: Number(counts.waiting ?? 0),
      succeeded: Number(counts.succeeded ?? 0),
      failed: Number(counts.failed ?? 0),
      cancelled: Number(counts.cancelled ?? 0),
    },
  };
}

function toChannelManageableFlow(input: Record<string, unknown>): ChannelManageableFlow {
  return {
    flowId: String(input.flow_id ?? ""),
    name: typeof input.name === "string" ? input.name : String(input.flow_id ?? ""),
    description: typeof input.description === "string" ? input.description : null,
    definitionRevision: String(input.definition_revision ?? ""),
    kind: input.kind === "guide" || input.kind === "runbook" || input.kind === "ephemeral"
      ? input.kind
      : "guide",
    status: input.status === "draft" || input.status === "candidate" || input.status === "published" || input.status === "deprecated"
      ? input.status
      : "draft",
    reviewStatus: typeof input.review_status === "string" ? input.review_status : null,
  };
}

async function* readSessionEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");
        if (data) yield JSON.parse(data) as unknown;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) return;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
