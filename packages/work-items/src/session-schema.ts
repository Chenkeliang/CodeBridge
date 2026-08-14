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
  `);
}
