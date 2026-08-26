import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "./index.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createDatabasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-work-items-"));
  tempDirectories.push(directory);
  return path.join(directory, "events.sqlite");
}

function rawDatabase(store: SqliteEventStore): InstanceType<typeof DatabaseSync> {
  return (store as unknown as { database: InstanceType<typeof DatabaseSync> }).database;
}

function seedFlowSaveRuns(
  store: SqliteEventStore,
  input: {
    workItemId: string;
    sessionId: string;
    sourceRunId: string;
    requestRunId: string;
  },
): { sourceTurnId: string; requestTurnId: string } {
  const sourceTurn = store.withSessionTransaction((tx) => {
    const turn = tx.insertTurn(input.sessionId, {
      text: "调查仓配异常",
      attachmentIds: [],
      flowId: null,
      executionKind: "agent",
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    });
    tx.dispatchTurn(turn.turnId, {
      id: input.sourceRunId,
      workItemId: input.workItemId,
      sessionId: input.sessionId,
      turnId: turn.turnId,
      mode: "auto",
      executionKind: "agent",
      agentId: "pi",
      planId: null,
      planIrHash: null,
      workflowRevision: null,
    });
    return turn;
  });
  store.withSessionTransaction((tx) => {
    tx.updateRun(input.sourceRunId, { status: "succeeded" });
  });
  const requestTurn = store.withSessionTransaction((tx) => {
    const turn = tx.insertTurn(input.sessionId, {
      text: "把刚才存为 Flow",
      attachmentIds: [],
      flowId: null,
      executionKind: "agent",
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    });
    tx.dispatchTurn(turn.turnId, {
      id: input.requestRunId,
      workItemId: input.workItemId,
      sessionId: input.sessionId,
      turnId: turn.turnId,
      mode: "auto",
      executionKind: "agent",
      agentId: "pi",
      planId: null,
      planIrHash: null,
      workflowRevision: null,
    });
    return turn;
  });
  return {
    sourceTurnId: sourceTurn.turnId,
    requestTurnId: requestTurn.turnId,
  };
}

function appendFlowSaveRequested(
  store: SqliteEventStore,
  input: {
    workItemId: string;
    sessionId: string;
    requestId: string;
    requestRunId: string;
    requestTurnId: string;
    sourceRunId: string;
    sourceTurnId: string;
  },
) {
  return store.appendEvent({
    workItemId: input.workItemId,
    runId: input.requestRunId,
    type: "FLOW_SAVE_REQUESTED",
    actor: "agent",
    target: input.requestId,
    payload: {
      request_id: input.requestId,
      session_id: input.sessionId,
      request_run_id: input.requestRunId,
      request_turn_id: input.requestTurnId,
      source_run_id: input.sourceRunId,
      source_turn_id: input.sourceTurnId,
      source_title: "调查仓配异常",
      source: "agent_intent",
      user_message: "把刚才存为 Flow",
      source_imported: false,
      intent_summary: null,
      name_hint: null,
      created_at: "2026-08-26T00:00:00.000Z",
    },
  });
}

