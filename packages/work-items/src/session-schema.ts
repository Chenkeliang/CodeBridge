import type { DatabaseSync } from "node:sqlite";

function addColumn(database: DatabaseSync, statement: string): void {
  try {
    database.exec(statement);
  } catch (error) {
    if (
      !(error instanceof Error)
      || !error.message.includes("duplicate column name")
    ) {
      throw error;
    }
  }
}

export function initializeSessionRuntimeSchema(
  database: DatabaseSync,
): void {
  addColumn(database, "ALTER TABLE work_items ADD COLUMN session_id TEXT");
  addColumn(database, "ALTER TABLE runs ADD COLUMN session_id TEXT");
  addColumn(database, "ALTER TABLE runs ADD COLUMN turn_id TEXT");
  addColumn(database, "ALTER TABLE runs ADD COLUMN terminal_reason TEXT");
  addColumn(
    database,
    "ALTER TABLE runs ADD COLUMN replay_safety TEXT NOT NULL DEFAULT 'safe'",
  );
  addColumn(database, "ALTER TABLE runs ADD COLUMN lease_owner TEXT");
  addColumn(database, "ALTER TABLE runs ADD COLUMN lease_expires_at TEXT");
  addColumn(database, "ALTER TABLE runs ADD COLUMN cancel_requested_at TEXT");
  addColumn(database, "ALTER TABLE runs ADD COLUMN cancel_deadline_at TEXT");
  addColumn(database, "ALTER TABLE runs ADD COLUMN provider_session_id TEXT");
  addColumn(
    database,
    "ALTER TABLE runs ADD COLUMN execution_kind TEXT NOT NULL DEFAULT 'agent' CHECK (execution_kind IN ('agent', 'flow'))",
  );
  addColumn(
    database,
    "ALTER TABLE domain_events ADD COLUMN execution_kind TEXT CHECK (execution_kind IN ('agent', 'flow') OR execution_kind IS NULL)",
  );
  database.exec(`
    UPDATE runs
    SET execution_kind = 'flow'
    WHERE workflow_revision IS NOT NULL;

    UPDATE domain_events
    SET execution_kind = (
      SELECT runs.execution_kind
      FROM runs
      WHERE runs.id = domain_events.run_id
    )
    WHERE run_id IS NOT NULL;

    UPDATE domain_events
    SET execution_kind = NULL
    WHERE run_id IS NULL;
  `);

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS work_items_one_per_session
      ON work_items(session_id) WHERE session_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS session_runtime (
      session_id TEXT PRIMARY KEY,
      active_run_id TEXT,
      queue_state TEXT NOT NULL DEFAULT 'ready',
      queue_pause_reason TEXT,
      last_event_sequence INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      provider_session_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_turns (
      turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      queue_position INTEGER NOT NULL,
      status TEXT NOT NULL,
      message_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      dispatched_run_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      dispatched_at TEXT,
      cancelled_at TEXT,
      UNIQUE(session_id, queue_position)
    );
    CREATE INDEX IF NOT EXISTS session_turns_queue
      ON session_turns(session_id, status, queue_position);

    CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_session
      ON runs(session_id)
      WHERE session_id IS NOT NULL
        AND status IN ('queued', 'running', 'waiting');
    CREATE INDEX IF NOT EXISTS runs_running_lease_expiry
      ON runs(lease_expires_at)
      WHERE status = 'running' AND lease_expires_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS runs_cancellation_deadline
      ON runs(cancel_deadline_at)
      WHERE status = 'running' AND cancel_deadline_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS domain_events_run_terminal
      ON domain_events(run_id, type, sequence DESC)
      WHERE run_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS run_attempts (
      attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      provider_error TEXT,
      side_effect_boundary TEXT NOT NULL DEFAULT 'safe',
      UNIQUE(run_id, attempt_number)
    );

    CREATE TABLE IF NOT EXISTS session_timeline_turns (
      session_id TEXT NOT NULL,
      timeline_index INTEGER NOT NULL,
      turn_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL UNIQUE,
      started_sequence INTEGER NOT NULL,
      ended_sequence INTEGER,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id, timeline_index)
    );
    CREATE INDEX IF NOT EXISTS session_timeline_recent
      ON session_timeline_turns(session_id, timeline_index DESC);

    CREATE TABLE IF NOT EXISTS session_timeline_blocks (
      block_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      block_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(turn_id, block_index)
    );

    CREATE TABLE IF NOT EXISTS session_output_segments (
      segment_id TEXT PRIMARY KEY,
      block_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      sealed INTEGER NOT NULL,
      UNIQUE(block_id, segment_index)
    );

    CREATE TABLE IF NOT EXISTS session_commands (
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      input_json TEXT,
      source_sequence INTEGER NOT NULL,
      PRIMARY KEY(session_id, name)
    );

    CREATE TABLE IF NOT EXISTS session_projection_cursors (
      session_id TEXT PRIMARY KEY,
      last_projected_sequence INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_history_imports (
      session_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      provider_digest TEXT NOT NULL,
      imported_position INTEGER NOT NULL,
      imported_at TEXT NOT NULL,
      PRIMARY KEY(session_id, provider_session_id)
    );

    CREATE TABLE IF NOT EXISTS provider_session_leases (
      agent_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      lease_owner TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      PRIMARY KEY(agent_id, provider_session_id)
    );

    CREATE TABLE IF NOT EXISTS channel_turn_delivery (
      turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      reply_to_message_id TEXT NOT NULL,
      show_thinking INTEGER NOT NULL DEFAULT 0
        CHECK (show_thinking IN (0, 1)),
      surface_message_id TEXT,
      surface_card_id TEXT,
      claim_owner TEXT,
      claim_expires_at TEXT,
      accepted_sequence INTEGER NOT NULL,
      run_id TEXT,
      run_terminal_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'delivering', 'completed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS channel_delivery_pending
      ON channel_turn_delivery (channel, status);
  `);

  database.exec(`
    UPDATE session_turns
    SET message_json = json_set(
      message_json,
      '$.executionKind',
      CASE
        WHEN json_extract(message_json, '$.flowInvocationSource') IN ('request', 'binding')
          OR json_extract(message_json, '$.plan') IS NOT NULL
        THEN 'flow'
        ELSE 'agent'
      END
    )
    WHERE json_extract(message_json, '$.executionKind') IS NULL;
  `);

  removeMisprojectedAgentFlowBlocks(database);

  // 迁移已有库：session_runtime 表在此处才被 CREATE，故 provider_session_id
  // 的 ALTER 必须在建表之后执行（新库该列已内联在 CREATE TABLE 中）。
  addColumn(
    database,
    "ALTER TABLE session_runtime ADD COLUMN provider_session_id TEXT",
  );
  addColumn(
    database,
    "ALTER TABLE channel_turn_delivery ADD COLUMN surface_card_id TEXT",
  );
  addColumn(
    database,
    "ALTER TABLE channel_turn_delivery ADD COLUMN show_thinking INTEGER NOT NULL DEFAULT 0 CHECK (show_thinking IN (0, 1))",
  );

  migrateChannelDeliveryStatusCheck(database);
}

export function removeMisprojectedAgentFlowBlocks(
  database: DatabaseSync,
): number {
  const invalidBlocks = `
    SELECT blocks.block_id
    FROM session_timeline_blocks AS blocks
    JOIN runs ON runs.id = blocks.run_id
    WHERE runs.execution_kind = 'agent'
      AND blocks.kind IN ('flow_step', 'flow_run', 'flow_failure')
  `;
  database
    .prepare(
      `DELETE FROM session_output_segments
       WHERE block_id IN (${invalidBlocks})`,
    )
    .run();
  const result = database
    .prepare(
      `DELETE FROM session_timeline_blocks
       WHERE block_id IN (${invalidBlocks})`,
    )
    .run();
  return Number(result.changes);
}

/**
 * 旧版 channel_turn_delivery（无 status CHECK）升级：重建带约束的表。
 * 迁移包在事务内，保留全部数据；只有检测到缺少 CHECK 时才执行。
 */
export function migrateChannelDeliveryStatusCheck(
  database: DatabaseSync,
): void {
  const row = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channel_turn_delivery'",
    )
    .get() as { sql?: string } | undefined;
  if (!row?.sql) return;
  addColumn(
    database,
    "ALTER TABLE channel_turn_delivery ADD COLUMN surface_card_id TEXT",
  );
  addColumn(
    database,
    "ALTER TABLE channel_turn_delivery ADD COLUMN show_thinking INTEGER NOT NULL DEFAULT 0 CHECK (show_thinking IN (0, 1))",
  );
  if (/status\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*status\s+IN/i.test(row.sql)) {
    return;
  }

  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(
      "ALTER TABLE channel_turn_delivery RENAME TO channel_turn_delivery_legacy;",
    );
    database.exec(`
      CREATE TABLE channel_turn_delivery (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        reply_to_message_id TEXT NOT NULL,
        show_thinking INTEGER NOT NULL DEFAULT 0
          CHECK (show_thinking IN (0, 1)),
        surface_message_id TEXT,
        surface_card_id TEXT,
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
    database.exec(`
      INSERT INTO channel_turn_delivery (
        turn_id, session_id, channel, conversation_id, reply_to_message_id,
        show_thinking, surface_message_id, surface_card_id, claim_owner, claim_expires_at,
        accepted_sequence, run_id, run_terminal_at, status, created_at,
        updated_at
      )
      SELECT
        turn_id, session_id, channel, conversation_id, reply_to_message_id,
        show_thinking, surface_message_id, surface_card_id, claim_owner, claim_expires_at,
        accepted_sequence, run_id, run_terminal_at, status, created_at,
        updated_at
      FROM channel_turn_delivery_legacy;
    `);
    database.exec("DROP TABLE channel_turn_delivery_legacy;");
    database.exec(`
      CREATE INDEX IF NOT EXISTS channel_delivery_pending
        ON channel_turn_delivery (channel, status);
    `);
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}
