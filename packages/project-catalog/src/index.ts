import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { SqliteEventStore } from "@codebridge/work-items";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

export type CandidateStatus = "candidate" | "accepted" | "rejected";
export type ProjectStatus = "registered" | "deprecated";
export type DiscoveryConfidence = "low" | "medium" | "high";

export interface ProjectEvidence {
  kind: string;
  ref: string;
  value?: string;
}

export interface ProjectCandidateInput {
  projectId: string;
  displayName?: string;
  repositoryRemote?: string;
  language?: string;
  deployService?: string;
  logService?: string;
  apmService?: string;
  confidence: DiscoveryConfidence;
  evidence: ProjectEvidence[];
}

export interface ProjectCandidate extends ProjectCandidateInput {
  id: string;
  status: CandidateStatus;
  observedAt: string;
}

export interface ProjectRecord extends ProjectCandidateInput {
  id: string;
  status: ProjectStatus;
  registeredAt: string;
}

export interface DiscoveryObservation {
  remote?: string;
  language?: string;
  evidence: ProjectEvidence[];
}

export type DiscoveryEvidenceReader = (
  workspacePath: string,
) => Promise<DiscoveryObservation> | DiscoveryObservation;

export class ProjectCatalogStore {
  private readonly database: DatabaseSyncType;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS project_candidates (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL UNIQUE,
        display_name TEXT,
        repository_remote TEXT,
        language TEXT,
        deploy_service TEXT,
        log_service TEXT,
        apm_service TEXT,
        confidence TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        repository_remote TEXT,
        language TEXT,
        deploy_service TEXT,
        log_service TEXT,
        apm_service TEXT,
        confidence TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence TEXT NOT NULL,
        registered_at TEXT NOT NULL
      );
    `);
  }

  saveCandidate(input: ProjectCandidateInput): ProjectCandidate {
    const existing = this.getCandidateByProjectId(input.projectId);
    if (existing) {
      const evidence = mergeEvidence(existing.evidence, input.evidence);
      // A registered candidate is immutable until a human edits the catalog.
      if (existing.status === "candidate") {
        this.database
          .prepare(
            `UPDATE project_candidates
             SET display_name = COALESCE(display_name, ?),
                 repository_remote = COALESCE(repository_remote, ?),
                 language = COALESCE(language, ?),
                 confidence = ?, evidence = ?, observed_at = ?
             WHERE id = ?`,
          )
          .run(
            input.displayName ?? null,
            input.repositoryRemote ?? null,
            input.language ?? null,
            maxConfidence(existing.confidence, input.confidence),
            JSON.stringify(evidence),
            new Date().toISOString(),
            existing.id,
          );
      }
      return this.getCandidate(existing.id)!;
    }

    const candidate: ProjectCandidate = {
      ...input,
      id: `pc_${randomUUID().replaceAll("-", "")}`,
      status: "candidate",
      observedAt: new Date().toISOString(),
      evidence: [...input.evidence],
    };
    this.database
      .prepare(
        `INSERT INTO project_candidates (
          id, project_id, display_name, repository_remote, language,
          deploy_service, log_service, apm_service, confidence, status,
          evidence, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.id,
        candidate.projectId,
        candidate.displayName ?? null,
        candidate.repositoryRemote ?? null,
        candidate.language ?? null,
        candidate.deployService ?? null,
        candidate.logService ?? null,
        candidate.apmService ?? null,
        candidate.confidence,
        candidate.status,
        JSON.stringify(candidate.evidence),
        candidate.observedAt,
      );
    return candidate;
  }

  listCandidates(): ProjectCandidate[] {
    return (this.database.prepare("SELECT * FROM project_candidates ORDER BY observed_at DESC").all() as Record<string, unknown>[]).map(toCandidate);
  }

  getCandidate(id: string): ProjectCandidate | undefined {
    const row = this.database.prepare("SELECT * FROM project_candidates WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toCandidate(row) : undefined;
  }

  getCandidateByProjectId(projectId: string): ProjectCandidate | undefined {
    const row = this.database.prepare("SELECT * FROM project_candidates WHERE project_id = ?").get(projectId) as Record<string, unknown> | undefined;
    return row ? toCandidate(row) : undefined;
  }

  acceptCandidate(id: string): ProjectRecord {
    const candidate = this.getCandidate(id);
    if (!candidate) throw new Error(`Project candidate not found: ${id}`);
    const existing = this.getProject(candidate.projectId);
    if (!existing) {
      const registeredAt = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO projects (
            id, display_name, repository_remote, language, deploy_service,
            log_service, apm_service, confidence, status, evidence, registered_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          candidate.projectId,
          candidate.displayName ?? null,
          candidate.repositoryRemote ?? null,
          candidate.language ?? null,
          candidate.deployService ?? null,
          candidate.logService ?? null,
          candidate.apmService ?? null,
          candidate.confidence,
          "registered",
          JSON.stringify(candidate.evidence),
          registeredAt,
        );
    }
    this.database.prepare("UPDATE project_candidates SET status = 'accepted' WHERE id = ?").run(id);
    return this.getProject(candidate.projectId)!;
  }

  getProject(id: string): ProjectRecord | undefined {
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toProject(row) : undefined;
  }

  listProjects(): ProjectRecord[] {
    return (this.database.prepare("SELECT * FROM projects ORDER BY id ASC").all() as Record<string, unknown>[]).map(toProject);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

export interface ProjectDiscoveryOptions {
  reader?: DiscoveryEvidenceReader;
  events?: SqliteEventStore;
}

export class ProjectDiscovery {
  private readonly reader: DiscoveryEvidenceReader;

  constructor(
    private readonly catalog: ProjectCatalogStore,
    private readonly options: ProjectDiscoveryOptions = {},
  ) {
    this.reader = options.reader ?? readWorkspaceEvidence;
  }

  async observe(workspacePath: string, workItemId?: string): Promise<ProjectCandidate> {
    const observation = await this.reader(workspacePath);
    const remote = normalizeRemote(observation.remote);
    const projectId = projectIdFromRemote(remote) ?? path.basename(workspacePath);
    if (!projectId) throw new Error(`Unable to identify project from ${workspacePath}`);
    const candidate = this.catalog.saveCandidate({
      projectId,
      displayName: projectId,
      repositoryRemote: remote,
      language: observation.language,
      confidence: remote ? "high" : "medium",
      evidence: [
        { kind: "workspace_path", ref: workspacePath },
        ...observation.evidence,
      ],
    });
    if (workItemId && this.options.events) {
      this.options.events.appendEvent({
        workItemId,
        type: "PROJECT_CANDIDATE_FOUND",
        actor: "system",
        target: candidate.projectId,
        payload: {
          candidate_id: candidate.id,
          project_id: candidate.projectId,
          confidence: candidate.confidence,
          evidence: candidate.evidence,
        },
      });
    }
    return candidate;
  }

  close(): void {
    this.catalog.close();
  }
}

async function readWorkspaceEvidence(workspacePath: string): Promise<DiscoveryObservation> {
  const evidence: ProjectEvidence[] = [{ kind: "workspace_path", ref: workspacePath }];
  let remote: string | undefined;
  try {
    remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: workspacePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // A workspace may not be a Git checkout yet; it remains a medium-confidence candidate.
  }
  if (remote) evidence.push({ kind: "git_remote", ref: "git config remote.origin.url", value: remote });
  let language: string | undefined;
  if (fs.existsSync(path.join(workspacePath, "go.mod"))) language = "go";
  else if (fs.existsSync(path.join(workspacePath, "pyproject.toml")) || fs.existsSync(path.join(workspacePath, "requirements.txt"))) language = "python";
  else if (fs.existsSync(path.join(workspacePath, "package.json"))) language = "node";
  if (language) evidence.push({ kind: "manifest", ref: language });
  return { remote, language, evidence };
}

function normalizeRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  return remote.trim().replace(/^https?:\/\//, "").replace(/^git@/, "").replace(":", "/").replace(/\.git$/, "");
}

function projectIdFromRemote(remote: string | undefined): string | undefined {
  const value = remote?.split("/").filter(Boolean).at(-1);
  return value?.trim() || undefined;
}

function mergeEvidence(existing: ProjectEvidence[], incoming: ProjectEvidence[]): ProjectEvidence[] {
  const seen = new Set(existing.map((entry) => `${entry.kind}:${entry.ref}:${entry.value ?? ""}`));
  return [...existing, ...incoming.filter((entry) => !seen.has(`${entry.kind}:${entry.ref}:${entry.value ?? ""}`))];
}

function maxConfidence(a: DiscoveryConfidence, b: DiscoveryConfidence): DiscoveryConfidence {
  const rank: Record<DiscoveryConfidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function toCandidate(row: Record<string, unknown>): ProjectCandidate {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    displayName: optionalString(row.display_name),
    repositoryRemote: optionalString(row.repository_remote),
    language: optionalString(row.language),
    deployService: optionalString(row.deploy_service),
    logService: optionalString(row.log_service),
    apmService: optionalString(row.apm_service),
    confidence: String(row.confidence) as DiscoveryConfidence,
    status: String(row.status) as CandidateStatus,
    evidence: JSON.parse(String(row.evidence)) as ProjectEvidence[],
    observedAt: String(row.observed_at),
  };
}

function toProject(row: Record<string, unknown>): ProjectRecord {
  return {
    ...toCandidate({ ...row, id: row.id, status: row.status }),
    id: String(row.id),
    status: String(row.status) as ProjectStatus,
    registeredAt: String(row.registered_at),
  };
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}
