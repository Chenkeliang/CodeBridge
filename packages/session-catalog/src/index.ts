import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

export type SessionStatus = "active" | "idle" | "closed" | "unavailable";

export interface AgentProfile {
  agentId: string;
  displayName: string;
  adapter: "sdk" | "acp" | "cli";
  status: "healthy" | "unavailable" | "needs_setup";
  capabilities: string[];
  models: string[];
  sessionFeatures: string[];
}

export interface AgentSession {
  schemaVersion: 1;
  id: string;
  agentId: string;
  providerSessionId: string | null;
  taskRecordId: string | null;
  flowId: string | null;
  folderId: string | null;
  cwd: string | null;
  additionalDirectories: string[];
  title: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionInput {
  id?: string;
  agentId: string;
  providerSessionId?: string | null;
  taskRecordId?: string | null;
  flowId?: string | null;
  folderId?: string | null;
  cwd?: string | null;
  additionalDirectories?: string[];
  title?: string | null;
}

export type UpdateSessionInput = Partial<Omit<CreateSessionInput, "id" | "agentId">> & {
  status?: SessionStatus;
};

type SqliteRow = Record<string, unknown>;

export class SessionCatalogStore {
  private readonly database: DatabaseSyncType;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        provider_session_id TEXT,
        task_record_id TEXT,
        flow_id TEXT,
        folder_id TEXT,
        cwd TEXT,
        additional_directories TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_sessions_agent_updated
        ON agent_sessions (agent_id, updated_at DESC);
    `);
    try {
      this.database.exec("ALTER TABLE agent_sessions ADD COLUMN task_record_id TEXT");
    } catch {
      // Existing databases already contain the compatibility column.
    }
    try {
      this.database.exec("ALTER TABLE agent_sessions ADD COLUMN flow_id TEXT");
    } catch {
      // Existing databases already contain the Flow binding column.
    }
  }

  createSession(input: CreateSessionInput): AgentSession {
    const now = new Date().toISOString();
    const session: AgentSession = {
      schemaVersion: 1,
      id: input.id ?? `sess_${randomUUID().replaceAll("-", "")}`,
      agentId: input.agentId,
      providerSessionId: input.providerSessionId ?? null,
      taskRecordId: input.taskRecordId ?? null,
      flowId: input.flowId ?? null,
      folderId: input.folderId ?? null,
      cwd: input.cwd ?? null,
      additionalDirectories: [...(input.additionalDirectories ?? [])],
      title: input.title ?? null,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    this.database
      .prepare(
        `INSERT INTO agent_sessions (
          id, schema_version, agent_id, provider_session_id, task_record_id, flow_id, folder_id, cwd,
          additional_directories, title, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.schemaVersion,
        session.agentId,
        session.providerSessionId,
        session.taskRecordId,
        session.flowId,
        session.folderId,
        session.cwd,
        JSON.stringify(session.additionalDirectories),
        session.title,
        session.status,
        session.createdAt,
        session.updatedAt,
      );
    return session;
  }

  getSession(id: string): AgentSession | undefined {
    const row = this.database
      .prepare("SELECT * FROM agent_sessions WHERE id = ?")
      .get(id) as SqliteRow | undefined;
    return row ? toSession(row) : undefined;
  }

  getByProviderSession(agentId: string, providerSessionId: string): AgentSession | undefined {
    const row = this.database
      .prepare("SELECT * FROM agent_sessions WHERE agent_id = ? AND provider_session_id = ?")
      .get(agentId, providerSessionId) as SqliteRow | undefined;
    return row ? toSession(row) : undefined;
  }

  listSessions(agentId?: string): AgentSession[] {
    const rows = agentId
      ? this.database
          .prepare("SELECT * FROM agent_sessions WHERE agent_id = ? ORDER BY updated_at DESC")
          .all(agentId)
      : this.database
          .prepare("SELECT * FROM agent_sessions ORDER BY updated_at DESC")
          .all();
    return (rows as SqliteRow[]).map(toSession);
  }

  updateSession(id: string, input: UpdateSessionInput): AgentSession | undefined {
    const existing = this.getSession(id);
    if (!existing) return undefined;
    const next: AgentSession = {
      ...existing,
      providerSessionId: input.providerSessionId ?? existing.providerSessionId,
      taskRecordId: input.taskRecordId ?? existing.taskRecordId,
      flowId: input.flowId !== undefined ? input.flowId : existing.flowId,
      folderId: input.folderId ?? existing.folderId,
      cwd: input.cwd ?? existing.cwd,
      additionalDirectories: input.additionalDirectories ?? existing.additionalDirectories,
      title: input.title ?? existing.title,
      status: input.status ?? existing.status,
      updatedAt: new Date().toISOString(),
    };
    this.database
      .prepare(
        `UPDATE agent_sessions SET provider_session_id = ?, task_record_id = ?, flow_id = ?, folder_id = ?, cwd = ?,
         additional_directories = ?, title = ?, status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.providerSessionId,
        next.taskRecordId,
        next.flowId,
        next.folderId,
        next.cwd,
        JSON.stringify(next.additionalDirectories),
        next.title,
        next.status,
        next.updatedAt,
        id,
      );
    return next;
  }

  deleteSession(id: string): boolean {
    const result = this.database.prepare("DELETE FROM agent_sessions WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

function toSession(row: SqliteRow): AgentSession {
  return {
    schemaVersion: Number(row.schema_version) as 1,
    id: String(row.id),
    agentId: String(row.agent_id),
    providerSessionId: row.provider_session_id === null ? null : String(row.provider_session_id),
    taskRecordId: row.task_record_id === null ? null : String(row.task_record_id),
    flowId: row.flow_id === null ? null : String(row.flow_id),
    folderId: row.folder_id === null ? null : String(row.folder_id),
    cwd: row.cwd === null ? null : String(row.cwd),
    additionalDirectories: JSON.parse(String(row.additional_directories)) as string[],
    title: row.title === null ? null : String(row.title),
    status: String(row.status) as SessionStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
