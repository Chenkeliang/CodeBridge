import type { Hono } from "hono";
import type {
  ChannelCommandContext,
  ChannelDeliveryRow,
  ChannelSessionEvent,
  ChannelSessionIngress,
  ChannelSessionMessage,
  ChannelSlot,
  ChannelSubmitReceipt,
} from "@codebridge/core";

interface SessionEvent {
  type?: string;
  sequence?: number;
  target?: string | null;
  runId?: string | null;
  payload?: Record<string, unknown>;
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
          flow_id: message.flowId,
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
    for await (const event of readSessionEvents(response.body)) {
      yield {
        type: String(event.type ?? ""),
        sequence: Number(event.sequence ?? 0),
        runId: event.runId ?? null,
        target: event.target ?? null,
        payload: (event.payload ?? {}) as Record<string, unknown>,
      };
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
  ): Promise<boolean> => {
    const response = await app.request(
      `/v1/deliveries/${encodeURIComponent(turnId)}/ack`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ owner, surface_message_id: surfaceMessageId }),
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
    };
    return {
      sessionId: body.session_id,
      activeRunId: body.active_run_id,
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
    events,
    listDeliveries,
    claimDelivery,
    ackDelivery,
    completeDelivery,
    getSlotCommandContext,
    resumeProviderSession,
    cancelRun,
    resolvePermission,
    resumeQueue,
    resetSlot,
  };
}

async function* readSessionEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SessionEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
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
        if (data) yield JSON.parse(data) as SessionEvent;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
