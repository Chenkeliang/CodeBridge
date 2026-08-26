import { randomUUID } from "node:crypto";
import {
  FLOW_SAVE_TOOL_NAME,
  PI_FLOW_SAVE_TOOL_NAME,
  parseRequestFlowSaveInput,
  parseRequestFlowSaveOutput,
  type RequestFlowSaveInput,
  type RequestFlowSaveOutput,
} from "@codebridge/core";
import type { FlowCatalogStore, FlowRecord } from "@codebridge/flow-catalog";
import type { AgentSession } from "@codebridge/session-catalog";
import type { SessionCatalogStore } from "@codebridge/session-catalog";
import type { DomainEvent, Run, SqliteEventStore, WorkItem } from "@codebridge/work-items";
import {
  compileWorkflow,
  definitionHash,
  WorkflowValidationError,
} from "@codebridge/workflow-engine";

const MAX_EXTRACTED_STEPS = 24;
const MAX_EXTRACTED_PURPOSE_CHARACTERS = 240;
const MAX_SOURCE_TEXT_CHARACTERS = 4_096;
const MAX_FLOW_SAVE_RESULT_DEPTH = 6;
const MAX_FLOW_SAVE_RESULT_NODES = 64;
const MAX_FLOW_SAVE_RESULT_ARRAY_ITEMS = 32;
const MAX_FLOW_SAVE_RESULT_OBJECT_KEYS = 32;
const FLOW_SAVE_ACP_SERVER_NAME = "codebridge-internal";

export interface ExtractRunDefinitionInput {
  session: Pick<AgentSession, "id" | "agentId">;
  run: Run;
  title: string;
  events: DomainEvent[];
}

export type FlowSaveRequestId = `fsr_${string}`;
export type FlowSaveRequestSource = "agent_intent" | "turn_action";
export type FlowSaveRequestStatus = "requested" | "dismissed" | "completed" | "failed";

export interface FlowSaveRequest {
  requestId: FlowSaveRequestId;
  sessionId: string;
  requestTurnId: string;
  requestRunId: string;
  sourceTurnId: string;
  sourceRunId: string;
  sourceTitle: string;
  source: FlowSaveRequestSource;
  userMessage: string;
  intentSummary: string | null;
  nameHint: string | null;
  sourceImported: boolean;
  createdAt: string;
}

export type FlowSaveRequestState =
  | { state: "requested"; request: FlowSaveRequest }
  | { state: "dismissed"; request: FlowSaveRequest }
  | { state: "completed"; request: FlowSaveRequest; flowId: string; definitionRevision: string }
  | { state: "failed"; request: FlowSaveRequest; code: string };

export interface FlowSaveConfirmResult {
  request: FlowSaveRequest;
  flow: FlowRecord;
}

export class FlowSaveIntentError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 503,
  ) {
    super(code);
    this.name = "FlowSaveIntentError";
  }
}

export function createFlowSaveRequestId(): FlowSaveRequestId {
  return `fsr_${randomUUID().replaceAll("-", "")}`;
}

export function candidateFlowId(requestId: FlowSaveRequestId): string {
  return `flow_save_${definitionHash({ request_id: requestId }).slice(-32)}`;
}

export function buildCandidateDefinition(input: {
  flowId: string;
  name: string;
  description: string | null | undefined;
  inputs: unknown[];
  steps: unknown[];
}) {
  return {
    schema_version: 1 as const,
    workflow_id: input.flowId,
    name: input.name,
    kind: "runbook" as const,
    status: "draft" as const,
    description: input.description ?? undefined,
    inputs: input.inputs,
    steps: input.steps,
  };
}

interface FlowSaveIntentServiceOptions {
  sessions: SessionCatalogStore;
  events: SqliteEventStore;
  catalog?: FlowCatalogStore;
  extract?: typeof extractRunDefinition;
}

interface WorkItemEventSnapshot {
  workItemId: string;
  events: DomainEvent[];
  eventsByRunId: ReadonlyMap<string, DomainEvent[]>;
}

function parseFlowSaveToolStartInput(
  agentEvent: Record<string, unknown> | null,
): RequestFlowSaveInput {
  if (!agentEvent) throw new Error("invalid_flow_save_tool_input");
  const value = agentEvent.input;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const envelope = value as Record<string, unknown>;
    const keys = Reflect.ownKeys(envelope);
    if (
      keys.length === 3
      && Object.hasOwn(envelope, "server")
      && Object.hasOwn(envelope, "tool")
      && Object.hasOwn(envelope, "arguments")
    ) {
      if (
        envelope.server !== FLOW_SAVE_ACP_SERVER_NAME
        || envelope.tool !== FLOW_SAVE_TOOL_NAME
      ) throw new Error("invalid_flow_save_tool_input");
      return parseRequestFlowSaveInput(envelope.arguments);
    }
  }
  if (agentEvent.name === PI_FLOW_SAVE_TOOL_NAME) {
    return parseRequestFlowSaveInput(value);
  }
  throw new Error("invalid_flow_save_tool_input");
}

