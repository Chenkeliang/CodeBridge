import type { AgentSession, SessionCatalogStore } from "@codebridge/session-catalog";
import type {
  FlowSaveInboxEventCursor,
  FlowSaveInboxEventRow,
  SqliteEventStore,
} from "@codebridge/work-items";
import {
  parseFlowSaveRequestEvent,
  type FlowSaveRequest,
} from "./flow-save-intent.js";

export interface FlowSaveInboxWarning {
  code:
    | "flow_save_pending_session_missing"
    | "flow_save_pending_identity_invalid";
  requestId: string;
  sessionId: string;
  eventId: string;
}

export interface FlowSaveInboxRequest extends FlowSaveRequest {
  agentId: string;
  sessionTitle: string | null;
  eventSequence: number;
}

export interface FlowSaveInboxPage {
  requests: FlowSaveInboxRequest[];
  nextCursor: FlowSaveInboxEventCursor | null;
}

export interface FlowSaveInboxServiceOptions {
  sessions: SessionCatalogStore;
  events: SqliteEventStore;
  warn?: (warning: FlowSaveInboxWarning) => void;
}

export class FlowSaveInboxService {
  constructor(private readonly options: FlowSaveInboxServiceOptions) {}

  listPending(input: {
    limit: number;
    cursor: FlowSaveInboxEventCursor | null;
  }): FlowSaveInboxPage {
    const page = this.options.events.listPendingFlowSaveRequestEvents(input);
    const sessions = new Map(
      this.options.sessions
        .listSessions(undefined, { includeArchived: true })
        .map((session) => [session.id, session] as const),
    );
    const requests: FlowSaveInboxRequest[] = [];
    for (const row of page.rows) {
      const request = parseRequest(row);
      if (!request || !identityMatches(row, request)) {
        this.warn(row, "flow_save_pending_identity_invalid", request);
        continue;
      }
      const session = sessions.get(request.sessionId);
      if (!session) {
        this.warn(row, "flow_save_pending_session_missing", request);
        continue;
      }
      if (!sessionMatches(session, row, request)) {
        this.warn(row, "flow_save_pending_identity_invalid", request);
        continue;
      }
      requests.push({
        ...request,
        agentId: session.agentId,
        sessionTitle: session.title,
        eventSequence: row.event.sequence,
      });
    }
    return { requests, nextCursor: page.nextCursor };
  }

  private warn(
    row: FlowSaveInboxEventRow,
    code: FlowSaveInboxWarning["code"],
    request: FlowSaveRequest | null,
  ): void {
    this.options.warn?.({
      code,
      requestId: row.event.target
        ?? request?.requestId
        ?? stringPayload(row, "request_id"),
      sessionId: request?.sessionId ?? stringPayload(row, "session_id"),
      eventId: row.event.eventId,
    });
  }
}

function parseRequest(row: FlowSaveInboxEventRow): FlowSaveRequest | null {
  try {
    return parseFlowSaveRequestEvent(row.event);
  } catch {
    return null;
  }
}

function identityMatches(
  row: FlowSaveInboxEventRow,
  request: FlowSaveRequest,
): boolean {
  return (
    request.source === "agent_intent"
    || request.source === "turn_action"
  )
    && row.event.target === request.requestId
    && row.event.runId === request.requestRunId
    && row.workItemSessionId === request.sessionId
    && row.requestRun?.runId === request.requestRunId
    && row.requestRun.sessionId === request.sessionId
    && row.requestRun.turnId === request.requestTurnId
    && row.requestTurn?.turnId === request.requestTurnId
    && row.requestTurn.sessionId === request.sessionId
    && row.sourceRun?.runId === request.sourceRunId
    && row.sourceRun.sessionId === request.sessionId
    && row.sourceRun.turnId === request.sourceTurnId
    && row.sourceTurn?.turnId === request.sourceTurnId
    && row.sourceTurn.sessionId === request.sessionId;
}

function sessionMatches(
  session: AgentSession,
  row: FlowSaveInboxEventRow,
  request: FlowSaveRequest,
): boolean {
  return session.id === request.sessionId
    && session.taskRecordId === row.event.workItemId;
}

function stringPayload(row: FlowSaveInboxEventRow, key: string): string {
  const value = row.event.payload[key];
  return typeof value === "string" ? value : "";
}
