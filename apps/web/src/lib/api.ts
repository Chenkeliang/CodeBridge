import { parseSseFrames } from "./sse";
import { parseSessionEventWire } from "@codebridge/core/session-event-wire";
import type {
  AgentCommand,
  AgentListResponse,
  AgentProfile,
  AgentSession,
  ApprovalRecord,
  ConfigOption,
  FlowCapability,
  FlowBatchDraft,
  FlowBatchSnapshot,
  FlowRecommendation,
  FlowRecord,
  FlowReviewContext,
  MessageAttachmentInput,
  PiProvider,
  PiProviderPreset,
  ProviderHistoryImportResult,
  ProviderHistoryPreview,
  RunRecord,
  SessionCancelRunResult,
  SessionCompositeSnapshot,
  SessionEvent,
  SessionMessageReceipt,
  SessionRuntimeView,
  SessionSnapshot,
  SessionTimelinePage,
  SessionTurnView,
  SendMessageInput,
  SkillAssignmentInput,
  SkillCatalogSnapshot,
  SkillMutationKind,
  SkillMutationPlan,
  SkillMutationResult,
  TimelineSegmentPage,
  WorkspaceListing,
} from "./types";

let runtimeToken = "";

export function setRuntimeToken(token: string): void {
  runtimeToken = token;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body: ErrorPayload | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ErrorPayload = {
  error?: string;
  code?: string;
  detail?: string;
  details?: string;
  message?: string;
  issues?: string[];
  missing?: Array<{ id: string; type: string; source: string; reason: string }>;
  source?: "binding" | "request";
  flow_id?: string;
  expected_definition_revision?: string;
  current_definition_revision?: string;
  requires_confirmation?: boolean;
} | null;

type SessionEventsPage = {
  events: SessionEvent[];
  next_sequence: number;
  has_more: boolean;
};

function mergeHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers);
  if (runtimeToken && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${runtimeToken}`);
  }
  if (init.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return headers;
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: mergeHeaders(init),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as ErrorPayload;
    const issueText = payload?.issues?.length ? payload.issues.join("; ") : undefined;
    const message = [payload?.message, payload?.detail ?? payload?.details ?? issueText]
      .filter((part): part is string => Boolean(part))
      .join(" · ") || `HTTP ${response.status}`;
    throw new ApiError(response.status, payload?.code ?? payload?.error ?? "http_error", message, payload);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function openSession(id: string): Promise<SessionCompositeSnapshot> {
  const snapshot = await request<SessionSnapshot>('/v1/sessions/' + encodeURIComponent(id));
  const composite = snapshot as SessionCompositeSnapshot;
  return {
    ...composite,
    events: composite.events ?? [],
    options: composite.options ?? [],
    runs: composite.runs ?? [],
  };
}

async function importSessions(input: { cwd?: string; agentId?: string } = {}): Promise<{ sessions: AgentSession[]; provider_errors: unknown[] }> {
  return request<{ sessions: AgentSession[]; provider_errors: unknown[] }>("/v1/sessions/import", {
    method: "POST",
    body: JSON.stringify({ cwd: input.cwd, agent_id: input.agentId }),
  });
}

function sendMessage(id: string, message: string, flowId: string | null, model: string | null, attachments: MessageAttachmentInput[], permissionMode: string | null, effort: string | null): Promise<SessionMessageReceipt>;
function sendMessage(id: string, input: SendMessageInput): Promise<SessionMessageReceipt>;
function sendMessage(
  id: string,
  messageOrInput: string | SendMessageInput,
  flowId?: string | null,
  model?: string | null,
  attachments: MessageAttachmentInput[] = [],
  permissionMode?: string | null,
  effort?: string | null,
): Promise<SessionMessageReceipt> {
  const input: SendMessageInput = typeof messageOrInput === "string"
    ? {
      message: messageOrInput,
      flowId: flowId ?? null,
      model: model ?? null,
      attachments,
      permissionMode: permissionMode ?? null,
      effort: effort ?? null,
      idempotencyKey: "",
    }
    : messageOrInput;

  const headers = input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : undefined;
  const body = {
    message: input.message,
    ...(Object.hasOwn(input, "flowId") ? { flow_id: input.flowId } : {}),
    ...(Object.hasOwn(input, "definitionRevision")
      ? { definition_revision: input.definitionRevision }
      : {}),
    model: input.model,
    permission_mode: input.permissionMode,
    effort: input.effort,
    attachments: input.attachments,
    inputs: input.inputs,
    dry_run: input.dryRun === true,
  };
  return request<SessionMessageReceipt>(`/v1/sessions/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    ...(headers ? { headers } : {}),
    body: JSON.stringify(body),
  });
}

