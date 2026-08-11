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
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  folderId: string | null;
  cwd: string | null;
  additionalDirectories: string[];
  title: string | null;
  status: SessionStatus;
  pinnedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelSessionBinding {
  channel: string;
  conversationId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionInput {
  id?: string;
  agentId: string;
  providerSessionId?: string | null;
  taskRecordId?: string | null;
  flowId?: string | null;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  folderId?: string | null;
  cwd?: string | null;
  additionalDirectories?: string[];
  title?: string | null;
  updatedAt?: string;
}

export type UpdateSessionInput = Partial<Omit<CreateSessionInput, "id" | "agentId">> & {
  status?: SessionStatus;
  pinned?: boolean;
  archived?: boolean;
};

export interface ListSessionsOptions {
  includeArchived?: boolean;
}

type SqliteRow = Record<string, unknown>;

export class SessionCatalogStore {
  private readonly database: DatabaseSyncType;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        provider_session_id TEXT,
        task_record_id TEXT,
        flow_id TEXT,
        model TEXT,
        effort TEXT,
        permission_mode TEXT,
        folder_id TEXT,
        cwd TEXT,
        additional_directories TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL,
        pinned_at TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_sessions_agent_updated
        ON agent_sessions (agent_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS channel_session_bindings (
        channel TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (channel, conversation_id),
        FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
      );
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
    try {
      this.database.exec("ALTER TABLE agent_sessions ADD COLUMN model TEXT");
    } catch {
      // Existing databases already contain the model override column.
    }
    try {
      this.database.exec("ALTER TABLE agent_sessions ADD COLUMN permission_mode TEXT");
    } catch {
      // Existing databases already contain the Agent permission override column.
    }
    try {
      this.database.exec("ALTER TABLE agent_sessions ADD COLUMN effort TEXT");
    } catch {
      // Existing databases already contain the reasoning effort override column.
    }
    try {
      this.database.exec("ALTER TABLE agent_sessions ADD COLUMN pinned_at TEXT");
    } catch {
      // Existing databases already contain the pin metadata column.
    }
    try {
      this.database.exec("ALTER TABLE agent_sessions ADD COLUMN archived_at TEXT");
    } catch {
      // Existing databases already contain the archive metadata column.
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
      model: input.model ?? null,
      effort: input.effort ?? null,
      permissionMode: input.permissionMode ?? null,
      folderId: input.folderId ?? null,
      cwd: input.cwd ?? null,
      additionalDirectories: [...(input.additionalDirectories ?? [])],
      title: input.title ?? null,
      status: "idle",
      pinnedAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
    };
    this.database
      .prepare(
        `INSERT INTO agent_sessions (
          id, schema_version, agent_id, provider_session_id, task_record_id, flow_id, model, effort, permission_mode, folder_id, cwd,
          additional_directories, title, status, pinned_at, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.schemaVersion,
        session.agentId,
        session.providerSessionId,
        session.taskRecordId,
        session.flowId,
        session.model,
        session.effort,
        session.permissionMode,
        session.folderId,
        session.cwd,
        JSON.stringify(session.additionalDirectories),
        session.title,
        session.status,
        session.pinnedAt,
        session.archivedAt,
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

  listSessions(agentId?: string, options: ListSessionsOptions = {}): AgentSession[] {
    const archiveFilter = options.includeArchived ? "" : agentId ? " AND archived_at IS NULL" : " WHERE archived_at IS NULL";
    const order = " ORDER BY pinned_at IS NULL ASC, pinned_at DESC, updated_at DESC";
    const rows = agentId
      ? this.database
          .prepare(`SELECT * FROM agent_sessions WHERE agent_id = ?${archiveFilter}${order}`)
          .all(agentId)
      : this.database
          .prepare(`SELECT * FROM agent_sessions${archiveFilter}${order}`)
          .all();
    return (rows as SqliteRow[]).map(toSession);
  }

  bindChannelConversation(
    channel: string,
    conversationId: string,
    sessionId: string,
  ): ChannelSessionBinding {
    if (!this.getSession(sessionId)) throw new Error(`Session not found: ${sessionId}`);
    const existing = this.database
      .prepare("SELECT * FROM channel_session_bindings WHERE channel = ? AND conversation_id = ?")
      .get(channel, conversationId) as SqliteRow | undefined;
    if (existing) return toChannelBinding(existing);
    const now = new Date().toISOString();
    const binding: ChannelSessionBinding = {
      channel,
      conversationId,
      sessionId,
      createdAt: now,
      updatedAt: now,
    };
    this.database
      .prepare(
        `INSERT INTO channel_session_bindings (
          channel, conversation_id, session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(binding.channel, binding.conversationId, binding.sessionId, binding.createdAt, binding.updatedAt);
    return binding;
  }

  getChannelBinding(channel: string, conversationId: string): ChannelSessionBinding | undefined {
    const row = this.database
      .prepare("SELECT * FROM channel_session_bindings WHERE channel = ? AND conversation_id = ?")
      .get(channel, conversationId) as SqliteRow | undefined;
    return row ? toChannelBinding(row) : undefined;
  }

  getChannelSession(channel: string, conversationId: string): AgentSession | undefined {
    const binding = this.getChannelBinding(channel, conversationId);
    return binding ? this.getSession(binding.sessionId) : undefined;
  }

  unbindChannelConversation(channel: string, conversationId: string): boolean {
    const result = this.database
      .prepare("DELETE FROM channel_session_bindings WHERE channel = ? AND conversation_id = ?")
      .run(channel, conversationId);
    return Number(result.changes) > 0;
  }

  updateSession(id: string, input: UpdateSessionInput): AgentSession | undefined {
    const existing = this.getSession(id);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    const archivedAt = input.archived === undefined
      ? existing.archivedAt
      : input.archived ? now : null;
    const pinnedAt = input.archived
      ? null
      : input.pinned === undefined ? existing.pinnedAt : input.pinned ? now : null;
    const next: AgentSession = {
      ...existing,
      providerSessionId: input.providerSessionId ?? existing.providerSessionId,
      taskRecordId: input.taskRecordId ?? existing.taskRecordId,
      flowId: input.flowId !== undefined ? input.flowId : existing.flowId,
      model: input.model !== undefined ? input.model : existing.model,
      effort: input.effort !== undefined ? input.effort : existing.effort,
      permissionMode: input.permissionMode !== undefined ? input.permissionMode : existing.permissionMode,
      folderId: input.folderId ?? existing.folderId,
      cwd: input.cwd ?? existing.cwd,
      additionalDirectories: input.additionalDirectories ?? existing.additionalDirectories,
      title: input.title ?? existing.title,
      status: input.status ?? existing.status,
      pinnedAt,
      archivedAt,
      updatedAt: input.updatedAt ?? now,
    };
    this.database
      .prepare(
        `UPDATE agent_sessions SET provider_session_id = ?, task_record_id = ?, flow_id = ?, model = ?, effort = ?, permission_mode = ?, folder_id = ?, cwd = ?,
         additional_directories = ?, title = ?, status = ?, pinned_at = ?, archived_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.providerSessionId,
        next.taskRecordId,
        next.flowId,
        next.model,
        next.effort,
        next.permissionMode,
        next.folderId,
        next.cwd,
        JSON.stringify(next.additionalDirectories),
        next.title,
        next.status,
        next.pinnedAt,
        next.archivedAt,
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
    model: row.model === null || row.model === undefined ? null : String(row.model),
    effort: row.effort === null || row.effort === undefined ? null : String(row.effort),
    permissionMode: row.permission_mode === null || row.permission_mode === undefined ? null : String(row.permission_mode),
    folderId: row.folder_id === null ? null : String(row.folder_id),
    cwd: row.cwd === null ? null : String(row.cwd),
    additionalDirectories: JSON.parse(String(row.additional_directories)) as string[],
    title: row.title === null ? null : String(row.title),
    status: String(row.status) as SessionStatus,
    pinnedAt: row.pinned_at === null || row.pinned_at === undefined ? null : String(row.pinned_at),
    archivedAt: row.archived_at === null || row.archived_at === undefined ? null : String(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toChannelBinding(row: SqliteRow): ChannelSessionBinding {
  return {
    channel: String(row.channel),
    conversationId: String(row.conversation_id),
    sessionId: String(row.session_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
