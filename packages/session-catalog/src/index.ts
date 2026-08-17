import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  canonicalWorkspaceKey,
  type ChannelSlot,
} from "@codebridge/core";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

export type SessionStatus = "active" | "idle" | "closed" | "unavailable";
export type SessionConfigOverrides = Record<string, string | boolean>;

export type AgentSetupInstallation = "installed" | "missing" | "unknown";
export type AgentSetupConfiguration = "configured" | "needs_configuration" | "unknown";
export type AgentSetupRuntime = "healthy" | "unavailable" | "not_started";
export type AgentSetupStage = "detect" | "install" | "configure" | "health";

export interface AgentDiagnostic {
  stage: AgentSetupStage;
  code: string;
  message: string;
  details?: string;
  exitCode?: number;
}

export interface AgentInstallStrategy {
  id: string;
  label: string;
  command: string;
  args: string[];
  available: boolean;
  requiresConfirmation: true;
}

export interface AgentSetupManifest {
  agentId: string;
  displayName: string;
  adapter: "sdk" | "acp" | "cli";
  installStrategies: AgentInstallStrategy[];
  configurationOwner: "codebridge" | "agent";
  configurationPath?: string;
  documentationUrl?: string;
  supportsManagedConfiguration: boolean;
}

export interface AgentSetupState {
  installation: AgentSetupInstallation;
  configuration: AgentSetupConfiguration;
  runtime: AgentSetupRuntime;
  version?: string;
  executablePath?: string;
  diagnostic?: AgentDiagnostic;
  canSelectDefault: boolean;
  canCreateSession: boolean;
}

export interface AgentProfile {
  agentId: string;
  displayName: string;
  adapter: "sdk" | "acp" | "cli";
  status: "healthy" | "unavailable" | "needs_setup";
  capabilities: string[];
  models: string[];
  sessionFeatures: string[];
  setup?: AgentSetupState;
  setupManifest?: AgentSetupManifest;
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
  configOverrides: SessionConfigOverrides;
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

export interface ChannelSessionBinding extends ChannelSlot {
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
  configOverrides?: SessionConfigOverrides;
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

  constructor(
    databasePath: string,
    options: { defaultCwd?: string } = {},
  ) {
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
        config_overrides TEXT NOT NULL,
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
        agent_id TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (channel, conversation_id, agent_id, workspace_key, generation),
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
      this.database.exec("ALTER TABLE agent_sessions ADD COLUMN config_overrides TEXT NOT NULL DEFAULT '{}'");
    } catch {
      // Existing databases already contain the Agent config override column.
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

    const legacy = this.database
      .prepare(
        "SELECT COUNT(*) AS n FROM pragma_table_info('channel_session_bindings') WHERE name = 'agent_id'",
      )
      .get() as { n?: number } | undefined;
    if (Number(legacy?.n ?? 0) === 0) {
      this.migrateLegacyChannelBindings(options.defaultCwd);
    }
  }

