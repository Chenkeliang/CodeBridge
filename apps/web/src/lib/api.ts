import { parseSseFrames } from "./sse";
import type {
  AgentCommand,
  AgentProfile,
  AgentSession,
  ApprovalRecord,
  ConfigOption,
  FlowRecord,
  MessageAttachmentInput,
  RunRecord,
  SessionEvent,
} from "./types";

let runtimeToken = "";

export function setRuntimeToken(token: string): void {
  runtimeToken = token;
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${runtimeToken}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string; detail?: string } | null;
    throw new Error(payload?.detail ?? payload?.error ?? `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  agents: async () => (await request<{ agents: AgentProfile[] }>("/v1/agents")).agents,
  sessions: async (importProvider = false) =>
    (await request<{ sessions: AgentSession[] }>(`/v1/sessions${importProvider ? "?import=true" : ""}`)).sessions,
  session: (id: string) => request<AgentSession>(`/v1/sessions/${encodeURIComponent(id)}`),
  openSession: async (id: string) => {
    const encodedId = encodeURIComponent(id);
    const session = await request<AgentSession>(`/v1/sessions/${encodedId}`);
    const [events, commands, options, runs] = await Promise.all([
      fetchSessionEvents(id, 0),
      request<{ commands?: AgentCommand[] }>(`/v1/sessions/${encodedId}/commands`),
      request<{ options?: ConfigOption[] }>(`/v1/sessions/${encodedId}/config-options`),
      request<{ runs: RunRecord[] }>(`/v1/sessions/${encodedId}/runs`),
    ]);
    return {
      session,
      events,
      commands: commands.commands ?? [],
      options: options.options ?? [],
      runs: runs.runs,
    };
  },
  createSession: (agentId: string) =>
    request<AgentSession>("/v1/sessions", { method: "POST", body: JSON.stringify({ agent_id: agentId }) }),
  updateSession: (id: string, update: Record<string, unknown>) =>
    request<AgentSession>(`/v1/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(update) }),
  deleteSession: (id: string) => request<void>(`/v1/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  flows: async () => (await request<{ flows: FlowRecord[] }>("/v1/flows")).flows,
  configOptions: async (id: string) =>
    (await request<{ options?: ConfigOption[] }>(`/v1/sessions/${encodeURIComponent(id)}/config-options`)).options ?? [],
  commands: async (id: string) =>
    (await request<{ commands?: AgentCommand[] }>(`/v1/sessions/${encodeURIComponent(id)}/commands`)).commands ?? [],
  pickDirectory: (id: string) =>
    request<AgentSession | { cancelled: true }>(`/v1/sessions/${encodeURIComponent(id)}/directories/pick`, { method: "POST", body: "{}" }),
  sendMessage: (id: string, message: string, flowId: string | null, model: string | null, attachments: MessageAttachmentInput[] = []) =>
    request<{ sequence: number }>(`/v1/sessions/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ message, flow_id: flowId, model, attachments }),
    }),
  runs: async (id: string) =>
    (await request<{ runs: RunRecord[] }>(`/v1/sessions/${encodeURIComponent(id)}/runs`)).runs,
  startRun: (id: string, flowId: string | null, model: string | null) =>
    request<RunRecord>(`/v1/sessions/${encodeURIComponent(id)}/runs`, {
      method: "POST",
      body: JSON.stringify({ flow_id: flowId, model }),
    }),
  events: async (id: string, afterSequence = 0) => fetchSessionEvents(id, afterSequence),
  approvals: async (runId: string) =>
    (await request<{ approvals: ApprovalRecord[] }>(`/v1/runs/${encodeURIComponent(runId)}/approvals`)).approvals,
  approve: (runId: string, approvalId: string) =>
    request(`/v1/runs/${encodeURIComponent(runId)}/approve`, { method: "POST", body: JSON.stringify({ approval_id: approvalId }) }),
  reject: (runId: string, approvalId: string) =>
    request(`/v1/runs/${encodeURIComponent(runId)}/reject`, { method: "POST", body: JSON.stringify({ approval_id: approvalId }) }),
};

async function fetchSessionEvents(id: string, afterSequence: number): Promise<SessionEvent[]> {
  const response = await fetch(
    `/v1/sessions/${encodeURIComponent(id)}/events?after_sequence=${afterSequence}`,
    { headers: { authorization: `Bearer ${runtimeToken}` } },
  );
  if (!response.ok) throw new Error(`无法读取会话事件（HTTP ${response.status}）`);
  const parsed = parseSseFrames<SessionEvent>(await response.text());
  return parsed.events;
}

export async function streamSessionEvents(
  sessionId: string,
  afterSequence: number,
  signal: AbortSignal,
  onEvent: (event: SessionEvent) => void,
): Promise<void> {
  const response = await fetch(
    `/v1/sessions/${encodeURIComponent(sessionId)}/events?live=true&after_sequence=${afterSequence}`,
    { headers: { authorization: `Bearer ${runtimeToken}` }, signal },
  );
  if (!response.ok || !response.body) throw new Error("无法连接事件流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const chunk = await reader.read();
    if (chunk.done) return;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parsed = parseSseFrames<SessionEvent>(buffer);
    buffer = parsed.remainder;
    parsed.events.forEach(onEvent);
  }
}