function workItemEventSnapshot(
  workItemId: string,
  events: DomainEvent[],
): WorkItemEventSnapshot {
  const eventsByRunId = new Map<string, DomainEvent[]>();
  for (const event of events) {
    if (event.workItemId !== workItemId || event.runId === null) continue;
    const scoped = eventsByRunId.get(event.runId);
    if (scoped) scoped.push(event);
    else eventsByRunId.set(event.runId, [event]);
  }
  return { workItemId, events, eventsByRunId };
}

function containsFlowSaveToolStart(events: readonly DomainEvent[]): boolean {
  return events.some((event) => {
    const agentEvent = agentEventValue(event);
    if (agentEvent?.type !== "tool_start") return false;
    try {
      parseFlowSaveToolStartInput(agentEvent);
      return true;
    } catch {
      return false;
    }
  });
}

export class FlowSaveIntentService {
  private readonly extract: typeof extractRunDefinition;

  constructor(private readonly options: FlowSaveIntentServiceOptions) {
    this.extract = options.extract ?? extractRunDefinition;
  }

  previewPreviousSource(input: {
    sessionId: string;
    currentRunId: string;
  }):
    | { available: true }
    | { available: false; code: "no_extractable_previous_run"; message: string } {
    const current = this.options.events.getRun(input.currentRunId);
    if (!current || current.sessionId !== input.sessionId) return noPreviousSource();
    const events = this.options.events.listEvents(current.workItemId);
    const snapshot = workItemEventSnapshot(current.workItemId, events);
    const boundary = events.find((event) =>
      event.type === "RUN_CREATED" && event.runId === current.id
    )?.sequence ?? Number.MAX_SAFE_INTEGER;
    return this.findPreviousSource(input.sessionId, current, boundary, snapshot)
      ? { available: true }
      : noPreviousSource();
  }

  requestManual(input: {
    sessionId: string;
    sourceRunId: string;
    intentSummary?: string;
    nameHint?: string;
  }, idempotencyKey: string): FlowSaveRequest {
    const context = this.requireSessionContext(input.sessionId);
    const inputHash = `flow-save-request:http:${input.sessionId}:${idempotencyKey}`;
    const existing = this.requestByInputHash(context.workItem.id, inputHash);
    if (existing) return existing;
    const source = this.requireExtractableSource(input.sessionId, input.sourceRunId);
    return this.appendRequested({
      workItem: context.workItem,
      requestRun: source.run,
      source,
      sourceType: "turn_action",
      userMessage: source.title,
      intentSummary: input.intentSummary,
      nameHint: input.nameHint,
      inputHash,
    });
  }

  requestFromTool(input: {
    sessionId: string;
    currentRunId: string;
    toolCallId: string;
  }): FlowSaveRequest {
    const current = this.options.events.getRun(input.currentRunId);
    if (!current || current.sessionId !== input.sessionId) {
      throw new FlowSaveIntentError("source_run_not_found", 404);
    }
    const inputHash = `flow-save-request:tool:${current.id}:${input.toolCallId}`;
    const events = this.options.events.listEvents(current.workItemId);
    const existing = events.find((event) =>
      event.type === "FLOW_SAVE_REQUESTED" && event.inputHash === inputHash
    );
    if (existing) return requestFromEvent(existing);
    const snapshot = workItemEventSnapshot(current.workItemId, events);
    const toolStart = events.find((event) => {
      const agentEvent = agentEventValue(event);
      return event.runId === current.id
        && agentEvent?.type === "tool_start"
        && agentEvent.toolCallId === input.toolCallId;
    });
    if (!toolStart) throw new FlowSaveIntentError("flow_save_tool_call_not_found", 409);
    let toolInput: ReturnType<typeof parseRequestFlowSaveInput>;
    try {
      toolInput = parseFlowSaveToolStartInput(agentEventValue(toolStart));
    } catch {
      throw new FlowSaveIntentError("flow_save_tool_call_not_found", 409);
    }
    const toolEnd = events.find((event) => {
      const agentEvent = agentEventValue(event);
      if (
        event.sequence <= toolStart.sequence
        || event.runId !== current.id
        || agentEvent?.type !== "tool_end"
        || agentEvent.toolCallId !== input.toolCallId
        || agentEvent.status !== "completed"
      ) return false;
      const result = flowSaveToolOutputFromAgentValue(agentEvent.output)
        ?? flowSaveToolOutputFromAgentValue(agentEvent.content);
      return result?.accepted === true;
    });
    if (!toolEnd) throw new FlowSaveIntentError("flow_save_tool_call_not_found", 409);
    const source = this.findPreviousSource(
      input.sessionId,
      current,
      toolStart.sequence,
      snapshot,
    );
    if (!source) throw new FlowSaveIntentError("no_extractable_previous_run", 409);
    const context = this.requireSessionContext(input.sessionId);
    return this.appendRequested({
      workItem: context.workItem,
      requestRun: current,
      source,
      sourceType: "agent_intent",
      userMessage: this.turnText(current) ?? context.workItem.title,
      intentSummary: toolInput.intent_summary,
      nameHint: toolInput.name_hint,
      inputHash,
    });
  }

