import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  AgentDiagnostic,
  AgentProfile,
  AgentSetupState,
} from "@codebridge/session-catalog";
import {
  cloneSetupManifest,
  cloneSetupState,
  projectAgentStatus,
  projectSetupState,
} from "./setup.js";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

export type AgentAdapter = {
  agentId: string;
  kind: AgentProfile["adapter"];
  health(): Promise<AgentSetupState["runtime"]> | AgentSetupState["runtime"];
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
    const existing = this.profiles.get(profile.agentId);
    const setup = cloneSetupState(profile.setup ?? existing?.setup);
    const setupManifest = cloneSetupManifest(profile.setupManifest ?? existing?.setupManifest);
    const nextSetup = setup ? mergeSetupWithHealth(setup, persisted) : undefined;
    const status = nextSetup ? projectAgentStatus(nextSetup) : persisted?.status ?? profile.status;
    this.profiles.set(profile.agentId, {
      ...profile,
      status,
      setup: nextSetup,
      setupManifest,
      capabilities: [...profile.capabilities],
      models: [...profile.models],
      sessionFeatures: [...profile.sessionFeatures],
    });
    return this.get(profile.agentId)!;
  }

  async refresh(adapter: AgentAdapter): Promise<AgentProfile | undefined> {
    const profile = this.get(adapter.agentId);
    if (!profile) return undefined;
    let runtime: AgentSetupState["runtime"];
    let error: string | null = null;
    try {
      runtime = await adapter.health();
    } catch (cause) {
      runtime = "unavailable";
      error = cause instanceof Error ? cause.message : String(cause);
    }
    if (profile.setup) {
      const diagnostic = runtime === "healthy"
        ? undefined
        : {
            stage: "health" as const,
            code: error ? "health_check_failed" : "runtime_unavailable",
            message: error ?? "Agent runtime unavailable",
            details: error ?? undefined,
          };
      return this.updateSetup(profile.agentId, {
        installation: profile.setup.installation,
        configuration: profile.setup.configuration,
        runtime,
        version: profile.setup.version,
        executablePath: profile.setup.executablePath,
        diagnostic,
      });
    }
    const status = runtime === "healthy" ? "healthy" : "unavailable";
    this.persistHealth(profile.agentId, status, error);
    profile.status = status;
    return this.register(profile);
  }

  updateSetup(
    agentId: string,
    setup: Omit<AgentSetupState, "canSelectDefault" | "canCreateSession">,
  ): AgentProfile | undefined {
    const existing = this.profiles.get(agentId);
    if (!existing) return undefined;
    const nextSetup = projectSetupState(setup);
    const next: AgentProfile = {
      ...existing,
      status: projectAgentStatus(nextSetup),
      setup: nextSetup,
      setupManifest: cloneSetupManifest(existing.setupManifest),
      capabilities: [...existing.capabilities],
      models: [...existing.models],
      sessionFeatures: [...existing.sessionFeatures],
    };
    this.profiles.set(agentId, next);
    this.persistHealth(agentId, next.status, nextSetup.diagnostic?.message ?? null);
    return this.get(agentId);
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

  private persistHealth(
    agentId: string,
    status: AgentProfile["status"],
    error: string | null,
  ): void {
    this.database
      .prepare(
        `INSERT INTO agent_health (agent_id, status, checked_at, error)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET status = excluded.status,
           checked_at = excluded.checked_at, error = excluded.error`,
      )
      .run(agentId, status, new Date().toISOString(), error);
  }
}

function clone(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    capabilities: [...profile.capabilities],
    models: [...profile.models],
    sessionFeatures: [...profile.sessionFeatures],
    setup: cloneSetupState(profile.setup),
    setupManifest: cloneSetupManifest(profile.setupManifest),
  };
}

function mergeSetupWithHealth(
  setup: AgentSetupState,
  persisted: AgentHealthRecord | undefined,
): AgentSetupState {
  if (!persisted) return projectSetupState({
    installation: setup.installation,
    configuration: setup.configuration,
    runtime: setup.runtime,
    version: setup.version,
    executablePath: setup.executablePath,
    diagnostic: cloneDiagnostic(setup.diagnostic),
  });
  const runtime = persisted.status === "healthy" || persisted.status === "unavailable"
    ? persisted.status
    : setup.runtime;
  return projectSetupState({
    installation: setup.installation,
    configuration: setup.configuration,
    runtime,
    version: setup.version,
    executablePath: setup.executablePath,
    diagnostic: persisted.error
      ? {
          stage: "health",
          code: persisted.status === "healthy" ? "healthy" : "runtime_unavailable",
          message: persisted.error,
          details: persisted.error,
        }
      : cloneDiagnostic(setup.diagnostic),
  });
}

function cloneDiagnostic(
  diagnostic: AgentDiagnostic | undefined,
): AgentDiagnostic | undefined {
  return diagnostic ? { ...diagnostic } : undefined;
}

export {
  cloneSetupManifest,
  cloneSetupState,
  getSupportedAgentSetupManifest,
  projectAgentStatus,
  projectSetupState,
  supportedAgentSetupManifestMap,
  supportedAgentSetupManifests,
} from "./setup.js";
export type {
  AgentDiagnostic,
  AgentInstallStrategy,
  AgentSetupConfiguration,
  AgentSetupInstallation,
  AgentSetupManifest,
  AgentSetupRuntime,
  AgentSetupStage,
  AgentSetupState,
} from "@codebridge/session-catalog";
