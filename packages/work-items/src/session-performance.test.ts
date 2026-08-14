import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteEventStore } from "./index.js";

const projectionSpy = vi.hoisted(() => vi.fn());
vi.mock("./session-projector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-projector.js")>();
  return {
    ...actual,
    projectSessionEvent: (...args: Parameters<typeof actual.projectSessionEvent>) => {
      projectionSpy();
      return actual.projectSessionEvent(...args);
    },
  };
});

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createStore() {
  const directory = fs.mkdtempSync(
    path.join(process.cwd(), ".codebridge-session-performance-"),
  );
  tempDirs.push(directory);
  return new SqliteEventStore(path.join(directory, "session.sqlite"));
}

function seedLargeSession(store: SqliteEventStore) {
  const sessionId = "sess_perf";
  let workItemId = "";
  let activeRunId = "";

  store.withSessionTransaction((tx) => {
    workItemId = tx.getOrCreateWorkItem(sessionId, {
      title: "Session performance",
      mode: "auto",
      conversationId: "conv_perf",
      agentId: "pi",
      workspaceScope: ["/workspace"],
      riskLevel: "read_only",
    });
    tx.ensureRuntime(sessionId);
    for (let index = 0; index < 150; index += 1) {
      tx.insertTurn(sessionId, {
        text: `完成第 ${index + 1} 次回合`,
        attachmentIds: [],
        flowId: null,
        model: null,
        effort: null,
        permissionMode: null,
        plan: null,
      });
      const dispatched = tx.dispatchNextTurn(sessionId);
      if (!dispatched) throw new Error("expected dispatched Run");
      tx.appendEvent({
        workItemId,
        sessionId,
        runId: dispatched.run.id,
        type: "AGENT_EVENT",
        actor: "agent",
        payload: {
          event: {
            type: "text_delta",
            blockId: `answer_${index}`,
            phase: "final_answer",
            text: `完成 ${index + 1}`,
          },
        },
      });
      tx.updateRun(dispatched.run.id, {
        status: "succeeded",
        terminalReason: "seeded-completion",
      });
      tx.appendEvent({
        workItemId,
        sessionId,
        runId: dispatched.run.id,
        type: "RUN_SUCCEEDED",
        actor: "system",
        target: dispatched.run.id,
        payload: { reason: "seeded-completion" },
      });
      tx.updateRuntime(sessionId, { activeRunId: null });
    }

    tx.insertTurn(sessionId, {
      text: "保持队列热度",
      attachmentIds: [],
      flowId: null,
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    });
    const tail = tx.dispatchNextTurn(sessionId);
    if (!tail) throw new Error("expected active tail Run");
    activeRunId = tail.run.id;

    for (let index = 0; index < 100; index += 1) {
      tx.insertTurn(sessionId, {
        text: `排队第 ${index + 1} 条`,
        attachmentIds: [],
        flowId: null,
        model: null,
        effort: null,
        permissionMode: null,
        plan: null,
      });
    }
  });

  seedDomainEventVolume(store, workItemId, 150_000);
  return { sessionId, workItemId, activeRunId };
}

function seedDomainEventVolume(
  store: SqliteEventStore,
  workItemId: string,
  targetCount: number,
): void {
  const database = (store as unknown as {
    database: {
      exec(sql: string): void;
      prepare(statement: string): {
        get(...values: unknown[]): { count: number };
        run(...values: unknown[]): void;
      };
    };
  }).database;
  const existing = Number(database.prepare(
    "SELECT COUNT(*) AS count FROM domain_events WHERE work_item_id = ?",
  ).get(workItemId).count);
  const insert = database.prepare(
    `INSERT INTO domain_events (
      event_id, schema_version, sequence, work_item_id, run_id, type,
      occurred_at, actor, target, input_hash, result_ref, payload
    ) VALUES (?, 1, ?, ?, NULL, 'PERFORMANCE_FIXTURE', ?, 'test', NULL, NULL, NULL, '{}')`,
  );
  let sequence = existing + 1;
  while (sequence <= targetCount) {
    database.exec("BEGIN IMMEDIATE;");
    try {
      const end = Math.min(targetCount, sequence + 999);
      for (; sequence <= end; sequence += 1) {
        insert.run(
          `evt_perf_${sequence}`,
          sequence,
          workItemId,
          "2026-08-14T00:00:00.000Z",
        );
      }
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }
}

function explainQueryPlan(
  store: SqliteEventStore,
  sql: string,
  params: unknown[],
): string {
  const database = (store as unknown as {
    database: {
      prepare(statement: string): {
        all(...values: unknown[]): Array<{ detail: string }>;
      };
    };
  }).database;
  return database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
    .map((row) => row.detail)
    .join("\n");
}

function countDomainEvents(store: SqliteEventStore, workItemId: string): number {
  const database = (store as unknown as {
    database: {
      prepare(statement: string): {
        get(...values: unknown[]): { count: number };
      };
    };
  }).database;
  return Number(database.prepare(
    "SELECT COUNT(*) AS count FROM domain_events WHERE work_item_id = ?",
  ).get(workItemId).count);
}

describe("Session performance reads", () => {
  it("keeps long-Session reads bounded and indexed", () => {
    const store = createStore();
    const seeded = seedLargeSession(store);

    const timeline = store.listTimelineTurns(seeded.sessionId, {
      limit: 50,
      contentBudgetBytes: 1_048_576,
    });
    const queue = store.listQueuedTurns(seeded.sessionId, { limit: 100 });

    expect(countDomainEvents(store, seeded.workItemId)).toBe(150_000);
    expect(timeline.turns).toHaveLength(50);
    expect(queue.turns).toHaveLength(100);
    expect(queue.total).toBe(100);
    expect(Buffer.byteLength(JSON.stringify(timeline), "utf8"))
      .toBeLessThanOrEqual(1_048_576);

    expect(explainQueryPlan(store,
      `SELECT * FROM session_turns
       WHERE session_id = ? AND status = 'queued' AND queue_position > ?
       ORDER BY queue_position ASC
       LIMIT ?`,
      [seeded.sessionId, 0, 101],
    )).toMatch(/USING (?:COVERING )?INDEX session_turns_queue/i);

    expect(explainQueryPlan(store,
      `SELECT * FROM session_timeline_turns
       WHERE session_id = ? AND timeline_index < ?
       ORDER BY timeline_index DESC
       LIMIT ?`,
      [seeded.sessionId, Number.MAX_SAFE_INTEGER, 51],
    )).toMatch(/USING (?:COVERING )?INDEX session_timeline_recent/i);

    const before = projectionSpy.mock.calls.length;
    store.withSessionTransaction((tx) => {
      tx.appendEvent({
        workItemId: seeded.workItemId,
        sessionId: seeded.sessionId,
        runId: seeded.activeRunId,
        type: "AGENT_EVENT",
        actor: "agent",
        payload: {
          event: {
            type: "text_delta",
            blockId: "answer_tail",
            phase: "final_answer",
            text: "tail delta",
          },
        },
      });
    });
    expect(projectionSpy.mock.calls.length - before).toBe(1);

    store.close();
  });
});