  getRequestState(requestId: string): FlowSaveRequestState {
    const events = this.options.events.listEventsByTarget(requestId);
    const requested = events.find((event) => event.type === "FLOW_SAVE_REQUESTED");
    if (!requested) throw new FlowSaveIntentError("flow_save_request_not_found", 404);
    const request = requestFromEvent(requested);
    const terminal = [...events].reverse().find((event) =>
      event.type === "FLOW_SAVE_DISMISSED"
      || event.type === "FLOW_CANDIDATE_CREATED"
      || event.type === "FLOW_SAVE_FAILED"
    );
    if (!terminal) return { state: "requested", request };
    if (terminal.type === "FLOW_SAVE_DISMISSED") return { state: "dismissed", request };
    if (terminal.type === "FLOW_CANDIDATE_CREATED") {
      return {
        state: "completed",
        request,
        flowId: requiredPayloadString(terminal, "flow_id"),
        definitionRevision: requiredPayloadString(terminal, "definition_revision"),
      };
    }
    return {
      state: "failed",
      request,
      code: requiredPayloadString(terminal, "code"),
    };
  }

  dismiss(requestId: string, idempotencyKey: string): FlowSaveRequestState {
    const current = this.getRequestState(requestId);
    if (current.state === "dismissed") return current;
    if (current.state === "completed") {
      throw new FlowSaveIntentError("flow_save_request_already_completed", 409);
    }
    if (current.state === "failed") {
      throw new FlowSaveIntentError("flow_save_request_state_conflict", 409);
    }
    this.options.events.appendEventOnce({
      workItemId: this.requestWorkItem(current.request).id,
      runId: current.request.requestRunId,
      type: "FLOW_SAVE_DISMISSED",
      actor: "user",
      target: current.request.requestId,
      inputHash: `flow-save-dismiss:${current.request.requestId}:${idempotencyKey}`,
      payload: {
        request_id: current.request.requestId,
        source_run_id: current.request.sourceRunId,
      },
    });
    return this.getRequestState(requestId);
  }

  async confirm(requestId: string, _idempotencyKey: string): Promise<FlowSaveConfirmResult> {
    const current = this.getRequestState(requestId);
    if (current.state === "dismissed") {
      throw new FlowSaveIntentError("flow_save_request_already_dismissed", 409);
    }
    if (current.state === "failed") {
      throw new FlowSaveIntentError("flow_save_request_state_conflict", 409);
    }
    if (current.state === "completed") {
      const flow = this.options.catalog?.get(current.flowId);
      if (!flow) throw new FlowSaveIntentError("flow_catalog_unavailable", 503);
      if (!flowMatchesRequestIdentity(flow, current.request)) {
        this.appendFailed(current.request, "flow_save_candidate_conflict");
        throw new FlowSaveIntentError("flow_save_candidate_conflict", 409);
      }
      return { request: current.request, flow };
    }

    let existing: FlowSaveConfirmResult | null;
    try {
      existing = this.existingCandidateFor(current.request);
    } catch (error) {
      if (error instanceof FlowSaveIntentError) throw error;
      throw new FlowSaveIntentError("flow_catalog_unavailable", 503);
    }
    if (existing) return existing;

    let source: ExtractableSource;
    try {
      source = this.requireExtractableSource(
        current.request.sessionId,
        current.request.sourceRunId,
      );
    } catch (error) {
      if (error instanceof FlowSaveIntentError && error.status !== 503) {
        this.appendFailed(current.request, error.code);
      }
      throw error;
    }

    const catalog = this.options.catalog;
    if (!catalog) throw new FlowSaveIntentError("flow_catalog_unavailable", 503);
    let candidate: FlowRecord;
    try {
      candidate = materializeCandidate(catalog, current.request, source.extracted);
    } catch (error) {
      if (error instanceof FlowSaveIntentError) {
        if (error.code !== "flow_catalog_unavailable") this.appendFailed(current.request, error.code);
        throw error;
      }
      if (error instanceof WorkflowValidationError) {
        this.appendFailed(current.request, "flow_save_definition_invalid");
        throw new FlowSaveIntentError("flow_save_definition_invalid", 409);
      }
      if (error instanceof Error && error.message === "flow_catalog_unavailable") {
        throw new FlowSaveIntentError("flow_catalog_unavailable", 503);
      }
      throw new FlowSaveIntentError("flow_catalog_unavailable", 503);
    }
    this.appendCompleted(current.request, candidate);
    return { request: current.request, flow: candidate };
  }

  async reconcilePendingAtStartup(): Promise<number> {
    const catalog = this.options.catalog;
    if (!catalog) return 0;
    let repaired = 0;
    for (const workItem of this.options.events.listWorkItems()) {
      const requestIds = new Set(this.options.events.listEvents(workItem.id).flatMap((event) =>
        event.type === "FLOW_SAVE_REQUESTED" && typeof event.target === "string"
          ? [event.target]
          : []
      ));
      for (const requestId of requestIds) {
        let state: FlowSaveRequestState;
        try {
          state = this.getRequestState(requestId);
        } catch (error) {
          logReconciliationFailure(requestId, error);
          continue;
        }
        if (state.state !== "requested") continue;
        const candidate = catalog.get(candidateFlowId(state.request.requestId));
        if (!candidate) continue;
        try {
          if (!flowMatchesRequestIdentity(candidate, state.request)) {
            this.appendFailed(state.request, "flow_save_candidate_conflict");
            repaired += 1;
            continue;
          }
          this.appendCompleted(state.request, candidate);
          repaired += 1;
        } catch (error) {
          logReconciliationFailure(requestId, error);
        }
      }
    }
    return repaired;
  }

