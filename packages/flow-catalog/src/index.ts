import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { InvalidFlowStateError, isLegalFlowState } from "./policy.js";

export {
  InvalidFlowStateError,
  isBindable,
  isConsumable,
  isDryRunnable,
  isExecutable,
  isLegalFlowState,
  isManageable,
} from "./policy.js";

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
  retry?: { maxAttempts: number; delayMs: number };
  successWhen?: string;
}
export interface FlowInput {
  id: string;
  type: "string" | "integer" | "enum" | "directory" | "secret_ref";
  source: "user" | "context" | "agent" | "step_output" | "default";
  required?: boolean;
  pattern?: string;
  values?: string[];
  default?: string;
  confirmation?: { when: string };
  from?: string;
  scope?: "authorized_folders";
}

export interface FlowProvenance {
  sourceRunId: string;
  sourceSessionId: string;
  sourceFlowId: string;
  sourceDefinitionRevision: string;
}

export type FlowHistoryAction =
  | "created"
  | "definition_updated"
  | "review_approved"
  | "review_rejected"
  | "deprecated";

export interface FlowRecord {
  schemaVersion: 1;
  flowId: string;
  name: string | null;
  description: string | null;
  kind: FlowKind;
  status: FlowStatus;
  source: FlowSource;
  definitionRevision: string;
  planIrHash: string | null;
  inputs: FlowInput[];
  reviewStatus: FlowReviewStatus;
  gitRevision: string | null;
  validationIssues: string[];
  steps: FlowStep[];
  lineageRootFlowId: string;
  parentFlowId: string | null;
  provenance: FlowProvenance | null;
  publicationSequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface FlowHistoryEntry {
  id: number;
  flowId: string;
  definitionRevision: string;
  action: FlowHistoryAction;
  snapshot: FlowRecord;
  createdAt: string;
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
        description TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        definition_revision TEXT NOT NULL,
        lineage_root_flow_id TEXT,
        parent_flow_id TEXT,
        provenance TEXT,
        publication_sequence INTEGER NOT NULL DEFAULT 0,
        review_status TEXT NOT NULL DEFAULT 'pending',
        git_revision TEXT,
        validation_issues TEXT NOT NULL DEFAULT '[]',
        steps TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS flow_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flow_id TEXT NOT NULL,
        definition_revision TEXT NOT NULL,
        action TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flow_history_flow_created
        ON flow_history (flow_id, created_at, id);
    `);
    for (const statement of [
      "ALTER TABLE flows ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'",
      "ALTER TABLE flows ADD COLUMN git_revision TEXT",
      "ALTER TABLE flows ADD COLUMN validation_issues TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE flows ADD COLUMN plan_ir_hash TEXT",
      "ALTER TABLE flows ADD COLUMN inputs TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE flows ADD COLUMN description TEXT",
      "ALTER TABLE flows ADD COLUMN lineage_root_flow_id TEXT",
      "ALTER TABLE flows ADD COLUMN parent_flow_id TEXT",
      "ALTER TABLE flows ADD COLUMN provenance TEXT",
      "ALTER TABLE flows ADD COLUMN publication_sequence INTEGER NOT NULL DEFAULT 0",
    ]) {
      try { this.database.exec(statement); } catch { /* Existing databases already contain the column. */ }
    }
  }

  save(input: Omit<FlowRecord, "schemaVersion" | "createdAt" | "updatedAt" | "reviewStatus" | "gitRevision" | "validationIssues" | "planIrHash" | "inputs" | "description" | "lineageRootFlowId" | "parentFlowId" | "provenance" | "publicationSequence"> & Partial<Pick<FlowRecord, "createdAt" | "updatedAt" | "reviewStatus" | "gitRevision" | "validationIssues" | "planIrHash" | "inputs" | "description" | "lineageRootFlowId" | "parentFlowId" | "provenance" | "publicationSequence">>): FlowRecord {
    if (!isLegalFlowState(input)) {
      throw new InvalidFlowStateError(
        `invalid Flow state: ${input.kind}/${input.status}`,
      );
    }
    const current = this.get(input.flowId);
    const now = new Date().toISOString();
    const record: FlowRecord = {
      schemaVersion: 1,
      flowId: input.flowId,
      name: input.name ?? null,
      description: Object.hasOwn(input, "description") ? input.description ?? null : current?.description ?? null,
      kind: input.kind,
      status: input.status,
      source: input.source,
      definitionRevision: input.definitionRevision,
      planIrHash: input.planIrHash ?? current?.planIrHash ?? null,
      inputs: (input.inputs ?? current?.inputs ?? []).map((value) => ({ ...value })),
      reviewStatus: input.reviewStatus ?? current?.reviewStatus ?? (input.status === "published" ? "approved" : "pending"),
      gitRevision: Object.hasOwn(input, "gitRevision") ? input.gitRevision ?? null : current?.gitRevision ?? null,
      validationIssues: input.validationIssues ?? current?.validationIssues ?? [],
      steps: input.steps.map((step) => ({ ...step })),
      lineageRootFlowId: input.lineageRootFlowId ?? current?.lineageRootFlowId ?? input.flowId,
      parentFlowId: Object.hasOwn(input, "parentFlowId") ? input.parentFlowId ?? null : current?.parentFlowId ?? null,
      provenance: Object.hasOwn(input, "provenance")
        ? input.provenance ? { ...input.provenance } : null
        : current?.provenance ? { ...current.provenance } : null,
      publicationSequence: input.publicationSequence
        ?? current?.publicationSequence
        ?? (input.status === "published" ? 1 : 0),
      createdAt: current?.createdAt ?? input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.database.prepare(`
      INSERT INTO flows (flow_id, schema_version, name, description, kind, status, source, definition_revision, plan_ir_hash, inputs, review_status, git_revision, validation_issues, steps, lineage_root_flow_id, parent_flow_id, provenance, publication_sequence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(flow_id) DO UPDATE SET schema_version=excluded.schema_version, name=excluded.name,
        description=excluded.description, kind=excluded.kind, status=excluded.status, source=excluded.source,
        definition_revision=excluded.definition_revision, plan_ir_hash=excluded.plan_ir_hash, inputs=excluded.inputs,
        review_status=excluded.review_status,
        git_revision=excluded.git_revision, validation_issues=excluded.validation_issues,
        steps=excluded.steps, lineage_root_flow_id=excluded.lineage_root_flow_id,
        parent_flow_id=excluded.parent_flow_id, provenance=excluded.provenance,
        publication_sequence=excluded.publication_sequence, updated_at=excluded.updated_at
    `).run(record.flowId, record.schemaVersion, record.name, record.description, record.kind, record.status, record.source, record.definitionRevision, record.planIrHash, JSON.stringify(record.inputs), record.reviewStatus, record.gitRevision, JSON.stringify(record.validationIssues), JSON.stringify(record.steps), record.lineageRootFlowId, record.parentFlowId, record.provenance ? JSON.stringify(record.provenance) : null, record.publicationSequence, record.createdAt, record.updatedAt);
    if (!current || flowFingerprint(current) !== flowFingerprint(record)) {
      this.database.prepare(`
        INSERT INTO flow_history (flow_id, definition_revision, action, snapshot, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(record.flowId, record.definitionRevision, historyAction(current, record), JSON.stringify(record), record.updatedAt);
    }
    return record;
  }

  get(flowId: string): FlowRecord | undefined {
    const row = this.database.prepare("SELECT * FROM flows WHERE flow_id = ?").get(flowId) as Row | undefined;
    return row ? toFlow(row) : undefined;
  }

  list(): FlowRecord[] {
    return (this.database.prepare("SELECT * FROM flows ORDER BY updated_at DESC, flow_id ASC").all() as Row[]).map(toFlow);
  }

  history(flowId: string): FlowHistoryEntry[] {
    const rows = this.database.prepare(`
      SELECT * FROM flow_history WHERE flow_id = ? ORDER BY id ASC
    `).all(flowId) as Row[];
    return rows.map(toHistoryEntry);
  }

  getRevision(flowId: string, definitionRevision: string): FlowRecord | undefined {
    const current = this.get(flowId);
    if (current?.definitionRevision === definitionRevision) return current;
    const row = this.database.prepare(`
      SELECT * FROM flow_history
      WHERE flow_id = ? AND definition_revision = ?
      ORDER BY id DESC LIMIT 1
    `).get(flowId, definitionRevision) as Row | undefined;
    return row ? toHistoryEntry(row).snapshot : undefined;
  }

  listLineage(lineageRootFlowId: string): FlowRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM flows
      WHERE COALESCE(lineage_root_flow_id, flow_id) = ?
      ORDER BY publication_sequence ASC, updated_at ASC, flow_id ASC
    `).all(lineageRootFlowId) as Row[];
    return rows.map(toFlow);
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
    description: row.description === null || row.description === undefined ? null : String(row.description),
    kind: String(row.kind) as FlowKind,
    status: String(row.status) as FlowStatus,
    source: String(row.source) as FlowSource,
    definitionRevision: String(row.definition_revision),
    planIrHash: row.plan_ir_hash === null || row.plan_ir_hash === undefined ? null : String(row.plan_ir_hash),
    inputs: JSON.parse(String(row.inputs ?? "[]")) as FlowInput[],
    reviewStatus: String(row.review_status ?? "pending") as FlowReviewStatus,
    gitRevision: row.git_revision === null || row.git_revision === undefined ? null : String(row.git_revision),
    validationIssues: JSON.parse(String(row.validation_issues ?? "[]")) as string[],
    steps: JSON.parse(String(row.steps)) as FlowStep[],
    lineageRootFlowId: row.lineage_root_flow_id === null || row.lineage_root_flow_id === undefined
      ? String(row.flow_id)
      : String(row.lineage_root_flow_id),
    parentFlowId: row.parent_flow_id === null || row.parent_flow_id === undefined ? null : String(row.parent_flow_id),
    provenance: row.provenance === null || row.provenance === undefined
      ? null
      : JSON.parse(String(row.provenance)) as FlowProvenance,
    publicationSequence: row.publication_sequence === null || row.publication_sequence === undefined
      ? String(row.status) === "published" ? 1 : 0
      : Number(row.publication_sequence) || (String(row.status) === "published" ? 1 : 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toHistoryEntry(row: Row): FlowHistoryEntry {
  return {
    id: Number(row.id),
    flowId: String(row.flow_id),
    definitionRevision: String(row.definition_revision),
    action: String(row.action) as FlowHistoryAction,
    snapshot: JSON.parse(String(row.snapshot)) as FlowRecord,
    createdAt: String(row.created_at),
  };
}

function historyAction(current: FlowRecord | undefined, next: FlowRecord): FlowHistoryAction {
  if (!current) return "created";
  if (next.status === "deprecated" && current.status !== "deprecated") return "deprecated";
  if (next.status === "published" && current.status !== "published") return "review_approved";
  if (next.reviewStatus === "rejected" && current.reviewStatus !== "rejected") return "review_rejected";
  return "definition_updated";
}

function flowFingerprint(flow: FlowRecord): string {
  return JSON.stringify({
    flowId: flow.flowId,
    name: flow.name,
    description: flow.description,
    kind: flow.kind,
    status: flow.status,
    source: flow.source,
    definitionRevision: flow.definitionRevision,
    planIrHash: flow.planIrHash,
    inputs: flow.inputs,
    reviewStatus: flow.reviewStatus,
    gitRevision: flow.gitRevision,
    validationIssues: flow.validationIssues,
    steps: flow.steps,
    lineageRootFlowId: flow.lineageRootFlowId,
    parentFlowId: flow.parentFlowId,
    provenance: flow.provenance,
    publicationSequence: flow.publicationSequence,
  });
}
