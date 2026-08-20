import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { SqliteEventStore } from "@codebridge/work-items";

export * from "./capability-runtime.js";
export { registerDemoCapabilities } from "./demo-capabilities.js";
export { registerEquityCapabilities } from "./equity-capabilities.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

export type CapabilityRisk =
  | "read_only"
  | "workspace_write"
  | "git_write"
  | "production_write";

export interface CapabilityDefinition {
  id: string;
  risk: CapabilityRisk;
  adapter: string;
  environments?: string[];
  description?: string;
  source?: CapabilitySource;
  /** true when the capability mutates state; such adapters must honor context.dry_run. */
  side_effects?: boolean;
  idempotency?: {
    /** input field names that derive the idempotency key. */
    key: string[];
    /** dedupe window. `permanent` = never expires. */
    validity_window?: "24h" | "7d" | "permanent";
  };
}

export interface CapabilitySource {
  kind: "skill" | "mcp" | "cli" | "http" | "function";
  ref: string;
  version?: string;
  revision?: string;
}

export interface CapabilityRegistryOptions {
  databasePath?: string;
}

export interface PolicyContext {
  environment: string;
  approvalGranted?: boolean;
}

export type PolicyDecision =
  | { allowed: true; requiresApproval: false; capability: CapabilityDefinition }
  | { allowed: false; requiresApproval: true; reason: "approval_required"; capability: CapabilityDefinition }
  | { allowed: false; requiresApproval: false; reason: "unknown_capability" | "environment_not_allowed" };

export class CapabilityRegistry {
  private readonly definitions = new Map<string, CapabilityDefinition>();
  private readonly database: DatabaseSyncType;

