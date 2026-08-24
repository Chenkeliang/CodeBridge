import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { migrateChannelDeliveryStatusCheck } from "./session-schema.js";

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
      .prepare("SELECT turn_id, status, run_id, surface_card_id FROM channel_turn_delivery")
      .get() as {
        turn_id?: string;
        status?: string;
        run_id?: string;
        surface_card_id?: string | null;
      };
    expect(row).toEqual({
      turn_id: "turn_1",
      status: "pending",
      run_id: "run_1",
      surface_card_id: null,
    });

    // 非法状态会被 CHECK 拒绝
    expect(() =>
      db.prepare("INSERT INTO channel_turn_delivery (turn_id, session_id, channel, conversation_id, reply_to_message_id, accepted_sequence, status, created_at, updated_at) VALUES ('turn_2', 's', 'f', 'c', 'm', 1, 'bogus', 't', 't')").run(),
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