  private requireSessionContext(sessionId: string): {
    session: AgentSession;
    workItem: WorkItem;
  } {
    const session = this.options.sessions.getSession(sessionId);
    const workItem = session?.taskRecordId
      ? this.options.events.getWorkItem(session.taskRecordId)
      : this.options.events.getWorkItemBySessionId(sessionId);
    if (!session || !workItem) throw new FlowSaveIntentError("source_run_not_found", 404);
    return { session, workItem };
  }

  private requestByInputHash(workItemId: string, inputHash: string): FlowSaveRequest | null {
    const event = this.options.events.listEvents(workItemId).find((candidate) =>
      candidate.type === "FLOW_SAVE_REQUESTED" && candidate.inputHash === inputHash
    );
    return event ? requestFromEvent(event) : null;
  }

  private requireExtractableSource(
    sessionId: string,
    sourceRunId: string,
    snapshot?: WorkItemEventSnapshot,
  ): ExtractableSource {
    const session = this.options.sessions.getSession(sessionId);
    const run = this.options.events.getRun(sourceRunId);
    if (!session || !run || run.sessionId !== sessionId) {
      throw new FlowSaveIntentError("source_run_not_found", 404);
    }
    if (run.status !== "succeeded") {
      throw new FlowSaveIntentError("source_run_not_succeeded", 409);
    }
    const title = this.turnText(run);
    if (run.executionKind !== "agent" || !title) {
      throw new FlowSaveIntentError("source_run_not_extractable", 409);
    }
    const extracted = this.extract({
      session,
      run,
      title,
      events: snapshot && snapshot.workItemId === run.workItemId
        ? [...(snapshot.eventsByRunId.get(run.id) ?? [])]
        : this.options.events.listEvents(run.workItemId),
    });
    if (!extracted.ok) {
      throw new FlowSaveIntentError(
        extracted.code === "run_not_succeeded"
          ? "source_run_not_succeeded"
          : "source_run_not_extractable",
        409,
      );
    }
    return { run, title, extracted };
  }

  private findPreviousSource(
    sessionId: string,
    currentRun: Run,
    beforeSequence: number,
    snapshot: WorkItemEventSnapshot,
  ): ExtractableSource | null {
    if (snapshot.workItemId !== currentRun.workItemId) return null;
    const terminalRunIds = snapshot.events
      .filter((event) =>
        event.sequence < beforeSequence
        && event.type === "RUN_SUCCEEDED"
        && event.runId !== null
        && event.runId !== currentRun.id
      )
      .reverse()
      .map((event) => event.runId!);
    for (const runId of terminalRunIds) {
      if (containsFlowSaveToolStart(snapshot.eventsByRunId.get(runId) ?? [])) continue;
      try {
        return this.requireExtractableSource(sessionId, runId, snapshot);
      } catch (error) {
        if (error instanceof FlowSaveIntentError && error.status !== 503) continue;
        throw error;
      }
    }
    return null;
  }

  private appendRequested(input: {
    workItem: WorkItem;
    requestRun: Run;
    source: ExtractableSource;
    sourceType: FlowSaveRequestSource;
    userMessage: string;
    intentSummary?: string;
    nameHint?: string;
    inputHash: string;
  }): FlowSaveRequest {
    const requestId = createFlowSaveRequestId();
    const createdAt = new Date().toISOString();
    const event = this.options.events.appendEventOnce({
      workItemId: input.workItem.id,
      runId: input.requestRun.id,
      type: "FLOW_SAVE_REQUESTED",
      actor: input.sourceType === "turn_action" ? "user" : "agent",
      target: requestId,
      inputHash: input.inputHash,
      payload: {
        request_id: requestId,
        session_id: input.source.run.sessionId,
        request_turn_id: input.requestRun.turnId,
        request_run_id: input.requestRun.id,
        source_turn_id: input.source.run.turnId,
        source_run_id: input.source.run.id,
        source_title: readableSourceTitle(input.source.title),
        source: input.sourceType,
        user_message: input.userMessage,
        intent_summary: nullableHint(input.intentSummary),
        name_hint: nullableHint(input.nameHint),
        source_imported: input.source.extracted.sourceImported,
        created_at: createdAt,
      },
    });
    return requestFromEvent(event);
  }

  private turnText(run: Run): string | null {
    const text = run.turnId ? this.options.events.getTurn(run.turnId)?.message.text.trim() : "";
    return text || null;
  }

