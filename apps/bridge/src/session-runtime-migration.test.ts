import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionRuntimeMigration } from "./session-runtime-migration.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createDataDir(): string {
  const directory = fs.mkdtempSync(
    path.join(process.cwd(), ".codebridge-session-runtime-migration-"),
  );
  tempDirectories.push(directory);
  return directory;
}

function createFixture() {
  const dataDir = createDataDir();
  const catalog = new SessionCatalogStore(path.join(dataDir, "sessions.sqlite"));
  const store = new SqliteEventStore(path.join(dataDir, "orchestration.sqlite"));
  const workItem = store.createWorkItem({
    id: "wi_legacy",
    title: "Legacy conversation",
    mode: "auto",
    conversationId: "conv_sess_legacy",
    riskLevel: "read_only",
  });
  const session = catalog.createSession({
    id: "sess_legacy",
    agentId: "pi",
    taskRecordId: workItem.id,
    title: "Legacy conversation",
  });
  const run = store.createRun({
    id: "run_legacy",
    workItemId: workItem.id,
    mode: "auto",
  });
  return {
    dataDir,
    catalog,
    store,
    session,
    workItem,
    run,
  };
}

function insertDomainEvents(
  databasePath: string,
  events: Array<{
    sequence: number;
    workItemId: string;
    runId?: string | null;
    type: string;
    actor: string;
    target?: string | null;
    payload?: Record<string, unknown>;
  }>,
): void {
  const db = new DatabaseSync(databasePath);
  const statement = db.prepare(
    `INSERT INTO domain_events (
      event_id, schema_version, sequence, work_item_id, run_id, type,
      occurred_at, actor, target, input_hash, result_ref, payload
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  );
  const now = new Date("2026-08-14T00:00:00.000Z");
  db.exec("BEGIN IMMEDIATE;");
  try {
    for (const event of events) {
      statement.run(
        `evt_${randomUUID().replaceAll("-", "")}`,
        event.sequence,
        event.workItemId,
        event.runId ?? null,
        event.type,
        now.toISOString(),
        event.actor,
        event.target ?? null,
        JSON.stringify(event.payload ?? {}),
      );
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.close();
  }
}

describe("Session runtime migration", () => {
  it("backfills Session bindings, Turns, runtime and projections", () => {
    const fixture = createFixture();
    const turnId = "turn_legacy";
    insertDomainEvents(path.join(fixture.dataDir, "orchestration.sqlite"), [
      {
        sequence: 3,
        workItemId: fixture.workItem.id,
        runId: fixture.run.id,
        type: "TURN_DISPATCHED",
        actor: "system",
        target: turnId,
        payload: { turn_id: turnId },
      },
      {
        sequence: 4,
        workItemId: fixture.workItem.id,
        runId: null,
        type: "MESSAGE_RECEIVED",
        actor: "user",
        target: turnId,
        payload: { message: "检查这个会话", attachment_ids: [] },
      },
      {
        sequence: 5,
        workItemId: fixture.workItem.id,
        runId: fixture.run.id,
        type: "AGENT_EVENT",
        actor: "agent",
        target: "answer_1",
        payload: {
          event: {
            type: "text_delta",
            blockId: "answer_1",
            phase: "final_answer",
            text: "已完成",
          },
        },
      },
      {
        sequence: 6,
        workItemId: fixture.workItem.id,
        runId: fixture.run.id,
        type: "RUN_SUCCEEDED",
        actor: "system",
        target: fixture.run.id,
        payload: {},
      },
    ]);

    const migration = new SessionRuntimeMigration(fixture.catalog, fixture.store);
    expect(migration.run({ batchSize: 4, maximumBatches: 1 })).toMatchObject({
      migratedSessions: 1,
      projectedEvents: expect.any(Number),
      conflicts: [],
    });
    expect(fixture.store.getProjectionCursor(fixture.session.id)).toBe(4);
    migration.run({ batchSize: 4 });
    expect(fixture.store.getWorkItemBySessionId(fixture.session.id)?.id)
      .toBe(fixture.workItem.id);
    expect(fixture.store.getRun(fixture.run.id)).toMatchObject({
      sessionId: fixture.session.id,
      turnId,
    });
    expect(fixture.store.getTurn(turnId)?.message.text).toBe("检查这个会话");
    expect(fixture.store.getSessionRuntime(fixture.session.id)?.activeRunId)
      .toBe(fixture.run.id);
    expect(fixture.store.getProjectionCursor(fixture.session.id)).toBe(6);
    expect(fixture.store.listTimelineTurns(fixture.session.id, { limit: 50 }).turns[0])
      .toMatchObject({
        status: "succeeded",
      });

    fixture.catalog.close();
    fixture.store.close();
  });

  it("projects no-Run legacy conversations without losing the user block", () => {
    const dataDir = createDataDir();
    const catalog = new SessionCatalogStore(path.join(dataDir, "sessions.sqlite"));
    const store = new SqliteEventStore(path.join(dataDir, "orchestration.sqlite"));
    const workItem = store.createWorkItem({
      id: "wi_norun",
      title: "Legacy unbound conversation",
      mode: "auto",
      conversationId: "conv_sess_norun",
      riskLevel: "read_only",
    });
    const session = catalog.createSession({
      id: "sess_norun",
      agentId: "pi",
      taskRecordId: workItem.id,
    });
    insertDomainEvents(path.join(dataDir, "orchestration.sqlite"), [
      {
        sequence: 2,
        workItemId: workItem.id,
        type: "MESSAGE_RECEIVED",
        actor: "user",
        target: "turn_norun_1",
        payload: { message: "先看一眼", attachment_ids: [] },
      },
      {
        sequence: 3,
        workItemId: workItem.id,
        type: "AGENT_EVENT",
        actor: "agent",
        target: "answer_1",
        payload: {
          event: {
            type: "text_delta",
            blockId: "answer_1",
            phase: "final_answer",
            text: "看到了",
          },
        },
      },
    ]);
    expect(store.listRuns(workItem.id)).toHaveLength(0);

    const migration = new SessionRuntimeMigration(catalog, store);
    const first = migration.run({ batchSize: 2, maximumBatches: 1 });
    expect(first.migratedSessions).toBe(1);
    expect(store.getProjectionCursor(session.id)).toBe(2);
    migration.run({ batchSize: 2 });
    expect(store.getProjectionCursor(session.id)).toBe(3);
    const timelinePage = store.listTimelineTurns(session.id, { limit: 50 });
    expect(timelinePage.turns).toHaveLength(1);
    const timeline = timelinePage.turns[0]!;
    expect(timeline.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "user_message" }),
      expect.objectContaining({ kind: "assistant" }),
    ]));

    catalog.close();
    store.close();
  });

  it("stops before writing when one Session has multiple active Runs", () => {
    const fixture = createFixture();
    fixture.store.createRun({
      id: "run_conflict_1",
      workItemId: fixture.workItem.id,
      mode: "auto",
    });
    fixture.store.createRun({
      id: "run_conflict_2",
      workItemId: fixture.workItem.id,
      mode: "auto",
    });
    const before = fixture.store.countAllChanges();

    expect(() => new SessionRuntimeMigration(fixture.catalog, fixture.store).run({
      batchSize: 1_000,
    })).toThrow("session_runtime_migration_conflict");
    expect(fixture.store.countAllChanges()).toBe(before);

    fixture.catalog.close();
    fixture.store.close();
  });

  it("resumes projection from its persisted cursor", () => {
    const fixture = createFixture();
    const turnId = "turn_resume";
    const totalEvents = 2_500;
    const events = [
      {
        sequence: 3,
        workItemId: fixture.workItem.id,
        runId: fixture.run.id,
        type: "TURN_DISPATCHED",
        actor: "system",
        target: turnId,
        payload: { turn_id: turnId },
      },
      {
        sequence: 4,
        workItemId: fixture.workItem.id,
        runId: fixture.run.id,
        type: "MESSAGE_RECEIVED",
        actor: "user",
        target: turnId,
        payload: { message: "继续", attachment_ids: [] },
      },
      ...Array.from({ length: totalEvents - 4 }, (_, index) => ({
        sequence: index + 5,
        workItemId: fixture.workItem.id,
        runId: fixture.run.id,
        type: "AGENT_EVENT",
        actor: "agent",
        target: `block_${index + 1}`,
        payload: {
          event: {
            type: "text_delta",
            blockId: `block_${index + 1}`,
            phase: "final_answer",
            text: `chunk-${index + 1}`,
          },
        },
      })),
    ];
    insertDomainEvents(path.join(fixture.dataDir, "orchestration.sqlite"), events);

    const migration = new SessionRuntimeMigration(fixture.catalog, fixture.store);
    migration.run({ batchSize: 1_000, maximumBatches: 1 });
    expect(fixture.store.getProjectionCursor(fixture.session.id)).toBe(1_000);
    migration.run({ batchSize: 1_000 });
    expect(fixture.store.getProjectionCursor(fixture.session.id)).toBe(totalEvents);

    fixture.catalog.close();
    fixture.store.close();
  });

  it("keeps existing Run bindings when legacy queue positions drift", () => {
    const fixture = createFixture();
    const secondRun = fixture.store.createRun({
      id: "run_second",
      workItemId: fixture.workItem.id,
      mode: "auto",
    });
    fixture.store.updateRunStatus(fixture.run.id, "succeeded");
    fixture.store.updateRunStatus(secondRun.id, "succeeded");
    const migration = new SessionRuntimeMigration(fixture.catalog, fixture.store);
    migration.run({ batchSize: 1_000 });

    const databasePath = path.join(fixture.dataDir, "orchestration.sqlite");
    const database = new DatabaseSync(databasePath);
    const bindings = database
      .prepare(
        `SELECT turn_id, dispatched_run_id
         FROM session_turns
         WHERE session_id = ?
         ORDER BY queue_position ASC`,
      )
      .all(fixture.session.id) as Array<{
        turn_id: string;
        dispatched_run_id: string;
      }>;
    expect(bindings).toHaveLength(2);
    database.exec("BEGIN IMMEDIATE;");
    database
      .prepare("UPDATE session_turns SET queue_position = 99 WHERE turn_id = ?")
      .run(bindings[0]!.turn_id);
    database
      .prepare("UPDATE session_turns SET queue_position = 1 WHERE turn_id = ?")
      .run(bindings[1]!.turn_id);
    database
      .prepare("UPDATE session_turns SET queue_position = 2 WHERE turn_id = ?")
      .run(bindings[0]!.turn_id);
    database.exec("COMMIT;");
    database.close();

    expect(() => migration.run({ batchSize: 1_000 })).not.toThrow();

    const verification = new DatabaseSync(databasePath);
    const rebound = verification
      .prepare(
        `SELECT turn_id, dispatched_run_id
         FROM session_turns
         WHERE session_id = ?`,
      )
      .all(fixture.session.id) as Array<{
        turn_id: string;
        dispatched_run_id: string;
      }>;
    verification.close();
    expect(new Map(rebound.map((row) => [row.turn_id, row.dispatched_run_id])))
      .toEqual(new Map(bindings.map((row) => [row.turn_id, row.dispatched_run_id])));

    fixture.catalog.close();
    fixture.store.close();
  });
});
