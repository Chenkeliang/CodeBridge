import type { Hono } from "hono";
import type {
  AgentEvent,
  ChannelSessionIngress,
  ChannelSessionMessage,
} from "@codebridge/core";

interface AcceptedChannelMessage {
  session_id: string;
  event_sequence: number;
}

interface SessionEvent {
  type?: string;
  payload?: { event?: AgentEvent } & Record<string, unknown>;
}

export function createChannelSessionIngress(app: Hono, token: string): ChannelSessionIngress {
  const ingress = async function* (message: ChannelSessionMessage): AsyncGenerator<AgentEvent> {
    const accepted = await app.request(
      `/v1/channels/${encodeURIComponent(message.channel)}/conversations/${encodeURIComponent(message.conversationId)}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(message.idempotencyKey ? { "idempotency-key": message.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          message: message.message,
          agent_id: message.agentId,
          cwd: message.cwd,
          model: message.model,
          flow_id: message.flowId,
        }),
      },
    );
    if (!accepted.ok) throw new Error(`Channel ingress failed (${accepted.status}): ${await accepted.text()}`);
    const result = await accepted.json() as AcceptedChannelMessage;
    const controller = new AbortController();
    const signal = message.signal
      ? AbortSignal.any([message.signal, controller.signal])
      : controller.signal;
    try {
      const response = await app.request(
        `/v1/sessions/${encodeURIComponent(result.session_id)}/events?live=true&after_sequence=${result.event_sequence}`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal,
        },
      );
      if (!response.ok || !response.body) {
        throw new Error(`Channel event stream failed (${response.status})`);
      }
      for await (const event of readSessionEvents(response.body)) {
        if (event.type === "AGENT_EVENT" && event.payload?.event) yield event.payload.event;
        if (event.type === "APPROVAL_REQUESTED") {
          yield {
            type: "permission_request",
            requestId: String((event.payload as Record<string, unknown> | undefined)?.approval_id ?? "approval"),
            title: "此步骤需要审批，请在 Web Workbench 中确认",
          };
        }
        if (event.type === "STEP_FAILED") {
          yield { type: "error", message: String((event.payload as Record<string, unknown> | undefined)?.error ?? "Step failed") };
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
  };
  ingress.cancel = async (channel: string, conversationId: string): Promise<boolean> => {
    const response = await app.request(`/v1/channels/${encodeURIComponent(channel)}/conversations/${encodeURIComponent(conversationId)}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return false;
    return (await response.json() as { stopped?: boolean }).stopped === true;
  };
  ingress.resolveApproval = async (channel: string, conversationId: string, approve: boolean): Promise<boolean> => {
    const response = await app.request(`/v1/channels/${encodeURIComponent(channel)}/conversations/${encodeURIComponent(conversationId)}/approval`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ approve }),
    });
    if (!response.ok) return false;
    return (await response.json() as { resolved?: boolean }).resolved === true;
  };
  ingress.reset = async (channel: string, conversationId: string): Promise<boolean> => {
    const response = await app.request(`/v1/channels/${encodeURIComponent(channel)}/conversations/${encodeURIComponent(conversationId)}/reset`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return false;
    return (await response.json() as { reset?: boolean }).reset === true;
  };
  return ingress;
}

async function* readSessionEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SessionEvent> {
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