  private migrateLegacyChannelBindings(defaultCwd?: string): void {
    const orphans: string[] = [];
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.exec(`
        CREATE TABLE channel_session_bindings_new (
          channel TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          workspace_key TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 0,
          session_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (channel, conversation_id, agent_id, workspace_key, generation),
          FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
        );
      `);
      const rows = this.database
        .prepare(
          `SELECT b.channel, b.conversation_id, b.session_id, b.created_at, b.updated_at,
                  s.agent_id, s.cwd
           FROM channel_session_bindings b
           LEFT JOIN agent_sessions s ON s.id = b.session_id`,
        )
        .all() as SqliteRow[];
      const insert = this.database.prepare(
        `INSERT INTO channel_session_bindings_new (
          channel, conversation_id, agent_id, workspace_key, generation,
          session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      );
      for (const row of rows) {
        if (row.agent_id === null) {
          orphans.push(String(row.session_id ?? "<unknown>"));
          continue;
        }
        insert.run(
          String(row.channel),
          String(row.conversation_id),
          String(row.agent_id),
          canonicalWorkspaceKey(String(row.cwd ?? defaultCwd ?? "")).key,
          String(row.session_id),
          String(row.created_at),
          String(row.updated_at),
        );
      }
      this.database.exec("DROP TABLE channel_session_bindings;");
      this.database.exec("ALTER TABLE channel_session_bindings_new RENAME TO channel_session_bindings;");
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS channel_bindings_lookup
          ON channel_session_bindings (channel, conversation_id, agent_id, workspace_key, generation);
      `);
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
    if (orphans.length) {
      console.warn(
        `[session-catalog] skipped ${orphans.length} orphan channel bindings`,
      );
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
      configOverrides: { ...(input.configOverrides ?? {}) },
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
          id, schema_version, agent_id, provider_session_id, task_record_id, flow_id, model, effort, config_overrides, permission_mode, folder_id, cwd,
          additional_directories, title, status, pinned_at, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(session.configOverrides),
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
    slot: ChannelSlot,
    sessionId: string,
  ): ChannelSessionBinding {
    if (!this.getSession(sessionId)) throw new Error(`Session not found: ${sessionId}`);
    const existing = this.getChannelBinding(slot);
    if (existing) return existing;
    const now = new Date().toISOString();
    const binding: ChannelSessionBinding = {
      ...slot,
      sessionId,
      createdAt: now,
      updatedAt: now,
    };
    this.database
      .prepare(
        `INSERT INTO channel_session_bindings (
          channel, conversation_id, agent_id, workspace_key, generation,
          session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.channel,
        binding.conversationId,
        binding.agentId,
        binding.workspaceKey,
        binding.generation,
        binding.sessionId,
        binding.createdAt,
        binding.updatedAt,
      );
    return binding;
  }

  bindHistoricalSession(
    slot: ChannelSlot,
    sessionId: string,
  ): ChannelSessionBinding {
    if (!this.getSession(sessionId)) throw new Error(`Session not found: ${sessionId}`);
    const existing = this.getChannelBinding(slot);
    if (existing) {
      if (existing.sessionId === sessionId) return existing;
      throw new Error("slot_already_bound");
    }
    const now = new Date().toISOString();
    const binding: ChannelSessionBinding = {
      ...slot,
      sessionId,
      createdAt: now,
      updatedAt: now,
    };
    this.database
      .prepare(
        `INSERT INTO channel_session_bindings (
          channel, conversation_id, agent_id, workspace_key, generation,
          session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.channel,
        binding.conversationId,
        binding.agentId,
        binding.workspaceKey,
        binding.generation,
        binding.sessionId,
        binding.createdAt,
        binding.updatedAt,
      );
    return binding;
  }

  getChannelBinding(slot: ChannelSlot): ChannelSessionBinding | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM channel_session_bindings
         WHERE channel = ? AND conversation_id = ? AND agent_id = ?
           AND workspace_key = ? AND generation = ?`,
      )
      .get(
        slot.channel,
        slot.conversationId,
        slot.agentId,
        slot.workspaceKey,
        slot.generation,
      ) as SqliteRow | undefined;
    return row ? toChannelBinding(row) : undefined;
  }

  getChannelSession(slot: ChannelSlot): AgentSession | undefined {
    const binding = this.getChannelBinding(slot);
    return binding ? this.getSession(binding.sessionId) : undefined;
  }

  /** 临时兼容（Task 6 移除）：按 conversation 取最近一条绑定，用于旧 ingress 的 cancel/reset/approval。 */
  getLatestChannelBinding(
    channel: string,
    conversationId: string,
  ): ChannelSessionBinding | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM channel_session_bindings
         WHERE channel = ? AND conversation_id = ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(channel, conversationId) as SqliteRow | undefined;
    return row ? toChannelBinding(row) : undefined;
  }

  unbindChannelConversation(slot: ChannelSlot): boolean {
    const result = this.database
      .prepare(
        `DELETE FROM channel_session_bindings
         WHERE channel = ? AND conversation_id = ? AND agent_id = ?
           AND workspace_key = ? AND generation = ?`,
      )
      .run(
        slot.channel,
        slot.conversationId,
        slot.agentId,
        slot.workspaceKey,
        slot.generation,
      );
    return Number(result.changes) > 0;
  }

  getOrCreateBoundSession(
    slot: ChannelSlot,
    input: CreateSessionInput,
  ): AgentSession {
    const existing = this.getChannelSession(slot);
    if (existing) return existing;
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const recheck = this.getChannelSession(slot);
      if (recheck) {
        this.database.exec("COMMIT;");
        return recheck;
      }
      const session = this.createSession(input);
      this.bindChannelConversation(slot, session.id);
      this.database.exec("COMMIT;");
      return session;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  createAndBindHistoricalSession(
    slot: ChannelSlot,
    providerSessionId: string,
  ): AgentSession {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.getChannelSession(slot);
      if (existing && existing.providerSessionId === providerSessionId) {
        this.database.exec("COMMIT;");
        return existing;
      }
      const session = this.createSession({
        agentId: slot.agentId,
        providerSessionId,
        cwd: slot.workspaceKey || null,
      });
      this.bindHistoricalSession(slot, session.id);
      this.database.exec("COMMIT;");
      return session;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
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
      configOverrides: input.configOverrides !== undefined ? { ...input.configOverrides } : existing.configOverrides,
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
        `UPDATE agent_sessions SET provider_session_id = ?, task_record_id = ?, flow_id = ?, model = ?, effort = ?, config_overrides = ?, permission_mode = ?, folder_id = ?, cwd = ?,
         additional_directories = ?, title = ?, status = ?, pinned_at = ?, archived_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.providerSessionId,
        next.taskRecordId,
        next.flowId,
        next.model,
        next.effort,
        JSON.stringify(next.configOverrides),
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
    configOverrides: JSON.parse(String(row.config_overrides ?? "{}")) as SessionConfigOverrides,
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
    agentId: String(row.agent_id),
    workspaceKey: String(row.workspace_key),
    generation: Number(row.generation),
    sessionId: String(row.session_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