  private requestWorkItem(request: FlowSaveRequest): WorkItem {
    const run = this.options.events.getRun(request.requestRunId);
    const item = run ? this.options.events.getWorkItem(run.workItemId) : undefined;
    if (!item) throw new FlowSaveIntentError("flow_save_request_not_found", 404);
    return item;
  }

  private existingCandidateFor(request: FlowSaveRequest): FlowSaveConfirmResult | null {
    const candidate = this.options.catalog?.get(candidateFlowId(request.requestId));
    if (!candidate) return null;
    if (!flowMatchesRequestIdentity(candidate, request)) {
      this.appendFailed(request, "flow_save_candidate_conflict");
      throw new FlowSaveIntentError("flow_save_candidate_conflict", 409);
    }
    this.appendCompleted(request, candidate);
    return { request, flow: candidate };
  }

  private appendCompleted(request: FlowSaveRequest, flow: FlowRecord): void {
    this.options.events.appendEventOnce({
      workItemId: this.requestWorkItem(request).id,
      runId: request.requestRunId,
      type: "FLOW_CANDIDATE_CREATED",
      actor: "system",
      target: request.requestId,
      inputHash: `flow-save-candidate:${request.requestId}`,
      payload: {
        request_id: request.requestId,
        source_run_id: request.sourceRunId,
        flow_id: flow.flowId,
        definition_revision: flow.definitionRevision,
      },
    });
  }

  private appendFailed(request: FlowSaveRequest, code: string): void {
    this.options.events.appendEventOnce({
      workItemId: this.requestWorkItem(request).id,
      runId: request.requestRunId,
      type: "FLOW_SAVE_FAILED",
      actor: "system",
      target: request.requestId,
      inputHash: `flow-save-failed:${request.requestId}`,
      payload: {
        request_id: request.requestId,
        source_run_id: request.sourceRunId,
        code,
      },
    });
  }
}

interface ExtractableSource {
  run: Run;
  title: string;
  extracted: Extract<ExtractRunDefinitionResult, { ok: true }>;
}

function materializeCandidate(
  catalog: FlowCatalogStore,
  request: FlowSaveRequest,
  extracted: Extract<ExtractRunDefinitionResult, { ok: true }>,
): FlowRecord {
  const flowId = candidateFlowId(request.requestId);
  const existing = catalog.get(flowId);
  if (existing) {
    if (!flowMatchesRequestIdentity(existing, request)) {
      throw new FlowSaveIntentError("flow_save_candidate_conflict", 409);
    }
    return existing;
  }
  const definition = buildCandidateDefinition({
    flowId,
    name: nullableHint(request.nameHint) ?? extracted.name,
    description: extracted.description,
    inputs: [],
    steps: extracted.steps.map((step) => ({
      id: step.id,
      purpose: step.purpose,
      depends_on: step.dependsOn,
      mode: "manual" as const,
      approval: "none" as const,
    })),
  });
  const definitionRevision = definitionHash(definition);
  const plan = compileWorkflow(definition, {
    source: "agent_generated",
    definitionRevision,
    planId: `plan_${flowId}`,
  });
  return catalog.save({
    flowId,
    name: definition.name,
    description: extracted.description,
    kind: "runbook",
    status: "candidate",
    source: "agent_generated",
    definitionRevision,
    planIrHash: definitionHash(plan),
    inputs: plan.inputs,
    reviewStatus: "pending",
    gitRevision: null,
    validationIssues: extracted.warnings,
    steps: plan.steps.map((step) => ({
      id: step.id,
      capability: step.capabilityId ?? undefined,
      purpose: step.purpose ?? undefined,
      dependsOn: step.dependsOn,
      mode: step.risk,
      approval: step.approval,
      branches: step.branches,
      retry: step.retry ?? undefined,
      successWhen: step.successWhen ?? undefined,
    })),
    lineageRootFlowId: flowId,
    parentFlowId: null,
    provenance: {
      ...extracted.provenance,
      sourceRequestId: request.requestId,
    },
    publicationSequence: 0,
  });
}

function flowMatchesRequestIdentity(
  flow: FlowRecord,
  request: FlowSaveRequest,
): boolean {
  return (
    flow.status === "candidate"
    || flow.status === "published"
    || flow.status === "deprecated"
  ) && flow.flowId === candidateFlowId(request.requestId)
    && flow.kind === "runbook"
    && flow.provenance?.sourceRequestId === request.requestId
    && flow.provenance.sourceRunId === request.sourceRunId
    && flow.provenance.sourceSessionId === request.sessionId;
}

function logReconciliationFailure(requestId: string, error: unknown): void {
  console.error("Flow save intent request reconciliation failed:", requestId, error);
}

function requestFromEvent(event: DomainEvent): FlowSaveRequest {
  return {
    requestId: requiredPayloadString(event, "request_id") as FlowSaveRequestId,
    sessionId: requiredPayloadString(event, "session_id"),
    requestTurnId: requiredPayloadString(event, "request_turn_id"),
    requestRunId: requiredPayloadString(event, "request_run_id"),
    sourceTurnId: requiredPayloadString(event, "source_turn_id"),
    sourceRunId: requiredPayloadString(event, "source_run_id"),
    sourceTitle: requiredPayloadString(event, "source_title"),
    source: requiredPayloadString(event, "source") as FlowSaveRequestSource,
    userMessage: requiredPayloadString(event, "user_message"),
    intentSummary: optionalPayloadString(event, "intent_summary"),
    nameHint: optionalPayloadString(event, "name_hint"),
    sourceImported: event.payload.source_imported === true,
    createdAt: requiredPayloadString(event, "created_at"),
  };
}

