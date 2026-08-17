import type { Hono } from "hono";
import type {
  AgentEvent,
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
  ): Promise<number | undefined> => {
    const response = await app.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      { headers: auth },
    );
    if (!response.ok) return undefined;
    const body = await response.json() as {
      runtime?: { version?: number };
    };
    return body.runtime?.version;
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

  const resumeProviderSession = async (
    slot: ChannelSlot,
    providerSessionId: string,
  ): Promise<{ sessionId: string }> => {
    const response = await app.request(
      "/v1/sessions/resume-provider",
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
          provider_session_id: providerSessionId,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `resume provider session failed (${response.status}): ${await response.text()}`,
      );
    }
    const body = await response.json() as { session_id: string };
    return { sessionId: body.session_id };
  };

  const cancelRun = async (
    sessionId: string,
    runId: string,
  ): Promise<boolean> => {
    const version = await readRuntimeVersion(sessionId);
    if (version === undefined) return false;
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
    if (version === undefined) return { queueState: "paused" };
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

  const resolveApprovalForRun = async (
    approval: { sessionId: string; runId: string; approvalId: string },
    approve: boolean,
  ): Promise<boolean> => {
    const response = await app.request(
      `/v1/sessions/${encodeURIComponent(approval.sessionId)}/approval`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          run_id: approval.runId,
          approval_id: approval.approvalId,
          approve,
        }),
      },
    );
    if (!response.ok) return false;
    return (await response.json() as { resolved?: boolean }).resolved === true;
  };

  const ingress = Object.assign(legacyStream, {
    submit,
    events,
    listDeliveries,
    claimDelivery,
    ackDelivery,
    completeDelivery,
    resumeProviderSession,
    cancelRun,
    resumeQueue,
    resetSlot,
    resolveApprovalForRun,
    // 旧 conversation 级方法（Task 7/8 迁移后移除）
    cancel: async (channel: string, conversationId: string) => {
      const response = await app.request(
        `/v1/channels/${encodeURIComponent(channel)}/conversations/${encodeURIComponent(conversationId)}/cancel`,
        { method: "POST", headers: auth },
      );
      if (!response.ok) return false;
      return (await response.json() as { stopped?: boolean }).stopped === true;
    },
    reset: async (channel: string, conversationId: string) => {
      const response = await app.request(
        `/v1/channels/${encodeURIComponent(channel)}/conversations/${encodeURIComponent(conversationId)}/reset`,
        { method: "POST", headers: auth },
      );
      if (!response.ok) return false;
      return (await response.json() as { reset?: boolean }).reset === true;
    },
    resolveApproval: async (
      channel: string,
      conversationId: string,
      approve: boolean,
    ) => {
      const response = await app.request(
        `/v1/channels/${encodeURIComponent(channel)}/conversations/${encodeURIComponent(conversationId)}/approval`,
        {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ approve }),
        },
      );
      if (!response.ok) return false;
      return (await response.json() as { resolved?: boolean }).resolved === true;
    },
  });

  return ingress as ChannelSessionIngress;

  /** 旧函数式入口：submit + 订阅，按 run 过滤为 AgentEvent（Task 7/8 迁移后移除） */
  async function* legacyStream(
    message: ChannelSessionMessage,
  ): AsyncGenerator<AgentEvent> {
    const receipt = await submit(message);
    const controller = new AbortController();
    const signal = message.signal
      ? AbortSignal.any([message.signal, controller.signal])
      : controller.signal;
    const fatalAgentErrorRuns = new Set<string>();
    let submittedRunId = receipt.runId;
    try {
      for await (const event of events(receipt.sessionId, {
        afterSequence: receipt.eventSequence,
        signal,
      })) {
        if (
          event.type === "TURN_DISPATCHED"
          && event.target === receipt.turnId
          && event.runId
        ) {
          submittedRunId = event.runId;
        }
        if (!submittedRunId || event.runId !== submittedRunId) continue;
        if (event.type === "AGENT_EVENT") {
          const agentEvent = event.payload.event as AgentEvent | undefined;
          if (!agentEvent) continue;
          if (agentEvent.type === "error" && agentEvent.fatal && event.runId) {
            fatalAgentErrorRuns.add(event.runId);
          }
          if (agentEvent.type !== "done") yield agentEvent;
        }
        if (event.type === "APPROVAL_REQUESTED") {
          yield {
            type: "permission_request",
            requestId: String(
              (event.payload as Record<string, unknown>)?.approval_id ?? "approval",
            ),
            title: "此步骤需要审批，请在 Web Workbench 中确认",
          };
        }
        if (event.type === "STEP_FAILED") {
          if (!event.runId || !fatalAgentErrorRuns.has(event.runId)) {
            yield {
              type: "error",
              message: String(
                (event.payload as Record<string, unknown>)?.error ?? "Step failed",
              ),
            };
          }
        }
        if (event.type === "RUN_SUCCEEDED") {
          yield { type: "done", exitCode: 0 };
          return;
        }
        if (event.type === "RUN_FAILED" || event.type === "RUN_CANCELLED") {
          yield { type: "done", exitCode: 1 };
          return;
        }
      }
    } finally {
      controller.abort();
    }
  }
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