  constructor(definitions: CapabilityDefinition[] = [], options: CapabilityRegistryOptions = {}) {
    const databasePath = options.databasePath ?? ":memory:";
    if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS capabilities (
        id TEXT PRIMARY KEY,
        risk TEXT NOT NULL,
        adapter TEXT NOT NULL,
        environments TEXT,
        description TEXT,
        source_kind TEXT,
        source_ref TEXT,
        source_version TEXT,
        source_revision TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    for (const statement of [
      "ALTER TABLE capabilities ADD COLUMN source_kind TEXT",
      "ALTER TABLE capabilities ADD COLUMN source_ref TEXT",
      "ALTER TABLE capabilities ADD COLUMN source_version TEXT",
      "ALTER TABLE capabilities ADD COLUMN source_revision TEXT",
      "ALTER TABLE capabilities ADD COLUMN side_effects TEXT",
      "ALTER TABLE capabilities ADD COLUMN idempotency TEXT",
    ]) {
      try { this.database.exec(statement); } catch { /* Existing databases already contain the column. */ }
    }
    const rows = this.database.prepare("SELECT * FROM capabilities ORDER BY id ASC").all() as Record<string, unknown>[];
    for (const row of rows) this.definitions.set(String(row.id), toCapability(row));
    for (const definition of definitions) this.register(definition);
  }

  register(definition: CapabilityDefinition): void {
    if (!definition.id.trim()) throw new Error("capability id must not be empty");
    this.definitions.set(definition.id, {
      ...definition,
      environments: definition.environments ? [...definition.environments] : undefined,
      source: definition.source ? { ...definition.source } : undefined,
    });
    this.database
      .prepare(
        `INSERT INTO capabilities (
           id, risk, adapter, environments, description,
           source_kind, source_ref, source_version, source_revision, side_effects, idempotency, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET risk = excluded.risk, adapter = excluded.adapter,
           environments = excluded.environments, description = excluded.description,
           source_kind = excluded.source_kind, source_ref = excluded.source_ref,
           source_version = excluded.source_version, source_revision = excluded.source_revision,
           side_effects = excluded.side_effects, idempotency = excluded.idempotency,
           updated_at = excluded.updated_at`,
      )
      .run(
        definition.id,
        definition.risk,
        definition.adapter,
        definition.environments ? JSON.stringify(definition.environments) : null,
        definition.description ?? null,
        definition.source?.kind ?? null,
        definition.source?.ref ?? null,
        definition.source?.version ?? null,
        definition.source?.revision ?? null,
        definition.side_effects === undefined ? null : definition.side_effects ? "1" : "0",
        definition.idempotency ? JSON.stringify(definition.idempotency) : null,
        new Date().toISOString(),
      );
  }

  get(id: string): CapabilityDefinition | undefined {
    const definition = this.definitions.get(id);
    return definition
      ? {
          ...definition,
          environments: definition.environments ? [...definition.environments] : undefined,
          source: definition.source ? { ...definition.source } : undefined,
        }
      : undefined;
  }

  list(): CapabilityDefinition[] {
    return [...this.definitions.values()].map((definition) => ({
      ...definition,
      environments: definition.environments ? [...definition.environments] : undefined,
      source: definition.source ? { ...definition.source } : undefined,
    }));
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

function toCapability(row: Record<string, unknown>): CapabilityDefinition {
  const source = row.source_kind === null || row.source_kind === undefined
    ? undefined
    : {
        kind: String(row.source_kind) as CapabilitySource["kind"],
        ref: String(row.source_ref),
        version: row.source_version === null || row.source_version === undefined ? undefined : String(row.source_version),
        revision: row.source_revision === null || row.source_revision === undefined ? undefined : String(row.source_revision),
      };
  return {
    id: String(row.id),
    risk: String(row.risk) as CapabilityRisk,
    adapter: String(row.adapter),
    environments: row.environments === null ? undefined : JSON.parse(String(row.environments)) as string[],
    description: row.description === null ? undefined : String(row.description),
    source,
    side_effects: row.side_effects === null || row.side_effects === undefined ? undefined : String(row.side_effects) === "1",
    idempotency: row.idempotency === null || row.idempotency === undefined ? undefined : JSON.parse(String(row.idempotency)) as CapabilityDefinition["idempotency"],
  };
}

export class PolicyEngine {
  constructor(private readonly registry: CapabilityRegistry) {}

  getCapability(capabilityId: string): CapabilityDefinition | undefined {
    return this.registry.get(capabilityId);
  }

  evaluate(capabilityId: string, context: PolicyContext): PolicyDecision {
    const capability = this.registry.get(capabilityId);
    if (!capability) {
      return { allowed: false, requiresApproval: false, reason: "unknown_capability" };
    }
    if (
      capability.environments &&
      !capability.environments.includes(context.environment)
    ) {
      return { allowed: false, requiresApproval: false, reason: "environment_not_allowed" };
    }
    if (capability.risk === "production_write" && !context.approvalGranted) {
      return {
        allowed: false,
        requiresApproval: true,
        reason: "approval_required",
        capability,
      };
    }
    return { allowed: true, requiresApproval: false, capability };
  }
}

export type ApprovalStatus = "requested" | "granted" | "consumed" | "expired" | "revoked";

export interface ApprovalRecord {
  id: string;
  workItemId: string;
  runId: string;
  stepId: string;
  capabilityId: string;
  sessionId: string;
  environment: string;
  targetResource: string;
  inputHash: string;
  status: ApprovalStatus;
  requestedBy: string;
  grantedBy: string | null;
  createdAt: string;
  expiresAt: string;
  grantedAt: string | null;
  consumedAt: string | null;
}

export interface RequestApprovalInput {
  workItemId: string;
  runId: string;
  stepId: string;
  capabilityId: string;
  sessionId?: string;
  environment?: string;
  targetResource?: string;
  inputHash: string;
  requestedBy: string;
  ttlMs?: number;
}

export class ApprovalService {
  private readonly database: DatabaseSyncType;

  constructor(
    private readonly eventStore: SqliteEventStore,
    databasePath: string,
  ) {
    if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        environment TEXT NOT NULL DEFAULT 'unknown',
        target_resource TEXT NOT NULL DEFAULT '',
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        granted_by TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        granted_at TEXT,
        consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS approvals_run ON approvals (run_id, status);
    `);
    for (const statement of [
      "ALTER TABLE approvals ADD COLUMN session_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE approvals ADD COLUMN environment TEXT NOT NULL DEFAULT 'unknown'",
      "ALTER TABLE approvals ADD COLUMN target_resource TEXT NOT NULL DEFAULT ''",
    ]) {
      try { this.database.exec(statement); } catch { /* Existing databases already contain the column. */ }
    }
  }

  request(input: RequestApprovalInput): ApprovalRecord {
    if (!this.eventStore.getWorkItem(input.workItemId)) {
      throw new Error(`WorkItem not found: ${input.workItemId}`);
    }
    const createdAt = new Date();
    const record: ApprovalRecord = {
      id: `apr_${randomUUID().replaceAll("-", "")}`,
      workItemId: input.workItemId,
      runId: input.runId,
      stepId: input.stepId,
      capabilityId: input.capabilityId,
      sessionId: input.sessionId ?? "unknown",
      environment: input.environment ?? "unknown",
      targetResource: input.targetResource ?? "unknown",
      inputHash: input.inputHash,
      status: "requested",
      requestedBy: input.requestedBy,
      grantedBy: null,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + (input.ttlMs ?? 15 * 60_000)).toISOString(),
      grantedAt: null,
      consumedAt: null,
    };
    this.database
      .prepare(
        `INSERT INTO approvals (
          id, work_item_id, run_id, step_id, capability_id, input_hash, status,
          session_id, environment, target_resource, requested_by, granted_by,
          created_at, expires_at, granted_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workItemId,
        record.runId,
        record.stepId,
        record.capabilityId,
        record.inputHash,
        record.status,
        record.sessionId,
        record.environment,
        record.targetResource,
        record.requestedBy,
        record.grantedBy,
        record.createdAt,
        record.expiresAt,
        record.grantedAt,
        record.consumedAt,
      );
    this.eventStore.appendEvent({
      workItemId: record.workItemId,
      runId: record.runId,
      type: "APPROVAL_REQUESTED",
      actor: "system",
      target: record.capabilityId,
      inputHash: record.inputHash,
      payload: {
        approval_id: record.id,
        step_id: record.stepId,
        session_id: record.sessionId,
        environment: record.environment,
        target_resource: record.targetResource,
        expires_at: record.expiresAt,
      },
    });
    return record;
  }

  grant(id: string, grantedBy: string): ApprovalRecord | undefined {
    const record = this.get(id);
    if (!record || record.status !== "requested") return record;
    const now = new Date();
    if (new Date(record.expiresAt).getTime() <= now.getTime()) {
      this.database.prepare("UPDATE approvals SET status = 'expired' WHERE id = ?").run(id);
      return this.get(id);
    }
    const grantedAt = now.toISOString();
    this.database
      .prepare("UPDATE approvals SET status = 'granted', granted_by = ?, granted_at = ? WHERE id = ?")
      .run(grantedBy, grantedAt, id);
    this.eventStore.appendEvent({
      workItemId: record.workItemId,
      runId: record.runId,
      type: "APPROVAL_GRANTED",
      actor: "user",
      target: record.capabilityId,
      inputHash: record.inputHash,
      payload: { approval_id: id, step_id: record.stepId, granted_by: grantedBy },
    });
    return this.get(id);
  }

  revoke(id: string, rejectedBy: string): ApprovalRecord | undefined {
    const record = this.get(id);
    if (!record || record.status !== "requested") return record;
    this.database.prepare("UPDATE approvals SET status = 'revoked', granted_by = ? WHERE id = ?")
      .run(rejectedBy, id);
    this.eventStore.appendEvent({
      workItemId: record.workItemId,
      runId: record.runId,
      type: "APPROVAL_REJECTED",
      actor: "user",
      target: record.capabilityId,
      inputHash: record.inputHash,
      payload: { approval_id: id, step_id: record.stepId, rejected_by: rejectedBy },
    });
    return this.get(id);
  }

  consume(id: string, runId: string, stepId: string, inputHash: string): boolean {
    const record = this.get(id);
    if (!record || record.status !== "granted") return false;
    if (record.runId !== runId || record.stepId !== stepId || record.inputHash !== inputHash) return false;
    if (new Date(record.expiresAt).getTime() <= Date.now()) {
      this.database.prepare("UPDATE approvals SET status = 'expired' WHERE id = ?").run(id);
      return false;
    }
    const result = this.database
      .prepare("UPDATE approvals SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'granted'")
      .run(new Date().toISOString(), id);
    return Number(result.changes) === 1;
  }

  get(id: string): ApprovalRecord | undefined {
    const row = this.database.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toApproval(row) : undefined;
  }

  listForRun(runId: string): ApprovalRecord[] {
    return (this.database.prepare("SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at ASC").all(runId) as Record<string, unknown>[]).map(toApproval);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

function toApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: String(row.id),
    workItemId: String(row.work_item_id),
    runId: String(row.run_id),
    stepId: String(row.step_id),
    capabilityId: String(row.capability_id),
    sessionId: row.session_id === null ? "unknown" : String(row.session_id),
    environment: row.environment === null ? "unknown" : String(row.environment),
    targetResource: row.target_resource === null ? "unknown" : String(row.target_resource),
    inputHash: String(row.input_hash),
    status: String(row.status) as ApprovalStatus,
    requestedBy: String(row.requested_by),
    grantedBy: row.granted_by === null ? null : String(row.granted_by),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    grantedAt: row.granted_at === null ? null : String(row.granted_at),
    consumedAt: row.consumed_at === null ? null : String(row.consumed_at),
  };
}