describe("SqliteEventStore", () => {
  it("backfills immutable execution identity for historical Runs and events", () => {
    const databasePath = createDatabasePath();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE work_items (
        id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL, mode TEXT NOT NULL, conversation_id TEXT NOT NULL,
        session_id TEXT, agent_id TEXT, workflow_id TEXT, workflow_revision TEXT,
        workspace_scope TEXT NOT NULL, identifiers TEXT NOT NULL,
        context_revision INTEGER NOT NULL, risk_level TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL,
        work_item_id TEXT NOT NULL, session_id TEXT, turn_id TEXT,
        mode TEXT NOT NULL, status TEXT NOT NULL, agent_id TEXT,
        plan_id TEXT, plan_ir_hash TEXT, workflow_revision TEXT,
        terminal_reason TEXT, replay_safety TEXT NOT NULL DEFAULT 'safe',
        lease_owner TEXT, lease_expires_at TEXT, cancel_requested_at TEXT,
        cancel_deadline_at TEXT, provider_session_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE domain_events (
        event_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL,
        sequence INTEGER NOT NULL, work_item_id TEXT NOT NULL, run_id TEXT,
        type TEXT NOT NULL, occurred_at TEXT NOT NULL, actor TEXT NOT NULL,
        target TEXT, input_hash TEXT, result_ref TEXT, payload TEXT NOT NULL,
        UNIQUE(work_item_id, sequence)
      );
      CREATE TABLE session_turns (
        turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        queue_position INTEGER NOT NULL, status TEXT NOT NULL,
        message_json TEXT NOT NULL, version INTEGER NOT NULL,
        dispatched_run_id TEXT UNIQUE, created_at TEXT NOT NULL,
        dispatched_at TEXT, cancelled_at TEXT,
        UNIQUE(session_id, queue_position)
      );
      INSERT INTO work_items VALUES (
        'wi_old', 1, 'old', 'created', 'auto', 'conv_old', NULL, NULL,
        NULL, NULL, '[]', '{}', 1, 'read_only', 't', 't'
      );
      INSERT INTO runs VALUES (
        'run_agent', 1, 'wi_old', NULL, NULL, 'auto', 'succeeded', NULL,
        NULL, NULL, NULL, NULL, 'safe', NULL, NULL, NULL, NULL, NULL, 't', 't'
      );
      INSERT INTO runs VALUES (
        'run_flow', 1, 'wi_old', NULL, NULL, 'auto', 'succeeded', NULL,
        'plan_old', 'sha256:plan', 'sha256:def', NULL, 'safe', NULL, NULL,
        NULL, NULL, NULL, 't', 't'
      );
      INSERT INTO domain_events VALUES (
        'evt_agent', 1, 1, 'wi_old', 'run_agent', 'RUN_SUCCEEDED', 't',
        'system', NULL, NULL, NULL, '{}'
      );
      INSERT INTO domain_events VALUES (
        'evt_flow', 1, 2, 'wi_old', 'run_flow', 'RUN_SUCCEEDED', 't',
        'system', NULL, NULL, NULL, '{}'
      );
      INSERT INTO session_turns VALUES (
        'turn_agent', 'sess_old', 1, 'queued',
        '{"text":"agent","attachmentIds":[],"flowId":null,"model":null,"effort":null,"permissionMode":null,"plan":null}',
        1, NULL, 't', NULL, NULL
      );
      INSERT INTO session_turns VALUES (
        'turn_flow', 'sess_old', 2, 'queued',
        '{"text":"flow","attachmentIds":[],"flowId":"flow_old","flowInvocationSource":"request","model":null,"effort":null,"permissionMode":null,"plan":{"planId":"p"}}',
        1, NULL, 't', NULL, NULL
      );
    `);
    database.close();

    const store = new SqliteEventStore(databasePath);
    expect(store.getRun("run_agent")?.executionKind).toBe("agent");
    expect(store.getRun("run_flow")?.executionKind).toBe("flow");
    expect(store.listEvents("wi_old").map((event) => event.executionKind))
      .toEqual(["agent", "flow"]);
    expect(store.getTurn("turn_agent")?.message.executionKind).toBe("agent");
    expect(store.getTurn("turn_flow")?.message.executionKind).toBe("flow");
    store.close();
  });

  it("persists a WorkItem and its creation event", () => {
    const databasePath = createDatabasePath();
    const store = new SqliteEventStore(databasePath);

    const workItem = store.createWorkItem({
      id: "wi_01JTEST",
      title: "Investigate a missing entitlement",
      mode: "investigation",
      conversationId: "conv_01JTEST",
      agentId: "pi-investigator",
      workspaceScope: ["equity-center"],
      riskLevel: "read_only",
    });

    expect(workItem.status).toBe("created");
    expect(workItem.agentId).toBe("pi-investigator");
    expect(store.getWorkItem(workItem.id)).toEqual(workItem);
    expect(store.listEvents(workItem.id)).toHaveLength(1);
    expect(store.listEvents(workItem.id)[0]).toMatchObject({
      type: "WORK_ITEM_CREATED",
      sequence: 1,
      workItemId: workItem.id,
    });

    store.close();
  });

  it("lists WorkItems for a workbench inbox", () => {
    const store = new SqliteEventStore(":memory:");
    store.createWorkItem({
      title: "first",
      mode: "investigation",
      conversationId: "web:first",
      riskLevel: "read_only",
    });
    store.createWorkItem({
      title: "second",
      mode: "change",
      conversationId: "web:second",
      riskLevel: "workspace_write",
    });
    expect(store.listWorkItems().map((item) => item.title).sort()).toEqual(["first", "second"]);
    store.close();
  });

  it("updates the optional Workflow binding used by later Runs", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "task",
      mode: "auto",
      conversationId: "conv_flow",
      riskLevel: "read_only",
    });
    expect(store.updateWorkflowBinding(item.id, "review-flow", "git:abc")).toMatchObject({
      workflowId: "review-flow",
      workflowRevision: "git:abc",
    });
    store.close();
  });

  it("reopens the database and keeps the event sequence", () => {
    const databasePath = createDatabasePath();
    const firstStore = new SqliteEventStore(databasePath);
    firstStore.createWorkItem({
      id: "wi_01JREOPEN",
      title: "Inspect a release",
      mode: "release",
      conversationId: "conv_01JREOPEN",
      workspaceScope: ["equity-center", "payment-gateway"],
      riskLevel: "read_only",
    });
    firstStore.appendEvent({
      workItemId: "wi_01JREOPEN",
      type: "PLAN_PROPOSED",
      actor: "agent",
      payload: { source: "agent_generated" },
    });
    firstStore.close();

    const reopenedStore = new SqliteEventStore(databasePath);
    const events = reopenedStore.listEvents("wi_01JREOPEN");

    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events[1]).toMatchObject({
      type: "PLAN_PROPOSED",
      actor: "agent",
      payload: { source: "agent_generated" },
    });

    reopenedStore.close();
  });

  it("appends an idempotent event only once across store instances", () => {
    const databasePath = createDatabasePath();
    const firstStore = new SqliteEventStore(databasePath);
    const item = firstStore.createWorkItem({
      title: "history",
      mode: "auto",
      conversationId: "web:history",
      riskLevel: "read_only",
    });
    const secondStore = new SqliteEventStore(databasePath);

    const first = firstStore.appendEventOnce({
      workItemId: item.id,
      type: "MESSAGE_RECEIVED",
      actor: "user",
      inputHash: "provider-history:message:1",
      payload: { message: "hello" },
    });
    const second = secondStore.appendEventOnce({
      workItemId: item.id,
      type: "MESSAGE_RECEIVED",
      actor: "user",
      inputHash: "provider-history:message:1",
      payload: { message: "hello" },
    });

    expect(second.eventId).toBe(first.eventId);
    expect(firstStore.listEvents(item.id).filter((event) => event.inputHash === "provider-history:message:1")).toHaveLength(1);
    secondStore.close();
    firstStore.close();
  });

  it("persists Flow save events and lists them by target in sequence order", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "save a reusable Flow",
      mode: "auto",
      conversationId: "web:flow-save",
      riskLevel: "read_only",
    });
    const run = store.createRun({
      workItemId: item.id,
      mode: "auto",
      executionKind: "agent",
    });

    const requested = store.appendEventOnce({
      workItemId: item.id,
      runId: run.id,
      type: "FLOW_SAVE_REQUESTED",
      actor: "user",
      target: "fsr_one",
      inputHash: "flow-save-request:http:sess_1:key_1",
      payload: {
        request_id: "fsr_one",
        session_id: "sess_1",
        request_turn_id: run.turnId,
        source_run_id: run.id,
      },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: run.id,
      type: "FLOW_SAVE_DISMISSED",
      actor: "user",
      target: "fsr_one",
      payload: { request_id: "fsr_one" },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: run.id,
      type: "FLOW_CANDIDATE_CREATED",
      actor: "system",
      target: "fsr_candidate",
      payload: {
        request_id: "fsr_candidate",
        flow_id: "flow_from_fsr_candidate",
      },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: run.id,
      type: "FLOW_SAVE_FAILED",
      actor: "system",
      target: "fsr_failed",
      payload: {
        request_id: "fsr_failed",
        code: "source_run_not_extractable",
      },
    });

    expect(store.listEventsByTarget("fsr_one").map((event) => event.type))
      .toEqual([
        "FLOW_SAVE_REQUESTED",
        "FLOW_SAVE_DISMISSED",
      ]);
    expect(store.listEvents(item.id).map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "FLOW_SAVE_REQUESTED",
        "FLOW_SAVE_DISMISSED",
        "FLOW_CANDIDATE_CREATED",
        "FLOW_SAVE_FAILED",
      ]),
    );
    expect(requested.target).toBe("fsr_one");
    store.close();
  });

  it("lists only pending Flow save requests and does not cross targets or WorkItems", () => {
    const store = new SqliteEventStore(":memory:");
    const first = store.createWorkItem({
      id: "wi_inbox_first",
      title: "first",
      mode: "auto",
      conversationId: "conv_inbox_first",
      sessionId: "sess_inbox_first",
      agentId: "pi",
      riskLevel: "read_only",
    });
    const firstRuns = seedFlowSaveRuns(store, {
      workItemId: first.id,
      sessionId: "sess_inbox_first",
      sourceRunId: "run_source_first",
      requestRunId: "run_request_first",
    });
    const pending = appendFlowSaveRequested(store, {
      workItemId: first.id,
      sessionId: "sess_inbox_first",
      requestId: "fsr_pending",
      requestRunId: "run_request_first",
      requestTurnId: firstRuns.requestTurnId,
      sourceRunId: "run_source_first",
      sourceTurnId: firstRuns.sourceTurnId,
    });
    const dismissed = appendFlowSaveRequested(store, {
      workItemId: first.id,
      sessionId: "sess_inbox_first",
      requestId: "fsr_dismissed",
      requestRunId: "run_request_first",
      requestTurnId: firstRuns.requestTurnId,
      sourceRunId: "run_source_first",
      sourceTurnId: firstRuns.sourceTurnId,
    });
    store.appendEvent({
      workItemId: first.id,
      runId: "run_request_first",
      type: "FLOW_SAVE_DISMISSED",
      actor: "user",
      target: "fsr_dismissed",
      payload: { request_id: "fsr_dismissed" },
    });
    const completed = appendFlowSaveRequested(store, {
      workItemId: first.id,
      sessionId: "sess_inbox_first",
      requestId: "fsr_completed",
      requestRunId: "run_request_first",
      requestTurnId: firstRuns.requestTurnId,
      sourceRunId: "run_source_first",
      sourceTurnId: firstRuns.sourceTurnId,
    });
    store.appendEvent({
      workItemId: first.id,
      runId: "run_request_first",
      type: "FLOW_CANDIDATE_CREATED",
      actor: "system",
      target: "fsr_completed",
      payload: {
        request_id: "fsr_completed",
        flow_id: "flow_from_completed",
      },
    });
    const failed = appendFlowSaveRequested(store, {
      workItemId: first.id,
      sessionId: "sess_inbox_first",
      requestId: "fsr_failed",
      requestRunId: "run_request_first",
      requestTurnId: firstRuns.requestTurnId,
      sourceRunId: "run_source_first",
      sourceTurnId: firstRuns.sourceTurnId,
    });
    store.appendEvent({
      workItemId: first.id,
      runId: "run_request_first",
      type: "FLOW_SAVE_FAILED",
      actor: "system",
      target: "fsr_failed",
      payload: {
        request_id: "fsr_failed",
        code: "source_run_not_extractable",
      },
    });
    const second = store.createWorkItem({
      id: "wi_inbox_second",
      title: "second",
      mode: "auto",
      conversationId: "conv_inbox_second",
      riskLevel: "read_only",
    });
    const secondRun = store.createRun({
      id: "run_request_second",
      workItemId: second.id,
      mode: "auto",
      executionKind: "agent",
    });
    store.appendEvent({
      workItemId: second.id,
      runId: secondRun.id,
      type: "FLOW_SAVE_DISMISSED",
      actor: "user",
      target: "fsr_pending",
      payload: { request_id: "fsr_pending" },
    });

    const page = store.listPendingFlowSaveRequestEvents({ limit: 50, cursor: null });

    expect(page.rows.map((row) => row.event.eventId)).toEqual([pending.eventId]);
    expect(page.rows.map((row) => row.event.eventId)).not.toEqual(expect.arrayContaining([
      dismissed.eventId,
      completed.eventId,
      failed.eventId,
    ]));
    expect(page.nextCursor).toBeNull();
    store.close();
  });

  it("orders equal timestamps by event id and paginates by the opaque tuple without duplicates", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      id: "wi_inbox_cursor",
      title: "cursor",
      mode: "auto",
      conversationId: "conv_inbox_cursor",
      sessionId: "sess_inbox_cursor",
      agentId: "pi",
      riskLevel: "read_only",
    });
    const runs = seedFlowSaveRuns(store, {
      workItemId: item.id,
      sessionId: "sess_inbox_cursor",
      sourceRunId: "run_source_cursor",
      requestRunId: "run_request_cursor",
    });
    const events = ["a", "b", "c"].map((suffix) => appendFlowSaveRequested(store, {
      workItemId: item.id,
      sessionId: "sess_inbox_cursor",
      requestId: `fsr_cursor_${suffix}`,
      requestRunId: "run_request_cursor",
      requestTurnId: runs.requestTurnId,
      sourceRunId: "run_source_cursor",
      sourceTurnId: runs.sourceTurnId,
    }));
    rawDatabase(store).prepare(
      "UPDATE domain_events SET occurred_at = ? WHERE event_id IN (?, ?, ?)",
    ).run(
      "2026-08-26T01:02:03.000Z",
      events[0]!.eventId,
      events[1]!.eventId,
      events[2]!.eventId,
    );
    const expected = events.map((event) => event.eventId).sort().reverse();

    const first = store.listPendingFlowSaveRequestEvents({ limit: 2, cursor: null });
    const second = store.listPendingFlowSaveRequestEvents({
      limit: 2,
      cursor: first.nextCursor,
    });

    expect(first.rows.map((row) => row.event.eventId)).toEqual(expected.slice(0, 2));
    expect(first.nextCursor).toEqual({
      occurredAt: "2026-08-26T01:02:03.000Z",
      eventId: expected[1],
    });
    expect(second.rows.map((row) => row.event.eventId)).toEqual(expected.slice(2));
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.rows, ...second.rows].map((row) => row.event.eventId)).size).toBe(3);
    store.close();
  });

  it("returns WorkItem, request Run/Turn, and source Run/Turn identity evidence from the page query", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      id: "wi_inbox_evidence",
      title: "evidence",
      mode: "auto",
      conversationId: "conv_inbox_evidence",
      sessionId: "sess_inbox_evidence",
      agentId: "pi",
      riskLevel: "read_only",
    });
    const runs = seedFlowSaveRuns(store, {
      workItemId: item.id,
      sessionId: "sess_inbox_evidence",
      sourceRunId: "run_source_evidence",
      requestRunId: "run_request_evidence",
    });
    appendFlowSaveRequested(store, {
      workItemId: item.id,
      sessionId: "sess_inbox_evidence",
      requestId: "fsr_evidence",
      requestRunId: "run_request_evidence",
      requestTurnId: runs.requestTurnId,
      sourceRunId: "run_source_evidence",
      sourceTurnId: runs.sourceTurnId,
    });

    const [row] = store.listPendingFlowSaveRequestEvents({ limit: 50, cursor: null }).rows;

    expect(row).toMatchObject({
      workItemSessionId: "sess_inbox_evidence",
      requestRun: {
        runId: "run_request_evidence",
        sessionId: "sess_inbox_evidence",
        turnId: runs.requestTurnId,
      },
      requestTurn: {
        turnId: runs.requestTurnId,
        sessionId: "sess_inbox_evidence",
      },
      sourceRun: {
        runId: "run_source_evidence",
        sessionId: "sess_inbox_evidence",
        turnId: runs.sourceTurnId,
      },
      sourceTurn: {
        turnId: runs.sourceTurnId,
        sessionId: "sess_inbox_evidence",
      },
    });
    rawDatabase(store).prepare("UPDATE runs SET turn_id = ? WHERE id = ?")
      .run("turn_missing", "run_source_evidence");
    const [malformed] = store.listPendingFlowSaveRequestEvents({ limit: 50, cursor: null }).rows;
    expect(malformed?.sourceRun).toMatchObject({
      runId: "run_source_evidence",
      turnId: "turn_missing",
    });
    expect(malformed?.sourceTurn).toBeNull();
    store.close();
  });

  it("keeps the pending query bounded with 100 pending and 500 terminal requests", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      id: "wi_inbox_scale",
      title: "scale",
      mode: "auto",
      conversationId: "conv_inbox_scale",
      riskLevel: "read_only",
    });
    const run = store.createRun({
      id: "run_inbox_scale",
      workItemId: item.id,
      mode: "auto",
      executionKind: "agent",
    });
    for (let index = 0; index < 600; index += 1) {
      const requestId = `fsr_scale_${String(index).padStart(3, "0")}`;
      store.appendEvent({
        workItemId: item.id,
        runId: run.id,
        type: "FLOW_SAVE_REQUESTED",
        actor: "agent",
        target: requestId,
        payload: { request_id: requestId, source_run_id: run.id },
      });
      if (index < 500) {
        store.appendEvent({
          workItemId: item.id,
          runId: run.id,
          type: index % 3 === 0
            ? "FLOW_SAVE_DISMISSED"
            : index % 3 === 1
              ? "FLOW_CANDIDATE_CREATED"
              : "FLOW_SAVE_FAILED",
          actor: "system",
          target: requestId,
        });
      }
    }

    const first = store.listPendingFlowSaveRequestEvents({ limit: 40, cursor: null });
    const second = store.listPendingFlowSaveRequestEvents({ limit: 100, cursor: first.nextCursor });

    expect(first.rows).toHaveLength(40);
    expect(first.nextCursor).not.toBeNull();
    expect(second.rows).toHaveLength(60);
    expect(second.nextCursor).toBeNull();
    expect([...first.rows, ...second.rows].every((row) =>
      Number(row.event.target?.slice("fsr_scale_".length)) >= 500
    )).toBe(true);
    store.close();
  });

  it("creates the exact index used by the global Flow save inbox query", () => {
    const databasePath = createDatabasePath();
    const store = new SqliteEventStore(databasePath);
    const columns = rawDatabase(store)
      .prepare("PRAGMA index_info(domain_events_flow_save_inbox)")
      .all() as Array<{ name?: unknown }>;

    expect(columns.map((column) => String(column.name))).toEqual([
      "type",
      "occurred_at",
      "event_id",
    ]);
    store.close();
  });

  it("updates the WorkItem projection from terminal events", () => {
    const store = new SqliteEventStore(createDatabasePath());
    const workItem = store.createWorkItem({
      id: "wi_01JSTATUS",
      title: "Observe a deployment",
      mode: "observe",
      conversationId: "conv_01JSTATUS",
      workspaceScope: ["equity-center"],
      riskLevel: "read_only",
    });

    store.appendEvent({
      workItemId: workItem.id,
      type: "WORK_ITEM_COMPLETED",
      actor: "system",
    });

    expect(store.getWorkItem(workItem.id)?.status).toBe("completed");
    store.close();
  });

  it("creates a queued Run linked to the WorkItem", () => {
    const store = new SqliteEventStore(createDatabasePath());
    const workItem = store.createWorkItem({
      id: "wi_01JRUN",
      title: "Investigate a payment issue",
      mode: "investigation",
      conversationId: "conv_01JRUN",
      agentId: "pi-investigator",
      riskLevel: "read_only",
    });

    const run = store.createRun({
      workItemId: workItem.id,
      mode: "investigation",
      executionKind: "agent",
    });

    expect(run).toMatchObject({
      workItemId: workItem.id,
      mode: "investigation",
      agentId: "pi-investigator",
      status: "queued",
      executionKind: "agent",
    });
    expect(store.getRun(run.id)).toEqual(run);
    expect(store.listRuns(workItem.id)).toEqual([run]);
    expect(store.listEvents(workItem.id).at(-1)).toMatchObject({
      type: "RUN_CREATED",
      target: run.id,
      executionKind: "agent",
    });
    store.close();
  });

  it("persists the validated Plan IR and pins its revision to the Run", () => {
    const databasePath = createDatabasePath();
    const store = new SqliteEventStore(databasePath);
    const workItem = store.createWorkItem({
      title: "Run a reviewed workflow",
      mode: "change",
      conversationId: "conv_plan",
      workflowId: "review-change",
      workflowRevision: "git:abc123",
      riskLevel: "workspace_write",
    });
    const plan = store.savePlan({
      planId: "plan_01JTEST",
      source: "workflow",
      workflowId: "review-change",
      definitionRevision: "git:abc123",
      sessionId: "sess_01JTEST",
      runId: "run_01JPLAN",
      steps: [
        {
          id: "inspect",
          capabilityId: "context.inspect",
          risk: "read_only",
          dependsOn: [],
          guard: null,
          approval: "none",
          branches: [],
          purpose: null,
        },
      ],
    });
    const run = store.createRun({
      id: "run_01JPLAN",
      workItemId: workItem.id,
      mode: workItem.mode,
      executionKind: "flow",
      planId: plan.planId,
      workflowRevision: plan.definitionRevision,
    });

    expect(run.workflowRevision).toBe("git:abc123");
    expect(run.executionKind).toBe("flow");
    expect(store.getPlan(plan.planId)).toEqual(plan);
    expect(store.getPlanForRun(run.id)).toEqual(plan);
    expect(store.listEvents(workItem.id).at(-1)).toMatchObject({
      type: "PLAN_VALIDATED",
      runId: run.id,
      executionKind: "flow",
      target: plan.planId,
      payload: {
        workflow_id: "review-change",
        definition_revision: "git:abc123",
      },
    });

    store.close();
    const reopened = new SqliteEventStore(databasePath);
    expect(reopened.getPlan(plan.planId)).toEqual(plan);
    expect(reopened.getRun(run.id)?.workflowRevision).toBe("git:abc123");
    reopened.close();
  });

  it("updates a Run status for executor recovery", () => {
    const store = new SqliteEventStore(":memory:");
    const workItem = store.createWorkItem({
      title: "execute",
      mode: "change",
      conversationId: "web:run",
      riskLevel: "workspace_write",
    });
    const run = store.createRun({ workItemId: workItem.id, mode: "change", executionKind: "agent" });

    expect(store.listEvents(workItem.id).at(-1)?.runId).toBe(run.id);
    expect(store.updateRunStatus(run.id, "running").status).toBe("running");
    expect(store.updateRunStatus(run.id, "succeeded").status).toBe("succeeded");
    expect(() => store.updateRunStatus("run_missing", "failed")).toThrow(
      "Run not found",
    );
    store.close();
  });

  it("persists idempotency responses and requeues interrupted runs", () => {
    const databasePath = createDatabasePath();
    const store = new SqliteEventStore(databasePath);
    const workItem = store.createWorkItem({
      title: "recover",
      mode: "investigation",
      conversationId: "web:recover",
      riskLevel: "read_only",
    });
    const run = store.createRun({ workItemId: workItem.id, mode: workItem.mode, executionKind: "agent" });
    store.updateRunStatus(run.id, "running");
    store.putIdempotencyResponse("create-run", "key-1", { run_id: run.id });
    expect(store.getIdempotencyResponse("create-run", "key-1")).toEqual({ run_id: run.id });
    expect(store.getIdempotencyRecord("create-run", "key-1")).toEqual({
      response: { run_id: run.id },
      createdAt: expect.stringMatching(/^\d{4}-/),
    });
    store.putIdempotencyResponse("create-run", "key-stamped", { run_id: run.id }, "2020-01-01T00:00:00.000Z");
    expect(store.getIdempotencyResponse("create-run", "key-stamped")).toEqual({ run_id: run.id });
    expect(store.getIdempotencyRecord("create-run", "key-stamped")).toEqual({
      response: { run_id: run.id },
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    expect(store.listRunsByStatus(["running"])).toHaveLength(1);
    expect(store.requeueRun(run.id).status).toBe("queued");
    store.close();
    const reopened = new SqliteEventStore(databasePath);
    expect(reopened.getIdempotencyResponse("create-run", "key-1")).toEqual({ run_id: run.id });
    reopened.close();
  });

  it("resolves an event id to a sequence for Last-Event-ID", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "events",
      mode: "observe",
      conversationId: "web:events",
      riskLevel: "read_only",
    });
    const event = store.appendEvent({ workItemId: item.id, type: "MESSAGE_RECEIVED", actor: "user", payload: { message: "hi" } });
    expect(store.sequenceForEventId(item.id, event.eventId)).toBe(event.sequence);
    expect(store.sequenceForEventId(item.id, "evt_missing")).toBe(0);
    store.close();
  });

  it("persists run artifacts and verification results with content hashes", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "verify",
      mode: "review",
      conversationId: "web:verify",
      riskLevel: "read_only",
    });
    const run = store.createRun({ workItemId: item.id, mode: item.mode, executionKind: "agent" });
    const artifact = store.createArtifact({
      workItemId: item.id,
      runId: run.id,
      stepId: "tests",
      kind: "test_report",
      name: "result.json",
      mimeType: "application/json",
      content: '{"passed":true}',
      metadata: { source: "runner" },
    });
    expect(store.getArtifact(artifact.id)).toEqual(artifact);
    expect(artifact.contentHash).toMatch(/^sha256:/);
    const verification = store.recordVerification({
      workItemId: item.id,
      runId: run.id,
      stepId: "tests",
      validator: "unit-tests",
      status: "passed",
      summary: "All tests passed",
      artifactIds: [artifact.id],
    });
    expect(store.listArtifacts(run.id)).toHaveLength(1);
    expect(store.listVerifications(run.id)).toEqual([verification]);
    expect(store.listEvents(item.id).slice(-2).map((event) => event.type)).toEqual([
      "ARTIFACT_CREATED",
      "VERIFICATION_COMPLETED",
    ]);
    store.close();
  });

  it("persists message attachments as stable references", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "inspect attachment",
      mode: "auto",
      conversationId: "conv_attachment",
      riskLevel: "read_only",
    });
    const attachment = store.createMessageAttachment({
      workItemId: item.id,
      name: "context.txt",
      mimeType: "text/plain",
      dataBase64: Buffer.from("context").toString("base64"),
    });

    expect(attachment.id).toMatch(/^attachment_/);
    expect(attachment.contentHash).toMatch(/^sha256:/);
    expect(store.getMessageAttachment(attachment.id)).toEqual(attachment);
    expect(store.listMessageAttachments(item.id, [attachment.id])).toEqual([attachment]);
    store.close();
  });

  it("persists planIrHash on plans and runs", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({ title: "t", mode: "auto", conversationId: "c", riskLevel: "read_only" });
    const plan = store.savePlan({
      planId: "plan_1", source: "workflow", workflowId: "flow_1",
      definitionRevision: "sha256:def", planIrHash: "sha256:plan",
      steps: [{ id: "s", capabilityId: "c.d", risk: "read_only", dependsOn: [], guard: null, approval: "none", branches: [], purpose: null }],
    });
    expect(plan.planIrHash).toBe("sha256:plan");
    const run = store.createRun({ workItemId: item.id, planId: "plan_1", mode: "auto", executionKind: "flow" });
    expect(run.planIrHash).toBe("sha256:plan");
    store.close();
  });
});