function cancelRun(id: string): Promise<{ stopped: boolean; run_id?: string }>;
function cancelRun(runId: string, runtimeVersion: number, key: string): Promise<{ stopped?: boolean; run_id?: string } & SessionCancelRunResult>;
function cancelRun(
  id: string,
  runtimeVersion?: number,
  key?: string,
): Promise<
  { stopped: boolean; run_id?: string }
  | ({ stopped?: boolean; run_id?: string } & SessionCancelRunResult)
> {
  if (typeof runtimeVersion === "number" && typeof key === "string") {
    return request<{ stopped?: boolean; run_id?: string } & SessionCancelRunResult>(`/v1/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: {
        "Idempotency-Key": key,
        "If-Match": String(runtimeVersion),
      },
    });
  }
  return request<{ stopped: boolean; run_id?: string }>(`/v1/sessions/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: "{}",
  });
}

async function events(id: string, afterSequence = 0): Promise<SessionEventsPage> {
  const params = new URLSearchParams({ after_sequence: String(afterSequence) });
  const page = await request<{
    events: unknown;
    next_sequence: unknown;
    has_more: unknown;
  }>(`/v1/sessions/${encodeURIComponent(id)}/events?${params}`);
  if (
    !Array.isArray(page.events)
    || !Number.isInteger(page.next_sequence)
    || typeof page.has_more !== "boolean"
  ) {
    throw new Error("session_event_schema_mismatch");
  }
  return {
    events: page.events.map(parseSessionEventWire),
    next_sequence: page.next_sequence as number,
    has_more: page.has_more,
  };
}

async function queue(sessionId: string, afterPosition: number | null): Promise<SessionRuntimeView["queue"]> {
  const params = new URLSearchParams({ limit: "100" });
  if (afterPosition !== null) params.set("after_position", String(afterPosition));
  return request<SessionRuntimeView["queue"]>(`/v1/sessions/${encodeURIComponent(sessionId)}/queue?${params}`);
}

async function timeline(sessionId: string, before: number): Promise<SessionTimelinePage> {
  const params = new URLSearchParams({ before: String(before), limit: "50" });
  return request<SessionTimelinePage>(`/v1/sessions/${encodeURIComponent(sessionId)}/timeline?${params}`);
}

async function segments(sessionId: string, blockId: string, after: number): Promise<TimelineSegmentPage> {
  const params = new URLSearchParams({ after: String(after), limit: "100" });
  return request<TimelineSegmentPage>(`/v1/sessions/${encodeURIComponent(sessionId)}/blocks/${encodeURIComponent(blockId)}/segments?${params}`);
}

async function resumeQueue(sessionId: string, version: number, key: string): Promise<{ runtime: SessionRuntimeView }> {
  return request<{ runtime: SessionRuntimeView }>(`/v1/sessions/${encodeURIComponent(sessionId)}/queue/resume`, {
    method: "POST",
    headers: {
      "Idempotency-Key": key,
      "If-Match": String(version),
    },
  });
}

async function cancelQueuedTurn(sessionId: string, turnId: string, version: number, key: string): Promise<{ turn: SessionTurnView; runtime: SessionRuntimeView }> {
  return request<{ turn: SessionTurnView; runtime: SessionRuntimeView }>(`/v1/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(turnId)}`, {
    method: "DELETE",
    headers: {
      "Idempotency-Key": key,
      "If-Match": String(version),
    },
  });
}

