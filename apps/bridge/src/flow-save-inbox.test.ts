import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SqliteEventStore } from "@codebridge/work-items";
import {
  FlowSaveInboxService,
  type FlowSaveInboxWarning,
} from "./flow-save-inbox.js";

type Fixture = ReturnType<typeof createFixture>;
const fixtureStores: Array<{
  sessions: SessionCatalogStore;
  events: SqliteEventStore;
}> = [];

afterEach(() => {
  for (const fixture of fixtureStores.splice(0)) {
    fixture.sessions.close();
    fixture.events.close();
  }
  vi.restoreAllMocks();
});

function createFixture(options: { archived?: boolean } = {}) {
  const sessions = new SessionCatalogStore(":memory:");
  const events = new SqliteEventStore(":memory:");
  const session = sessions.createSession({
    id: "sess_inbox",
    agentId: "pi",
    title: "仓配中心异常排查",
  });
  const workItem = events.createWorkItem({
    id: "wi_inbox",
    title: "仓配中心异常排查",
    mode: "auto",
    conversationId: "conv_inbox",
    sessionId: session.id,
    agentId: session.agentId,
    riskLevel: "read_only",
  });
  sessions.updateSession(session.id, {
    taskRecordId: workItem.id,
    ...(options.archived ? { archived: true } : {}),
  });
  const source = events.withSessionTransaction((tx) => {
    const turn = tx.insertTurn(session.id, {
      text: "调查仓配异常",
      attachmentIds: [],
      flowId: null,
      executionKind: "agent",
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    });
    const dispatched = tx.dispatchTurn(turn.turnId, {
      id: "run_source",
      workItemId: workItem.id,
      sessionId: session.id,
      turnId: turn.turnId,
      mode: "auto",
      executionKind: "agent",
      agentId: session.agentId,
      planId: null,
      planIrHash: null,
      workflowRevision: null,
    });
    tx.updateRun(dispatched.run.id, { status: "succeeded" });
    return dispatched;
  });
  const request = events.withSessionTransaction((tx) => {
    const turn = tx.insertTurn(session.id, {
      text: "把刚才存为 Flow",
      attachmentIds: [],
      flowId: null,
      executionKind: "agent",
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    });
    return tx.dispatchTurn(turn.turnId, {
      id: "run_request",
      workItemId: workItem.id,
      sessionId: session.id,
      turnId: turn.turnId,
      mode: "auto",
      executionKind: "agent",
      agentId: session.agentId,
      planId: null,
      planIrHash: null,
      workflowRevision: null,
    });
  });
  const fixture = {
    sessions,
    events,
    session: sessions.getSession(session.id)!,
    workItem,
    source,
    request,
  };
  fixtureStores.push({ sessions, events });
  return fixture;
}

function appendRequested(
  fixture: Fixture,
  overrides: Record<string, unknown> = {},
) {
  return fixture.events.appendEvent({
    workItemId: fixture.workItem.id,
    runId: fixture.request.run.id,
    type: "FLOW_SAVE_REQUESTED",
    actor: "agent",
    target: "fsr_inbox",
    payload: {
      request_id: "fsr_inbox",
      session_id: fixture.session.id,
      request_turn_id: fixture.request.turn.turnId,
      request_run_id: fixture.request.run.id,
      source_turn_id: fixture.source.turn.turnId,
      source_run_id: fixture.source.run.id,
      source_title: "调查仓配异常",
      source: "agent_intent",
      user_message: "把刚才存为 Flow",
      intent_summary: "把可复用的排查步骤保存下来",
      name_hint: "仓配异常排查",
      source_imported: false,
      created_at: "2026-08-26T04:53:40.922Z",
      ...overrides,
    },
  });
}

