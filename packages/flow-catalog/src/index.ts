import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

export type FlowKind = "ephemeral" | "guide" | "runbook";
export type FlowStatus = "draft" | "candidate" | "published" | "deprecated";
export type FlowSource = "agent_generated" | "user_selected" | "git";
export type FlowReviewStatus = "pending" | "approved" | "rejected";
export interface FlowStep {
  id: string;
  capability?: string;
  purpose?: string;
  dependsOn?: string[];
  mode?: string;
  approval?: "none" | "required";
  branches?: Array<{ when: string; next: string }>;
}
export interface FlowRecord {
  schemaVersion: 1;
  flowId: string;
  name: string | null;
  kind: FlowKind;
  status: FlowStatus;
  source: FlowSource;
  definitionRevision: string;
  reviewStatus: FlowReviewStatus;
  gitRevision: string | null;
  validationIssues: string[];
  steps: FlowStep[];
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;

export class FlowCatalogStore {
  private readonly database: DatabaseSyncType;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS flows (
        flow_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        name TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        definition_revision TEXT NOT NULL,
        review_status TEXT NOT NULL DEFAULT 'pending',
        git_revision TEXT,
        validation_issues TEXT NOT NULL DEFAULT '[]',
        steps TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    for (const statement of [
      "ALTER TABLE flows ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'",
      "ALTER TABLE flows ADD COLUMN git_revision TEXT",
      "ALTER TABLE flows ADD COLUMN validation_issues TEXT NOT NULL DEFAULT '[]'",
    ]) {
      try { this.database.exec(statement); } catch { /* Existing databases already contain the column. */ }
    }
  }

  save(input: Omit<FlowRecord, "schemaVersion" | "createdAt" | "updatedAt" | "reviewStatus" | "gitRevision" | "validationIssues"> & Partial<Pick<FlowRecord, "createdAt" | "updatedAt" | "reviewStatus" | "gitRevision" | "validationIssues">>): FlowRecord {
    const current = this.get(input.flowId);
    const now = new Date().toISOString();
    const record: FlowRecord = {
      schemaVersion: 1,
      flowId: input.flowId,
      name: input.name ?? null,
      kind: input.kind,
      status: input.status,
      source: input.source,
      definitionRevision: input.definitionRevision,
      reviewStatus: input.reviewStatus ?? current?.reviewStatus ?? (input.status === "published" ? "approved" : "pending"),
      gitRevision: input.gitRevision ?? current?.gitRevision ?? null,
      validationIssues: input.validationIssues ?? current?.validationIssues ?? [],
      steps: input.steps.map((step) => ({ ...step })),
      createdAt: current?.createdAt ?? input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.database.prepare(`
      INSERT INTO flows (flow_id, schema_version, name, kind, status, source, definition_revision, review_status, git_revision, validation_issues, steps, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(flow_id) DO UPDATE SET schema_version=excluded.schema_version, name=excluded.name,
        kind=excluded.kind, status=excluded.status, source=excluded.source,
        definition_revision=excluded.definition_revision, review_status=excluded.review_status,
        git_revision=excluded.git_revision, validation_issues=excluded.validation_issues,
        steps=excluded.steps, updated_at=excluded.updated_at
    `).run(record.flowId, record.schemaVersion, record.name, record.kind, record.status, record.source, record.definitionRevision, record.reviewStatus, record.gitRevision, JSON.stringify(record.validationIssues), JSON.stringify(record.steps), record.createdAt, record.updatedAt);
    return record;
  }

  get(flowId: string): FlowRecord | undefined {
    const row = this.database.prepare("SELECT * FROM flows WHERE flow_id = ?").get(flowId) as Row | undefined;
    return row ? toFlow(row) : undefined;
  }

  list(): FlowRecord[] {
    return (this.database.prepare("SELECT * FROM flows ORDER BY updated_at DESC, flow_id ASC").all() as Row[]).map(toFlow);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

function toFlow(row: Row): FlowRecord {
  return {
    schemaVersion: Number(row.schema_version) as 1,
    flowId: String(row.flow_id),
    name: row.name === null ? null : String(row.name),
    kind: String(row.kind) as FlowKind,
    status: String(row.status) as FlowStatus,
    source: String(row.source) as FlowSource,
    definitionRevision: String(row.definition_revision),
    reviewStatus: String(row.review_status ?? "pending") as FlowReviewStatus,
    gitRevision: row.git_revision === null || row.git_revision === undefined ? null : String(row.git_revision),
    validationIssues: JSON.parse(String(row.validation_issues ?? "[]")) as string[],
    steps: JSON.parse(String(row.steps)) as FlowStep[],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
