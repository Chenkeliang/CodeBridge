import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { AgentProfile } from "@codebridge/session-catalog";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

export type AgentAdapter = {
  agentId: string;
  kind: AgentProfile["adapter"];
  health(): Promise<AgentProfile["status"]> | AgentProfile["status"];
};

export interface AgentHealthRecord {
  agentId: string;
  status: AgentProfile["status"];
  checkedAt: string | null;
  error: string | null;
}

export interface AgentRegistryOptions {
  databasePath?: string;
}

export class AgentRegistry {
  private readonly profiles = new Map<string, AgentProfile>();
  private readonly database: DatabaseSyncType;

  constructor(options: AgentRegistryOptions = {}) {
    const databasePath = options.databasePath ?? ":memory:";
    if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS agent_health (
        agent_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        checked_at TEXT,
        error TEXT
      );
    `);
  }

  register(profile: AgentProfile): AgentProfile {
    const persisted = this.getHealth(profile.agentId);
    this.profiles.set(profile.agentId, {
      ...profile,
      status: persisted?.status ?? profile.status,
      capabilities: [...profile.capabilities],
      models: [...profile.models],
      sessionFeatures: [...profile.sessionFeatures],
    });
    return this.get(profile.agentId)!;
  }

  async refresh(adapter: AgentAdapter): Promise<AgentProfile | undefined> {
    const profile = this.get(adapter.agentId);
    if (!profile) return undefined;
    let status: AgentProfile["status"];
    let error: string | null = null;
    try {
      status = await adapter.health();
    } catch (cause) {
      status = "unavailable";
      error = cause instanceof Error ? cause.message : String(cause);
    }
    profile.status = status;
    this.database
      .prepare(
        `INSERT INTO agent_health (agent_id, status, checked_at, error)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET status = excluded.status,
           checked_at = excluded.checked_at, error = excluded.error`,
      )
      .run(profile.agentId, status, new Date().toISOString(), error);
    return this.register(profile);
  }

  getHealth(agentId: string): AgentHealthRecord | undefined {
    const row = this.database.prepare("SELECT * FROM agent_health WHERE agent_id = ?").get(agentId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      agentId: String(row.agent_id),
      status: String(row.status) as AgentProfile["status"],
      checkedAt: row.checked_at === null ? null : String(row.checked_at),
      error: row.error === null ? null : String(row.error),
    };
  }

  startHealthChecks(adapters: AgentAdapter[], intervalMs = 30_000): () => void {
    const refresh = () => { for (const adapter of adapters) void this.refresh(adapter); };
    refresh();
    const timer = setInterval(refresh, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  get(agentId: string): AgentProfile | undefined {
    const profile = this.profiles.get(agentId);
    return profile ? clone(profile) : undefined;
  }

  list(): AgentProfile[] {
    return [...this.profiles.values()].map(clone);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

function clone(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    capabilities: [...profile.capabilities],
    models: [...profile.models],
    sessionFeatures: [...profile.sessionFeatures],
  };
}