function requiredPayloadString(event: DomainEvent, key: string): string {
  const value = event.payload[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Invalid ${event.type} payload: ${key}`);
  }
  return value;
}

function optionalPayloadString(event: DomainEvent, key: string): string | null {
  const value = event.payload[key];
  return typeof value === "string" && value ? value : null;
}

function nullableHint(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? Array.from(trimmed).slice(0, 240).join("") : null;
}

function readableSourceTitle(value: string): string {
  const firstLine = value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? value.trim();
  return Array.from(firstLine).slice(0, 240).join("");
}

function noPreviousSource(): {
  available: false;
  code: "no_extractable_previous_run";
  message: string;
} {
  return {
    available: false,
    code: "no_extractable_previous_run",
    message: "找不到可提取的上一次成功任务，请在目标回复的菜单中选择‘存为 Flow’。",
  };
}

export type ExtractRunDefinitionResult =
  | {
      ok: true;
      kind: "structured_plan" | "observed_trace";
      name: string;
      description: string | null;
      steps: Array<{ id: string; purpose: string; dependsOn: string[] }>;
      sourceFlowId: string;
      sourceDefinitionRevision: string;
      sourceImported: boolean;
      warnings: string[];
      provenance: {
        sourceRunId: string;
        sourceSessionId: string;
        sourceFlowId: string;
        sourceDefinitionRevision: string;
      };
    }
  | {
      ok: false;
      code: "run_not_succeeded" | "run_not_extractable";
      reason: string;
    };

interface ExtractedDefinition {
  kind: "structured_plan" | "observed_trace";
  name: string;
  description: string | null;
  steps: Array<{ id: string; purpose: string; dependsOn: string[] }>;
  sourceFlowId: string;
  sourceDefinitionRevision: string;
  warnings: string[];
}

export function extractRunDefinition(
  input: ExtractRunDefinitionInput,
): ExtractRunDefinitionResult {
  if (input.run.status !== "succeeded") {
    return {
      ok: false,
      code: "run_not_succeeded",
      reason: "Run 未成功，不能提取 Flow 定义",
    };
  }
  if (
    input.run.executionKind !== "agent"
    || input.run.sessionId !== input.session.id
  ) {
    return {
      ok: false,
      code: "run_not_extractable",
      reason: "只有当前 Session 的 Agent Run 可以提取 Flow 定义",
    };
  }

  const scopedInput = {
    ...input,
    events: input.events.filter((event) =>
      event.runId === input.run.id
      && event.workItemId === input.run.workItemId
    ),
  };
  const definition = extractStructuredPlan(scopedInput) ?? extractObservedTrace(scopedInput);
  if (!definition) {
    return {
      ok: false,
      code: "run_not_extractable",
      reason: "Run 没有结构化 Agent 计划，也没有足够的业务工具调用证据",
    };
  }

  return {
    ok: true,
    ...definition,
    sourceImported: scopedInput.events.some((event) => event.payload.imported === true),
    provenance: {
      sourceRunId: input.run.id,
      sourceSessionId: input.session.id,
      sourceFlowId: definition.sourceFlowId,
      sourceDefinitionRevision: definition.sourceDefinitionRevision,
    },
  };
}

function extractStructuredPlan(
  input: ExtractRunDefinitionInput,
): ExtractedDefinition | null {
  for (const event of [...input.events].reverse()) {
    if (event.type !== "FLOW_PROPOSED") continue;
    const rawFlow = event.payload.flow;
    if (!rawFlow || typeof rawFlow !== "object" || Array.isArray(rawFlow)) continue;
    const flow = rawFlow as Record<string, unknown>;
    const rawSteps = Array.isArray(flow.steps) ? flow.steps : [];
    let purposeTruncated = false;
    const validSteps = rawSteps.slice(0, MAX_EXTRACTED_STEPS).flatMap((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const step = raw as Record<string, unknown>;
      const rawPurpose = typeof step.purpose === "string" ? step.purpose : "";
      const boundedPurpose = boundPurpose(rawPurpose);
      if (boundedPurpose.truncated) purposeTruncated = true;
      const purpose = boundedPurpose.value;
      if (!purpose) return [];
      return [{
        rawId: typeof step.id === "string" && step.id.trim()
          ? step.id.trim()
          : `step_${index + 1}`,
        rawDependsOn: Array.isArray(step.depends_on)
          ? step.depends_on.filter((value): value is string => typeof value === "string")
          : null,
        purpose,
      }];
    });
    if (validSteps.length === 0) continue;

    const canonicalIds = new Map<string, string>();
    validSteps.forEach((step, index) => {
      if (!canonicalIds.has(step.rawId)) canonicalIds.set(step.rawId, `step_${index + 1}`);
    });
    const steps = validSteps.map(({ rawDependsOn, purpose }, index) => ({
      id: `step_${index + 1}`,
      purpose,
      dependsOn: rawDependsOn === null
        ? index ? [`step_${index}`] : []
        : rawDependsOn.flatMap((dependency) => canonicalIds.get(dependency) ?? []),
    }));
    const sourceFlowId = typeof flow.workflow_id === "string" && flow.workflow_id.trim()
      ? flow.workflow_id.trim()
      : `flow_ephemeral_${input.run.id}`;
    const sourceDefinitionRevision = typeof event.payload.definition_revision === "string"
      && event.payload.definition_revision.trim()
      ? event.payload.definition_revision.trim()
      : `agent:${definitionHash({ runId: input.run.id, steps })}`;

    return {
      kind: "structured_plan",
      name: sanitizeDefinitionName(
        typeof flow.name === "string" && flow.name.trim() ? flow.name : input.title,
        `${input.run.agentId ?? input.session.agentId} Run Flow`,
      ),
      description: `基于 ${input.run.agentId ?? input.session.agentId} 成功 Run 的结构化 Agent 计划提取。`,
      steps,
      sourceFlowId,
      sourceDefinitionRevision,
      warnings: [
        ...(rawSteps.length > MAX_EXTRACTED_STEPS
          ? [`结构化计划超过 ${MAX_EXTRACTED_STEPS} 个步骤，已截断`]
          : []),
        ...(purposeTruncated
          ? [`部分步骤说明超过 ${MAX_EXTRACTED_PURPOSE_CHARACTERS} 个字符，已截断`]
          : []),
      ],
    };
  }
  return null;
}

function extractObservedTrace(
  input: ExtractRunDefinitionInput,
): ExtractedDefinition | null {
  const managementToolCallIds = new Set(input.events.flatMap((event) => {
    const agentEvent = agentEventValue(event);
    if (
      agentEvent?.type !== "tool_end"
      || typeof agentEvent.toolCallId !== "string"
      || !(
        isFlowSaveToolResult(agentEvent.output)
        || isFlowSaveToolResult(agentEvent.content)
      )
    ) return [];
    return [agentEvent.toolCallId];
  }));
  const seenInvocationIds = new Set<string>();
  const toolCalls = input.events.flatMap((event) => {
    const agentEvent = agentEventValue(event);
    if (agentEvent?.type !== "tool_start" || typeof agentEvent.name !== "string") return [];
    if (
      agentEvent.name === FLOW_SAVE_TOOL_NAME
      || agentEvent.name === PI_FLOW_SAVE_TOOL_NAME
      || (
        typeof agentEvent.toolCallId === "string"
        && managementToolCallIds.has(agentEvent.toolCallId)
      )
    ) return [];
    const toolCallId = typeof agentEvent.toolCallId === "string"
      && agentEvent.toolCallId.trim()
      ? agentEvent.toolCallId
      : null;
    const invocationId = toolCallId
      ? `tool:${toolCallId}`
      : `event:${event.eventId || `${event.workItemId}:${event.sequence}`}`;
    if (seenInvocationIds.has(invocationId)) return [];
    seenInvocationIds.add(invocationId);
    return [{
      name: agentEvent.name,
      isTrustedAcpExecute: agentEvent.kind === "execute",
    }];
  });
  if (toolCalls.length < 2) return null;

  const boundedPurposes = toolCalls.map(({ name, isTrustedAcpExecute }) => {
    return {
      ...boundPurpose(
        isTrustedAcpExecute
          ? "执行受控命令"
          : sanitizeToolPurpose(name),
      ),
      preservesInvocationIdentity: isTrustedAcpExecute,
    };
  });
  const purposeTruncated = boundedPurposes.some((purpose) => purpose.truncated);
  const purposes = boundedPurposes.reduce<string[]>((values, purpose) => {
    if (
      !purpose.preservesInvocationIdentity
      && values.at(-1) === purpose.value
    ) return values;
    values.push(purpose.value);
    return values;
  }, []).slice(0, 12);
  if (purposes.length < 2) return null;

  const steps = purposes.map((purpose, index) => ({
    id: `step_${index + 1}`,
    purpose,
    dependsOn: index ? [`step_${index}`] : [],
  }));
  return {
    kind: "observed_trace",
    name: sanitizeDefinitionName(
      input.title,
      `${input.run.agentId ?? input.session.agentId} Run Flow`,
    ),
    description: `基于 ${input.run.agentId ?? input.session.agentId} 成功 Run 的已执行工具轨迹提取；参数已移除。`,
    steps,
    sourceFlowId: `flow_ephemeral_${input.run.id}`,
    sourceDefinitionRevision: `trace:${definitionHash({ runId: input.run.id, purposes })}`,
    warnings: [
      "基于实际工具轨迹生成，未映射 Capability，需人工整理",
      ...(purposeTruncated
        ? [`部分步骤说明超过 ${MAX_EXTRACTED_PURPOSE_CHARACTERS} 个字符，已截断`]
        : []),
    ],
  };
}

function agentEventValue(event: DomainEvent): Record<string, unknown> | null {
  if (event.type !== "AGENT_EVENT") return null;
  const value = event.payload.event;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function flowSaveToolOutputFromAgentValue(
  output: unknown,
): RequestFlowSaveOutput | null {
  return parseFlowSaveToolOutput(output, {
    remainingNodes: MAX_FLOW_SAVE_RESULT_NODES,
  }, 0);
}

function parseFlowSaveToolOutput(
  output: unknown,
  traversal: { remainingNodes: number },
  depth: number,
): RequestFlowSaveOutput | null {
  if (
    depth > MAX_FLOW_SAVE_RESULT_DEPTH
    || traversal.remainingNodes <= 0
  ) return null;
  traversal.remainingNodes -= 1;
  if (Array.isArray(output) && output.length > MAX_FLOW_SAVE_RESULT_ARRAY_ITEMS) {
    return null;
  }
  if (output && typeof output === "object" && !Array.isArray(output)) {
    let ownEnumerableKeys = 0;
    for (const key in output) {
      if (!Object.hasOwn(output, key)) continue;
      ownEnumerableKeys += 1;
      if (ownEnumerableKeys > MAX_FLOW_SAVE_RESULT_OBJECT_KEYS) return null;
    }
  }
  try {
    return parseRequestFlowSaveOutput(output);
  } catch {
    // Adapter results wrap the canonical result in text/content/details fields.
  }
  if (typeof output === "string") {
    const text = output.trim();
    if (!text || text.length > MAX_SOURCE_TEXT_CHARACTERS) return null;
    try {
      return parseFlowSaveToolOutput(JSON.parse(text), traversal, depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      const parsed = parseFlowSaveToolOutput(item, traversal, depth + 1);
      if (parsed) return parsed;
    }
    return null;
  }
  if (!output || typeof output !== "object") return null;
  const value = output as Record<string, unknown>;
  for (const key of [
    "structuredContent",
    "details",
    "content",
    "output",
    "result",
    "text",
  ] as const) {
    if (!Object.hasOwn(value, key)) continue;
    const parsed = parseFlowSaveToolOutput(value[key], traversal, depth + 1);
    if (parsed) return parsed;
  }
  return null;
}

function isFlowSaveToolResult(output: unknown): boolean {
  return flowSaveToolOutputFromAgentValue(output) !== null;
}

function sanitizeToolPurpose(name: string): string {
  const boundedName = truncateText(name, MAX_SOURCE_TEXT_CHARACTERS).value;
  const skillScript = boundedName.match(/\/skills\/([^/\s]+)\/scripts\/([^/\s`]+)/i);
  if (skillScript) {
    const script = skillScript[2]!.replace(/\.(?:py|js|ts|sh)$/i, "");
    const skillName = sanitizeReusableText(skillScript[1]!);
    const scriptName = sanitizeReusableText(script);
    if (skillName === skillScript[1] && scriptName === script) {
      return `使用 ${skillName} · ${scriptName}`;
    }
    return "执行受控工具步骤";
  }
  const plain = boundedName.trim();
  if (plain === "Read File") return "使用 Read File";
  if (
    /^[\p{L}\p{N}_.:-]{1,48}$/u.test(plain)
    && sanitizeReusableText(plain) === plain
  ) return `使用 ${plain}`;
  return "执行受控工具步骤";
}

