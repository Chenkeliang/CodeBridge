import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  migrateChannelDeliveryStatusCheck,
  removeMisprojectedAgentFlowBlocks,
} from "./session-schema.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

const LEGACY_TABLE = `
  CREATE TABLE channel_turn_delivery (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    reply_to_message_id TEXT NOT NULL,
    surface_message_id TEXT,
    claim_owner TEXT,
    claim_expires_at TEXT,
    accepted_sequence INTEGER NOT NULL,
    run_id TEXT,
    run_terminal_at TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

describe("channel turn delivery schema migration", () => {
  it("removes only false Flow blocks from Agent Runs and is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        execution_kind TEXT NOT NULL
      );
      CREATE TABLE session_timeline_blocks (
        block_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL
      );
      CREATE TABLE session_output_segments (
        segment_id TEXT PRIMARY KEY,
        block_id TEXT NOT NULL
      );
      INSERT INTO runs VALUES ('run_agent', 'agent');
      INSERT INTO runs VALUES ('run_flow', 'flow');
      INSERT INTO session_timeline_blocks VALUES
        ('agent_step', 'run_agent', 'flow_step'),
        ('agent_failure', 'run_agent', 'flow_failure'),
        ('agent_param', 'run_agent', 'flow_param'),
        ('agent_batch', 'run_agent', 'flow_batch'),
        ('flow_step', 'run_flow', 'flow_step');
      INSERT INTO session_output_segments VALUES
        ('segment_agent', 'agent_step'),
        ('segment_flow', 'flow_step');
    `);

    expect(removeMisprojectedAgentFlowBlocks(db)).toBe(2);
    expect(removeMisprojectedAgentFlowBlocks(db)).toBe(0);
    expect(
      db.prepare("SELECT block_id FROM session_timeline_blocks ORDER BY block_id")
        .all().map((row) => String((row as { block_id: unknown }).block_id)),
    ).toEqual(["agent_batch", "agent_param", "flow_step"]);
    expect(
      db.prepare("SELECT segment_id FROM session_output_segments ORDER BY segment_id")
        .all().map((row) => String((row as { segment_id: unknown }).segment_id)),
    ).toEqual(["segment_flow"]);
    db.close();
  });

  it("upgrades a legacy table with a status CHECK and preserves data", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(LEGACY_TABLE);
    db.prepare(
      `INSERT INTO channel_turn_delivery (
        turn_id, session_id, channel, conversation_id, reply_to_message_id,
        surface_message_id, claim_owner, claim_expires_at, accepted_sequence,
        run_id, run_terminal_at, status, created_at, updated_at
      ) VALUES (
        'turn_1', 'sess_1', 'feishu', 'chat:1', 'msg_1',
        NULL, NULL, NULL, 3, 'run_1', NULL, 'pending', 't0', 't0'
      )`,
    ).run();

    migrateChannelDeliveryStatusCheck(db);

    const sql = (
      db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channel_turn_delivery'",
      ).get() as { sql?: string }
    ).sql;
    expect(sql).toContain("CHECK");

    const row = db
      .prepare("SELECT turn_id, status, run_id, surface_card_id, show_thinking FROM channel_turn_delivery")
      .get() as {
        turn_id?: string;
        status?: string;
        run_id?: string;
        surface_card_id?: string | null;
        show_thinking?: number;
      };
    expect(row).toEqual({
      turn_id: "turn_1",
      status: "pending",
      run_id: "run_1",
      surface_card_id: null,
      show_thinking: 0,
    });

    // 非法状态会被 CHECK 拒绝
    expect(() =>
      db.prepare("INSERT INTO channel_turn_delivery (turn_id, session_id, channel, conversation_id, reply_to_message_id, accepted_sequence, status, created_at, updated_at) VALUES ('turn_2', 's', 'f', 'c', 'm', 1, 'bogus', 't', 't')").run(),
    ).toThrow();
    db.close();
  });

  it("preserves an explicit thinking preference while adding the status constraint", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE channel_turn_delivery (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        reply_to_message_id TEXT NOT NULL,
        surface_message_id TEXT,
        surface_card_id TEXT,
        show_thinking INTEGER NOT NULL DEFAULT 0
          CHECK (show_thinking IN (0, 1)),
        claim_owner TEXT,
        claim_expires_at TEXT,
        accepted_sequence INTEGER NOT NULL,
        run_id TEXT,
        run_terminal_at TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO channel_turn_delivery (turn_id, session_id, channel, conversation_id, reply_to_message_id, show_thinking, accepted_sequence, status, created_at, updated_at) VALUES ('t1','s','f','c','m',1,1,'pending','t','t')",
    ).run();

    migrateChannelDeliveryStatusCheck(db);

    const row = db.prepare(
      "SELECT show_thinking FROM channel_turn_delivery WHERE turn_id = 't1'",
    ).get() as { show_thinking: number };
    expect(row.show_thinking).toBe(1);
    expect(() =>
      db.prepare(
        "INSERT INTO channel_turn_delivery (turn_id, session_id, channel, conversation_id, reply_to_message_id, accepted_sequence, status, created_at, updated_at) VALUES ('t2','s','f','c','m',1,'bogus','t','t')",
      ).run()
    ).toThrow();
    expect(() =>
      db.prepare(
        "UPDATE channel_turn_delivery SET show_thinking = 2 WHERE turn_id = 't1'",
      ).run()
    ).toThrow();
    db.close();
  });

  it("is a no-op when the CHECK already exists", () => {
    const db = new DatabaseSync(":memory:");
    migrateChannelDeliveryStatusCheck(db); // 无表 → no-op
    db.exec(`
      CREATE TABLE channel_turn_delivery (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        reply_to_message_id TEXT NOT NULL,
        surface_message_id TEXT,
        claim_owner TEXT,
        claim_expires_at TEXT,
        accepted_sequence INTEGER NOT NULL,
        run_id TEXT,
        run_terminal_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'delivering', 'completed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO channel_turn_delivery (turn_id, session_id, channel, conversation_id, reply_to_message_id, accepted_sequence, status, created_at, updated_at) VALUES ('t1','s','f','c','m',1,'pending','t','t')").run();

    migrateChannelDeliveryStatusCheck(db);

    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM channel_turn_delivery").get() as { n: number }
    ).n;
    expect(Number(count)).toBe(1);
    db.close();
  });
});
