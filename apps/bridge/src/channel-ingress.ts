import type {
  ChannelCommandContext,
  ChannelDeliveryRow,
  ChannelRuntimeApproval,
  ChannelSessionEvent,
  ChannelSessionIngress,
  ChannelSessionMessage,
  ChannelSlot,
  ChannelSubmitReceipt,
} from "@codebridge/core";
import { parseSessionEventWire } from "@codebridge/core/session-event-wire";
import { Hono } from "hono";

function toChannelSessionEvent(input: unknown): ChannelSessionEvent {
  const event = parseSessionEventWire(input);
  return {
    type: event.type,
    sequence: event.sequence,
    runId: event.run_id,
    executionKind: event.execution_kind,
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
): Hono {
  const app = new Hono();
  app.route("/", sessionApp);
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
    if (
      (message.replyToMessageId === undefined)
      !== (message.showThinking === undefined)
    ) {
      throw new Error("channel_delivery_incomplete");
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

          ...(message.inputs !== undefined ? { inputs: message.inputs } : {}),
          ...(message.actorRef !== undefined ? { actor_ref: message.actorRef } : {}),
          generation: message.generation,
          reply_to_message_id: message.replyToMessageId,
          show_thinking: message.showThinking,
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
    surfaceMessageId?: string,
  ): Promise<ChannelDeliveryRow[]> => {
    const response = await app.request(
      `/v1/deliveries?channel=${encodeURIComponent(channel)}`
        + (surfaceMessageId !== undefined ? `&surface_message_id=${encodeURIComponent(surfaceMessageId)}` : ""),
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
    commandId: string,
  ): Promise<{ queueState: "ready" | "paused" }> => {
    const version = await readRuntimeVersion(sessionId);
    const response = await app.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/queue/resume`,
      {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          "idempotency-key": `resume:${commandId}`,
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
    listRuntimeApprovals,
    resolveRuntimeApproval,
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