function sanitizeDefinitionName(value: string, fallback: string): string {
  const source = truncateText(value, MAX_SOURCE_TEXT_CHARACTERS).value;
  const firstLine = source.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? fallback;
  const sanitized = sanitizeReusableText(firstLine).replace(/\s+/g, " ").trim() || fallback;
  const characters = Array.from(sanitized);
  return characters.length > 60 ? `${characters.slice(0, 60).join("")}…` : characters.join("");
}

function truncateText(value: string, maxCharacters: number): { value: string; truncated: boolean } {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return { value, truncated: false };
  return {
    value: `${characters.slice(0, Math.max(0, maxCharacters - 1)).join("")}…`,
    truncated: true,
  };
}

function boundPurpose(value: string): { value: string; truncated: boolean } {
  const boundedSource = truncateText(value, MAX_SOURCE_TEXT_CHARACTERS);
  const boundedPurpose = truncateText(
    sanitizeReusableText(boundedSource.value),
    MAX_EXTRACTED_PURPOSE_CHARACTERS,
  );
  return {
    value: boundedPurpose.value,
    truncated: boundedSource.truncated || boundedPurpose.truncated,
  };
}

function sanitizeReusableText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, "链接")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "参数")
    .replace(/(?:~\/|\/Users\/|\/home\/|[A-Za-z]:\\)[^\s]+/g, "本地路径")
    .replace(/(^|\s)-{1,2}[\p{L}\p{N}_.-]+(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gu, "$1参数")
    .replace(/\b(?=[A-Za-z0-9_-]{6,}\b)(?=[A-Za-z0-9_-]*\d{6,})[A-Za-z0-9_-]+\b/g, "参数")
    .replace(/\s+/g, " ")
    .trim();
}