async function submission(id: string, key: string): Promise<SessionMessageReceipt> {
  return request<SessionMessageReceipt>(`/v1/sessions/${encodeURIComponent(id)}/submissions/${encodeURIComponent(key)}`);
}

async function startRun(id: string, flowId: string | null, model: string | null, permissionMode: string | null = null, effort: string | null = null): Promise<RunRecord> {
  return request<RunRecord>(`/v1/sessions/${encodeURIComponent(id)}/runs`, {
    method: "POST",
    body: JSON.stringify({ flow_id: flowId, model, permission_mode: permissionMode, effort }),
  });
}

export const api = {
  skills: () => request<SkillCatalogSnapshot>("/v1/skills"),
  pickSkillSource: () => request<SkillCatalogSnapshot | { cancelled: true }>(
    "/v1/skills/sources/pick",
    { method: "POST", body: "{}" },
  ),
  previewSkillAssignment: (input: SkillAssignmentInput) =>
    request<SkillMutationPlan>("/v1/skills/assignments/preview", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  previewSkillAdopt: (skillId: string) =>
    request<SkillMutationPlan>(`/v1/skills/${encodeURIComponent(skillId)}/adopt/preview`, {
      method: "POST",
    }),
  previewSkillGlobalState: (skillId: string, enabled: boolean) =>
    request<SkillMutationPlan>(`/v1/skills/${encodeURIComponent(skillId)}/global-state/preview`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  previewSkillUnmanage: (skillId: string) =>
    request<SkillMutationPlan>(`/v1/skills/${encodeURIComponent(skillId)}/unmanage/preview`, {
      method: "POST",
    }),
  applySkillPlan: (kind: SkillMutationKind, planId: string) =>
    request<SkillMutationResult>(`/v1/skills/${kind}-plans/${encodeURIComponent(planId)}/apply`, {
      method: "POST",
    }),
  agents: () => request<AgentListResponse>("/v1/agents"),
  fetchFlow: (flowId: string) =>
    request<FlowRecord>("/v1/flows/" + encodeURIComponent(flowId)),
  detectAgent: (agentId: string) =>
    request<AgentProfile>(`/v1/agents/${encodeURIComponent(agentId)}/detect`, {
      method: "POST",
    }),
  detectAllAgents: () =>
    request<AgentListResponse>("/v1/agents/detect", { method: "POST" }),
  installAgent: (agentId: string, strategyId: string) =>
    request<AgentProfile>(`/v1/agents/${encodeURIComponent(agentId)}/install`, {
      method: "POST",
      body: JSON.stringify({ strategy_id: strategyId }),
    }),
  setDefaultAgent: (agentId: string) =>
    request<AgentListResponse>("/v1/settings/default-agent", {
      method: "PATCH",
      body: JSON.stringify({ agent_id: agentId }),
    }),
  sessions: async (importProvider = false, includeArchived = false) => {
    const params = new URLSearchParams();
    if (importProvider) params.set("import", "true");
    if (includeArchived) params.set("include_archived", "true");
    const query = params.toString();
    return (await request<{ sessions: AgentSession[] }>(`/v1/sessions${query ? `?${query}` : ""}`)).sessions;
  },
  importSessions,
  session: (id: string) => request<AgentSession>(`/v1/sessions/${encodeURIComponent(id)}`),
  openSession,
  previewProviderHistory: (sessionId: string) =>
    request<ProviderHistoryPreview>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/provider-history/preview`,
      { method: "POST" },
    ),
  importProviderHistory: (sessionId: string, idempotencyKey: string) =>
    request<ProviderHistoryImportResult>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/provider-history/import`,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ confirm: true }),
      },
    ),
  createSession: (agentId: string) =>
    request<AgentSession>("/v1/sessions", { method: "POST", body: JSON.stringify({ agent_id: agentId }) }),
  updateSession: (id: string, update: Record<string, unknown>) =>
    request<AgentSession>(`/v1/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(update) }),
  deleteSession: (id: string) => request<void>(`/v1/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  flows: async (view: "manage" | "consume") =>
    (await request<{ flows: FlowRecord[] }>(`/v1/flows?view=${view}`)).flows,
  flowCapabilities: async () =>
    (await request<{ capabilities: FlowCapability[] }>("/v1/capabilities")).capabilities,
  flowRecommendations: async (sessionId: string) =>
    (await request<{ recommendations: FlowRecommendation[] }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/flow-recommendations`,
    )).recommendations,
  dismissFlowRecommendation: (sessionId: string, runId: string, flowId: string) =>
    request<{ status: "dismissed" }>(
      `/v1/flows/recommendations/${encodeURIComponent(runId)}/dismiss`,
      {
        method: "POST",
        body: JSON.stringify({ session_id: sessionId, flow_id: flowId }),
      },
    ),
  createGuide: (flow: Pick<FlowRecord, "name" | "description" | "steps">) =>
    request<FlowRecord>("/v1/flows/guides", {
      method: "POST",
      body: JSON.stringify({ flow }),
    }),
  saveGuideDraft: (flow: FlowRecord) =>
    request<FlowRecord>(`/v1/flows/${encodeURIComponent(flow.flow_id)}/guide`, {
      method: "PUT",
      body: JSON.stringify({
        flow: { name: flow.name, description: flow.description, steps: flow.steps },
      }),
    }),
  flowReviewContext: (flowId: string) =>
    request<FlowReviewContext>(`/v1/flows/${encodeURIComponent(flowId)}/review-context`),
  createCandidate: (sessionId: string, runId: string) =>
    request<FlowRecord>("/v1/flows/candidates", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId, run_id: runId }),
    }),
  saveCandidate: (sessionId: string, flow: FlowRecord) =>
    request<FlowRecord>("/v1/flows/candidates", {
      method: "POST",
      body: JSON.stringify({
        session_id: sessionId,
        flow: {
          ...(flow.flow_id ? { flow_id: flow.flow_id } : {}),
          ...(flow.parent_flow_id ? { parent_flow_id: flow.parent_flow_id } : {}),
          name: flow.name,
          description: flow.description,
          kind: flow.kind,
          inputs: flow.inputs,
          steps: flow.steps,
        },
      }),
    }),
  reviewFlow: (flowId: string, decision: "approve" | "reject", gitRevision?: string) =>
    request<FlowRecord>(`/v1/flows/${encodeURIComponent(flowId)}/review`, {
      method: "POST",
      body: JSON.stringify({
        decision,
        ...(decision === "approve" ? { git_revision: gitRevision ?? "" } : {}),
      }),
    }),
  deprecateFlow: (flowId: string) =>
    request<FlowRecord>(`/v1/flows/${encodeURIComponent(flowId)}/deprecate`, {
      method: "POST",
      body: "{}",
    }),
  applyFlow: (sessionId: string, flowId: string) =>
    request<{
      flow_id: string;
      definition_revision: string;
    }>(`/v1/flows/${encodeURIComponent(flowId)}/apply`, {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId }),
    }),
  unbindFlow: (sessionId: string) =>
    request<AgentSession>(`/v1/sessions/${encodeURIComponent(sessionId)}/flow`, {
      method: "DELETE",
    }),
  flowBatchDraft: (draftId: string) =>
    request<FlowBatchDraft>(`/v1/flow-invocation-drafts/${encodeURIComponent(draftId)}`),
  updateFlowBatchDraft: (draft: Pick<FlowBatchDraft, "draft_id" | "revision" | "global_inputs" | "items" | "source_refs">) =>
    request<FlowBatchDraft>(`/v1/flow-invocation-drafts/${encodeURIComponent(draft.draft_id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        draft_revision: draft.revision,
        global_inputs: draft.global_inputs,
        items: draft.items,
        source_refs: draft.source_refs,
      }),
    }),
  confirmFlowBatchDraft: (draftId: string, revision: number, key: string, concurrency?: number) =>
    request<FlowBatchSnapshot>(`/v1/flow-invocation-drafts/${encodeURIComponent(draftId)}/confirm`, {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ draft_revision: revision, ...(concurrency ? { concurrency } : {}) }),
    }),
  cancelFlowBatchDraft: (draftId: string) =>
    request<FlowBatchDraft>(`/v1/flow-invocation-drafts/${encodeURIComponent(draftId)}/cancel`, {
      method: "POST",
      body: "{}",
    }),
  flowBatch: (batchId: string) =>
    request<FlowBatchSnapshot>(`/v1/flow-batches/${encodeURIComponent(batchId)}`),
  cancelFlowBatch: (batchId: string) =>
    request<FlowBatchSnapshot>(`/v1/flow-batches/${encodeURIComponent(batchId)}/cancel`, {
      method: "POST",
      body: "{}",
    }),
  retryFailedFlowBatch: (batchId: string, key: string) =>
    request<FlowBatchSnapshot>(`/v1/flow-batches/${encodeURIComponent(batchId)}/retry-failed`, {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: "{}",
    }),
  configOptions: async (id: string) =>
    (await request<{ options?: ConfigOption[] }>(`/v1/sessions/${encodeURIComponent(id)}/config-options`)).options ?? [],
  providers: async () =>
    (await request<{ providers?: Record<string, PiProvider> }>("/v1/providers")).providers ?? {},
  saveProviders: (file: { providers: Record<string, PiProvider> }) =>
    request<{ ok: boolean }>("/v1/providers", { method: "PUT", body: JSON.stringify(file) }),
  providerPresets: async () =>
    (await request<{ presets?: PiProviderPreset[] }>("/v1/providers/presets")).presets ?? [],
  testProvider: (provider: { baseUrl: string; apiKey?: string; authHeader?: boolean; api?: string; model?: string }) =>
    request<{ ok: boolean; detail: string; compatSuggestion?: Record<string, unknown> }>("/v1/providers/test", { method: "POST", body: JSON.stringify(provider) }),
  commands: async (id: string) =>
    (await request<{ commands?: AgentCommand[] }>(`/v1/sessions/${encodeURIComponent(id)}/commands`)).commands ?? [],
  pickDirectory: (id: string) =>
    request<AgentSession | { cancelled: true }>(`/v1/sessions/${encodeURIComponent(id)}/directories/pick`, { method: "POST", body: "{}" }),
  workspaceEntries: (id: string, root?: string, relativePath = "") => {
    const params = new URLSearchParams({ path: relativePath });
    if (root) params.set("root", root);
    return request<WorkspaceListing>(`/v1/sessions/${encodeURIComponent(id)}/files?${params}`);
  },
  sendMessage,
  runs: async (id: string) =>
    (await request<{ runs: RunRecord[] }>(`/v1/sessions/${encodeURIComponent(id)}/runs`)).runs,
  cancelRun,
  startRun,
  events,
  approvals: async (runId: string) =>
    (await request<{ approvals: ApprovalRecord[] }>(`/v1/runs/${encodeURIComponent(runId)}/approvals`)).approvals,
  approve: (runId: string, approvalId: string) =>
    request(`/v1/runs/${encodeURIComponent(runId)}/approve`, { method: "POST", body: JSON.stringify({ approval_id: approvalId }) }),
  reject: (runId: string, approvalId: string) =>
    request(`/v1/runs/${encodeURIComponent(runId)}/reject`, { method: "POST", body: JSON.stringify({ approval_id: approvalId }) }),
  queue,
  timeline,
  segments,
  resumeQueue,
  cancelQueuedTurn,
  submission,
};

export async function streamSessionEvents(
  sessionId: string,
  afterSequence: number,
  signal: AbortSignal,
  onEvent: (event: SessionEvent) => void,
): Promise<void> {
  const response = await fetch(
    `/v1/sessions/${encodeURIComponent(sessionId)}/events?live=true&after_sequence=${afterSequence}`,
    { headers: mergeHeaders({}), signal },
  );
  if (!response.ok || !response.body) throw new Error("无法连接事件流");
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    throw new Error("session_event_transport_mismatch");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = parseSseFrames<unknown>(buffer);
      buffer = parsed.remainder;
      parsed.events.map(parseSessionEventWire).forEach(onEvent);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