describe("FlowSaveInboxService", () => {
  it("lists an archived Session request with one Event page read and one Session list read", () => {
    const fixture = createFixture({ archived: true });
    const event = appendRequested(fixture);
    const warnings: FlowSaveInboxWarning[] = [];
    const listEvents = vi.spyOn(fixture.events, "listPendingFlowSaveRequestEvents");
    const listSessions = vi.spyOn(fixture.sessions, "listSessions");
    const getWorkItem = vi.spyOn(fixture.events, "getWorkItem");
    const getRun = vi.spyOn(fixture.events, "getRun");
    const getTurn = vi.spyOn(fixture.events, "getTurn");
    const listByTarget = vi.spyOn(fixture.events, "listEventsByTarget");
    const getSession = vi.spyOn(fixture.sessions, "getSession");
    const beforeEventCount = fixture.events.listEvents(fixture.workItem.id).length;
    const service = new FlowSaveInboxService({
      sessions: fixture.sessions,
      events: fixture.events,
      warn: (warning) => warnings.push(warning),
    });

    const page = service.listPending({ limit: 50, cursor: null });

    expect(page).toEqual({
      requests: [{
        requestId: "fsr_inbox",
        sessionId: "sess_inbox",
        agentId: "pi",
        sessionTitle: "仓配中心异常排查",
        requestTurnId: fixture.request.turn.turnId,
        requestRunId: "run_request",
        sourceTurnId: fixture.source.turn.turnId,
        sourceRunId: "run_source",
        sourceTitle: "调查仓配异常",
        source: "agent_intent",
        userMessage: "把刚才存为 Flow",
        intentSummary: "把可复用的排查步骤保存下来",
        nameHint: "仓配异常排查",
        sourceImported: false,
        createdAt: "2026-08-26T04:53:40.922Z",
        eventSequence: event.sequence,
      }],
      nextCursor: null,
    });
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledWith(undefined, { includeArchived: true });
    expect(getWorkItem).not.toHaveBeenCalled();
    expect(getRun).not.toHaveBeenCalled();
    expect(getTurn).not.toHaveBeenCalled();
    expect(listByTarget).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
    expect(fixture.events.listEvents(fixture.workItem.id)).toHaveLength(beforeEventCount);
  });

  it("hides a request whose Session was deleted and records one structured warning without writes", () => {
    const fixture = createFixture();
    appendRequested(fixture);
    expect(fixture.sessions.deleteSession(fixture.session.id)).toBe(true);
    const warnings: FlowSaveInboxWarning[] = [];
    const beforeEvents = fixture.events.listEvents(fixture.workItem.id);
    const service = new FlowSaveInboxService({
      sessions: fixture.sessions,
      events: fixture.events,
      warn: (warning) => warnings.push(warning),
    });

    expect(service.listPending({ limit: 50, cursor: null })).toEqual({
      requests: [],
      nextCursor: null,
    });
    expect(warnings).toEqual([{
      code: "flow_save_pending_session_missing",
      requestId: "fsr_inbox",
      sessionId: "sess_inbox",
      eventId: expect.any(String),
    }]);
    expect(fixture.events.listEvents(fixture.workItem.id)).toEqual(beforeEvents);
  });

  it.each([
    ["target", { target: "fsr_other" }],
    ["request Run", { request_run_id: "run_other" }],
    ["request Turn", { request_turn_id: "turn_other" }],
    ["source Run", { source_run_id: "run_other" }],
    ["source Turn", { source_turn_id: "turn_other" }],
    ["source type", { source: "guessed" }],
  ])("fails closed for malformed %s identity", (_label, mutation) => {
    const fixture = createFixture();
    const event = appendRequested(fixture, mutation);
    if ("target" in mutation) {
      const database = (fixture.events as unknown as {
        database: { prepare(sql: string): { run(...args: unknown[]): unknown } };
      }).database;
      database.prepare("UPDATE domain_events SET target = ? WHERE event_id = ?")
        .run(mutation.target, event.eventId);
    }
    const warnings: FlowSaveInboxWarning[] = [];
    const service = new FlowSaveInboxService({
      sessions: fixture.sessions,
      events: fixture.events,
      warn: (warning) => warnings.push(warning),
    });

    expect(service.listPending({ limit: 50, cursor: null }).requests).toEqual([]);
    const mutatedTarget = "target" in mutation ? mutation.target : undefined;
    expect(warnings).toEqual([{
      code: "flow_save_pending_identity_invalid",
      requestId: mutatedTarget === undefined ? "fsr_inbox" : "fsr_other",
      sessionId: "sess_inbox",
      eventId: event.eventId,
    }]);
  });

  it("passes the cursor through and preserves Event Store order", () => {
    const fixture = createFixture();
    const event = appendRequested(fixture);
    const cursor = { occurredAt: event.occurredAt, eventId: event.eventId };
    const list = vi.spyOn(fixture.events, "listPendingFlowSaveRequestEvents")
      .mockReturnValue({
        rows: [fixture.events.listPendingFlowSaveRequestEvents({ limit: 50, cursor: null }).rows[0]!],
        nextCursor: cursor,
      });
    const service = new FlowSaveInboxService({
      sessions: fixture.sessions,
      events: fixture.events,
    });

    const page = service.listPending({ limit: 17, cursor });

    expect(list).toHaveBeenLastCalledWith({ limit: 17, cursor });
    expect(page.requests.map((request) => request.requestId)).toEqual(["fsr_inbox"]);
    expect(page.nextCursor).toEqual(cursor);
  });
});
