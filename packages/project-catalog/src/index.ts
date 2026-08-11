import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { SqliteEventStore } from "@codebridge/work-items";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

export type CandidateStatus = "candidate" | "accepted" | "rejected";
export type ProjectStatus = "registered" | "deprecated";
export type DiscoveryConfidence = "low" | "medium" | "high";
export type DiscoveryTaskStatus = "queued" | "running" | "succeeded" | "failed";
export type ProjectDriftStatus = "open" | "resolved";

export interface DiscoveryTask {
  id: string;
  status: DiscoveryTaskStatus;
  workspacePath: string;
  workItemId: string | null;
  candidateId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDiscoveryTaskInput {
  id?: string;
  workspacePath: string;
  workItemId?: string | null;
}

export interface UpdateDiscoveryTaskInput {
  status?: DiscoveryTaskStatus;
  candidateId?: string | null;
  error?: string | null;
}

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
  dependencies?: string[];
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

export interface ProjectCatalogGitOptions {
  repositoryPath: string;
  baseRef: string;
  catalogPath?: string;
}

export interface CreateProjectCatalogProposalInput {
  branch: string;
  message?: string;
}

export interface ProjectCatalogProposal {
  branch: string;
  baseRef: string;
  baseCommit: string;
  commit: string;
  path: string;
}

export interface ProjectFieldDrift {
  field: "repositoryRemote" | "language" | "deployService" | "logService" | "apmService" | "dependencies";
  registered: string | string[] | null;
  observed: string | string[] | null;
}

export interface ProjectDrift {
  id: string;
  projectId: string;
  candidateId: string;
  changes: ProjectFieldDrift[];
  evidence: ProjectEvidence[];
  status: ProjectDriftStatus;
  observedAt: string;
  resolvedAt: string | null;
}

export interface DiscoveryObservation {
  remote?: string;
  language?: string;
  deployService?: string;
  logService?: string;
  apmService?: string;
  dependencies?: string[];
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
        dependencies TEXT NOT NULL DEFAULT '[]',
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
        dependencies TEXT NOT NULL DEFAULT '[]',
        registered_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_drifts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        changes TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS project_drifts_project_status
        ON project_drifts (project_id, status, observed_at);
      CREATE TABLE IF NOT EXISTS discovery_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        work_item_id TEXT,
        candidate_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    for (const statement of [
      "ALTER TABLE project_candidates ADD COLUMN dependencies TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE projects ADD COLUMN dependencies TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE project_drifts ADD COLUMN evidence TEXT NOT NULL DEFAULT '[]'",
    ]) {
      try { this.database.exec(statement); } catch { /* Existing databases already contain the column. */ }
    }
    this.database
      .prepare("UPDATE discovery_tasks SET status = 'queued', updated_at = ? WHERE status = 'running'")
      .run(new Date().toISOString());
  }

  saveCandidate(input: ProjectCandidateInput): ProjectCandidate {
    const existing = this.getCandidateByProjectId(input.projectId);
    if (existing) {
      const evidence = mergeEvidence(existing.evidence, input.evidence);
      this.recordDrift(existing.id, input);
      // A registered candidate is immutable until a human edits the catalog.
      if (existing.status === "candidate") {
        this.database
          .prepare(
            `UPDATE project_candidates
             SET display_name = COALESCE(?, display_name),
                 repository_remote = COALESCE(?, repository_remote),
                 language = COALESCE(?, language),
                 deploy_service = COALESCE(?, deploy_service),
                 log_service = COALESCE(?, log_service),
                 apm_service = COALESCE(?, apm_service),
                 dependencies = CASE WHEN ? IS NULL THEN dependencies ELSE ? END,
                 confidence = ?, evidence = ?, observed_at = ?
             WHERE id = ?`,
          )
          .run(
            input.displayName ?? null,
            input.repositoryRemote ?? null,
            input.language ?? null,
            input.deployService ?? null,
            input.logService ?? null,
            input.apmService ?? null,
            input.dependencies ? JSON.stringify(input.dependencies) : null,
            input.dependencies ? JSON.stringify(input.dependencies) : null,
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
          evidence, dependencies, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(candidate.dependencies ?? []),
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
            log_service, apm_service, confidence, status, evidence, dependencies, registered_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify(candidate.dependencies ?? []),
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

  projectsForCandidate(id: string): ProjectRecord[] {
    const candidate = this.getCandidate(id);
    if (!candidate) throw new Error(`Project candidate not found: ${id}`);
    const existing = this.getProject(candidate.projectId);
    const openDrift = this.listDrifts(candidate.projectId)[0];
    const proposed = openDrift ? applyDriftValues(candidate, openDrift.changes) : candidate;
    const project: ProjectRecord = {
      ...proposed,
      id: candidate.projectId,
      status: "registered",
      registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    };
    return [...this.listProjects().filter((item) => item.id !== project.id), project]
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  syncProjects(projects: ProjectRecord[], revision: string): ProjectRecord[] {
    const ids = new Set(projects.map((project) => project.id));
    if (ids.size !== projects.length) throw new Error("Project catalog contains duplicate project_id values");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE projects SET status = 'deprecated'").run();
      for (const project of projects) {
        const existing = this.getProject(project.id);
        const evidence = mergeEvidence(project.evidence, [{ kind: "git_catalog", ref: revision }]);
        this.database.prepare(
          `INSERT INTO projects (
            id, display_name, repository_remote, language, deploy_service,
            log_service, apm_service, confidence, status, evidence, dependencies, registered_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
            repository_remote = excluded.repository_remote, language = excluded.language,
            deploy_service = excluded.deploy_service, log_service = excluded.log_service,
            apm_service = excluded.apm_service, confidence = excluded.confidence,
            status = 'registered', evidence = excluded.evidence,
            dependencies = excluded.dependencies`,
        ).run(
          project.id,
          project.displayName ?? null,
          project.repositoryRemote ?? null,
          project.language ?? null,
          project.deployService ?? null,
          project.logService ?? null,
          project.apmService ?? null,
          project.confidence,
          JSON.stringify(evidence),
          JSON.stringify(project.dependencies ?? []),
          existing?.registeredAt ?? project.registeredAt,
        );
        this.database.prepare("UPDATE project_candidates SET status = 'accepted' WHERE project_id = ?").run(project.id);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.listProjects();
  }

  listDrifts(projectId?: string, status: ProjectDriftStatus = "open"): ProjectDrift[] {
    const rows = projectId
      ? this.database.prepare("SELECT * FROM project_drifts WHERE project_id = ? AND status = ? ORDER BY observed_at DESC").all(projectId, status)
      : this.database.prepare("SELECT * FROM project_drifts WHERE status = ? ORDER BY observed_at DESC").all(status);
    return (rows as Record<string, unknown>[]).map(toDrift);
  }

  resolveDrift(id: string): ProjectDrift | undefined {
    const row = this.database.prepare("SELECT * FROM project_drifts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    this.database
      .prepare("UPDATE project_drifts SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'open'")
      .run(new Date().toISOString(), id);
    return toDrift(this.database.prepare("SELECT * FROM project_drifts WHERE id = ?").get(id) as Record<string, unknown>);
  }

  applyDrift(id: string): ProjectRecord | undefined {
    const drift = this.listDrifts(undefined, "open").find((item) => item.id === id);
    if (!drift) return undefined;
    const project = this.getProject(drift.projectId);
    if (!project) return undefined;
    const next = { ...project };
    for (const change of drift.changes) {
      (next as unknown as Record<string, unknown>)[change.field] = change.observed;
    }
    this.database
      .prepare(
        `UPDATE projects SET repository_remote = ?, language = ?, deploy_service = ?,
         log_service = ?, apm_service = ?, dependencies = ?, evidence = ? WHERE id = ?`,
      )
      .run(
        next.repositoryRemote ?? null,
        next.language ?? null,
        next.deployService ?? null,
        next.logService ?? null,
        next.apmService ?? null,
        JSON.stringify(next.dependencies ?? []),
        JSON.stringify(mergeEvidence(project.evidence, [{ kind: "drift_applied", ref: drift.id }])),
        project.id,
      );
    this.database
      .prepare("UPDATE project_candidates SET repository_remote = ?, language = ?, deploy_service = ?, log_service = ?, apm_service = ?, dependencies = ?, evidence = ? WHERE project_id = ?")
      .run(
        next.repositoryRemote ?? null,
        next.language ?? null,
        next.deployService ?? null,
        next.logService ?? null,
        next.apmService ?? null,
        JSON.stringify(next.dependencies ?? []),
        JSON.stringify(mergeEvidence(project.evidence, [{ kind: "drift_applied", ref: drift.id }])),
        project.id,
      );
    this.resolveDrift(id);
    return this.getProject(project.id);
  }

  previewCandidate(id: string): { path: string; before: string; after: string; unified: string } {
    const candidate = this.getCandidate(id);
    if (!candidate) throw new Error(`Project candidate not found: ${id}`);
    const existing = this.getProject(candidate.projectId);
    const before = existing ? renderProjectYaml(existing) : "";
    const openDrift = this.listDrifts(candidate.projectId)[0];
    const preview = openDrift
      ? applyDriftValues(candidate, openDrift.changes)
      : candidate;
    const after = renderProjectYaml({
      ...preview,
      id: candidate.projectId,
      status: "registered",
      registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    });
    return { path: "catalog/projects.yaml", before, after, unified: diffText(before, after) };
  }

  private recordDrift(candidateId: string, observed: ProjectCandidateInput): void {
    const registered = this.getProject(observed.projectId);
    if (!registered) return;
    const changes = projectDrift(registered, observed);
    if (!changes.length) return;
    const serialized = JSON.stringify(changes);
    const duplicate = this.database
      .prepare("SELECT id FROM project_drifts WHERE project_id = ? AND status = 'open' AND changes = ?")
      .get(observed.projectId, serialized);
    if (duplicate) return;
    this.database
      .prepare(
        "INSERT INTO project_drifts (id, project_id, candidate_id, changes, evidence, status, observed_at, resolved_at) VALUES (?, ?, ?, ?, ?, 'open', ?, NULL)",
      )
      .run(
        `pdr_${randomUUID().replaceAll("-", "")}`,
        observed.projectId,
        candidateId,
        serialized,
        JSON.stringify(observed.evidence),
        new Date().toISOString(),
      );
  }

  createDiscoveryTask(input: CreateDiscoveryTaskInput): DiscoveryTask {
    if (!input.workspacePath.trim()) throw new Error("workspace path must not be empty");
    const now = new Date().toISOString();
    const task: DiscoveryTask = {
      id: input.id ?? `dst_${randomUUID().replaceAll("-", "")}`,
      status: "queued",
      workspacePath: input.workspacePath,
      workItemId: input.workItemId ?? null,
      candidateId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.database
      .prepare(
        `INSERT INTO discovery_tasks (
          id, status, workspace_path, work_item_id, candidate_id, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(task.id, task.status, task.workspacePath, task.workItemId, task.candidateId, task.error, task.createdAt, task.updatedAt);
    return task;
  }

  getDiscoveryTask(id: string): DiscoveryTask | undefined {
    const row = this.database.prepare("SELECT * FROM discovery_tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toDiscoveryTask(row) : undefined;
  }

  listDiscoveryTasks(statuses?: DiscoveryTaskStatus[]): DiscoveryTask[] {
    const rows = statuses?.length
      ? this.database
          .prepare(`SELECT * FROM discovery_tasks WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY created_at ASC`)
          .all(...statuses)
      : this.database.prepare("SELECT * FROM discovery_tasks ORDER BY created_at DESC").all();
    return (rows as Record<string, unknown>[]).map(toDiscoveryTask);
  }

  updateDiscoveryTask(id: string, input: UpdateDiscoveryTaskInput): DiscoveryTask {
    const current = this.getDiscoveryTask(id);
    if (!current) throw new Error(`Discovery task not found: ${id}`);
    const next: DiscoveryTask = {
      ...current,
      status: input.status ?? current.status,
      candidateId: input.candidateId === undefined ? current.candidateId : input.candidateId,
      error: input.error === undefined ? current.error : input.error,
      updatedAt: new Date().toISOString(),
    };
    this.database
      .prepare("UPDATE discovery_tasks SET status = ?, candidate_id = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(next.status, next.candidateId, next.error, next.updatedAt, id);
    return next;
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

export class ProjectCatalogGitRepository {
  private readonly repositoryPath: string;
  private readonly catalogPath: string;

  constructor(private readonly options: ProjectCatalogGitOptions) {
    this.repositoryPath = path.resolve(options.repositoryPath);
    this.catalogPath = normalizeCatalogPath(options.catalogPath ?? "catalog/projects.yaml");
    if (!options.baseRef.trim()) throw new Error("Project catalog baseRef must not be empty");
    runGit(this.repositoryPath, ["rev-parse", "--git-dir"]);
  }

  get baseRef(): string {
    return this.options.baseRef;
  }

  createProposal(
    projects: ProjectRecord[],
    input: CreateProjectCatalogProposalInput,
  ): ProjectCatalogProposal {
    const branch = input.branch.trim();
    if (!branch) throw new Error("Project catalog proposal branch must not be empty");
    runGit(this.repositoryPath, ["check-ref-format", "--branch", branch]);
    const branchRef = `refs/heads/${branch}`;
    if (gitRefExists(this.repositoryPath, branchRef)) {
      throw new Error(`Project catalog proposal branch already exists: ${branch}`);
    }
    const baseCommit = runGit(this.repositoryPath, ["rev-parse", "--verify", `${this.options.baseRef}^{commit}`]);
    const content = renderProjectsYaml(projects);
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-catalog-index-"));
    const indexPath = path.join(temporaryDirectory, "index");
    const environment = { GIT_INDEX_FILE: indexPath };
    try {
      runGit(this.repositoryPath, ["read-tree", baseCommit], { environment });
      const blob = runGit(this.repositoryPath, ["hash-object", "-w", "--stdin"], { input: content });
      runGit(this.repositoryPath, ["update-index", "--add", "--cacheinfo", "100644", blob, this.catalogPath], { environment });
      const tree = runGit(this.repositoryPath, ["write-tree"], { environment });
      const commit = runGit(this.repositoryPath, [
        "commit-tree",
        tree,
        "-p",
        baseCommit,
        "-m",
        input.message?.trim() || `catalog: update ${this.catalogPath}`,
      ]);
      runGit(this.repositoryPath, ["update-ref", branchRef, commit, "0000000000000000000000000000000000000000"]);
      return { branch, baseRef: this.options.baseRef, baseCommit, commit, path: this.catalogPath };
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }

  readProjects(ref = this.options.baseRef): ProjectRecord[] {
    const revision = runGit(this.repositoryPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
    const source = runGit(this.repositoryPath, ["show", `${revision}:${this.catalogPath}`], { trim: false });
    return parseProjectsYaml(source, revision);
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
      deployService: observation.deployService,
      logService: observation.logService,
      apmService: observation.apmService,
      dependencies: observation.dependencies,
      confidence: remote ? "high" : "medium",
      evidence: [
        { kind: "workspace_path", ref: workspacePath },
        ...observation.evidence,
      ],
    });
    if (workItemId && this.options.events) {
      const drifts = this.catalog.listDrifts(candidate.projectId);
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
          drifts: drifts.map((drift) => ({ drift_id: drift.id, changes: drift.changes })),
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
  return { remote, language, ...readProjectMetadata(workspacePath, evidence), evidence };
}

function readProjectMetadata(
  workspacePath: string,
  evidence: ProjectEvidence[],
): Pick<DiscoveryObservation, "deployService" | "logService" | "apmService" | "dependencies"> {
  for (const file of [".codebridge/project.json", "codebridge.project.json"]) {
    const metadataPath = path.join(workspacePath, file);
    if (!fs.existsSync(metadataPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
      const value = (snakeCase: string, camelCase: string) => {
        const candidate = parsed[snakeCase] ?? parsed[camelCase];
        return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
      };
      const dependencies = Array.isArray(parsed.dependencies)
        ? parsed.dependencies.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
        : undefined;
      evidence.push({ kind: "project_metadata", ref: file });
      return {
        deployService: value("deploy_service", "deployService"),
        logService: value("log_service", "logService"),
        apmService: value("apm_service", "apmService"),
        dependencies,
      };
    } catch {
      evidence.push({ kind: "project_metadata_invalid", ref: file });
    }
  }
  return {};
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
    dependencies: row.dependencies ? JSON.parse(String(row.dependencies)) as string[] : [],
    confidence: String(row.confidence) as DiscoveryConfidence,
    status: String(row.status) as CandidateStatus,
    evidence: JSON.parse(String(row.evidence)) as ProjectEvidence[],
    observedAt: String(row.observed_at),
  };
}

function toDrift(row: Record<string, unknown>): ProjectDrift {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    candidateId: String(row.candidate_id),
    changes: JSON.parse(String(row.changes)) as ProjectFieldDrift[],
    evidence: JSON.parse(String(row.evidence)) as ProjectEvidence[],
    status: String(row.status) as ProjectDriftStatus,
    observedAt: String(row.observed_at),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
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

function toDiscoveryTask(row: Record<string, unknown>): DiscoveryTask {
  return {
    id: String(row.id),
    status: String(row.status) as DiscoveryTaskStatus,
    workspacePath: String(row.workspace_path),
    workItemId: row.work_item_id === null ? null : String(row.work_item_id),
    candidateId: row.candidate_id === null ? null : String(row.candidate_id),
    error: row.error === null ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function projectDrift(registered: ProjectRecord, observed: ProjectCandidateInput): ProjectFieldDrift[] {
  const fields: Array<ProjectFieldDrift["field"]> = [
    "repositoryRemote",
    "language",
    "deployService",
    "logService",
    "apmService",
    "dependencies",
  ];
  return fields.flatMap((field) => {
    const actual = observed[field];
    if (actual === undefined) return [];
    const current = registered[field] ?? null;
    if (JSON.stringify(current) === JSON.stringify(actual)) return [];
    return [{ field, registered: current, observed: actual }];
  });
}

function applyDriftValues<T extends ProjectCandidateInput>(value: T, changes: ProjectFieldDrift[]): T {
  const next = { ...value };
  const writable = next as Record<string, unknown>;
  for (const change of changes) writable[change.field] = change.observed;
  return next;
}

function renderProjectYaml(project: ProjectRecord): string {
  return [
    "projects:",
    `  - project_id: ${yamlString(project.id)}`,
    `    repository_remote: ${yamlString(project.repositoryRemote)}`,
    `    language: ${yamlString(project.language)}`,
    `    deploy_service: ${yamlString(project.deployService)}`,
    `    log_service: ${yamlString(project.logService)}`,
    `    apm_service: ${yamlString(project.apmService)}`,
    `    dependencies: [${(project.dependencies ?? []).map(yamlString).join(", ")}]`,
    "",
  ].join("\n");
}

export function renderProjectsYaml(projects: ProjectRecord[]): string {
  const lines = ["schema_version: 1", "projects:"];
  for (const project of [...projects].sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(
      `  - project_id: ${yamlString(project.id)}`,
      `    display_name: ${yamlString(project.displayName)}`,
      `    repository_remote: ${yamlString(project.repositoryRemote)}`,
      `    language: ${yamlString(project.language)}`,
      `    deploy_service: ${yamlString(project.deployService)}`,
      `    log_service: ${yamlString(project.logService)}`,
      `    apm_service: ${yamlString(project.apmService)}`,
      `    dependencies: [${[...(project.dependencies ?? [])].sort().map(yamlString).join(", ")}]`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseProjectsYaml(source: string, revision: string): ProjectRecord[] {
  const parsed = parseYaml(source) as unknown;
  if (!isRecord(parsed) || parsed.schema_version !== 1 || !Array.isArray(parsed.projects)) {
    throw new Error("Project catalog must contain schema_version: 1 and a projects array");
  }
  const seen = new Set<string>();
  return parsed.projects.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Project catalog entry ${index} must be an object`);
    const id = requiredCatalogString(entry.project_id, `projects[${index}].project_id`);
    if (seen.has(id)) throw new Error(`Project catalog contains duplicate project_id: ${id}`);
    seen.add(id);
    const dependencies = entry.dependencies === undefined
      ? []
      : Array.isArray(entry.dependencies)
        ? entry.dependencies.map((value, dependencyIndex) => requiredCatalogString(value, `projects[${index}].dependencies[${dependencyIndex}]`))
        : (() => { throw new Error(`projects[${index}].dependencies must be an array`); })();
    return {
      id,
      projectId: id,
      displayName: optionalCatalogString(entry.display_name, `projects[${index}].display_name`),
      repositoryRemote: optionalCatalogString(entry.repository_remote, `projects[${index}].repository_remote`),
      language: optionalCatalogString(entry.language, `projects[${index}].language`),
      deployService: optionalCatalogString(entry.deploy_service, `projects[${index}].deploy_service`),
      logService: optionalCatalogString(entry.log_service, `projects[${index}].log_service`),
      apmService: optionalCatalogString(entry.apm_service, `projects[${index}].apm_service`),
      dependencies,
      confidence: "high" as const,
      evidence: [{ kind: "git_catalog", ref: revision }],
      status: "registered" as const,
      registeredAt: new Date().toISOString(),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function yamlString(value: string | null | undefined): string {
  return value ? JSON.stringify(value) : "null";
}

function diffText(before: string, after: string): string {
  const oldLines = before ? before.trimEnd().split("\n") : [];
  const newLines = after.trimEnd().split("\n");
  return [
    "--- catalog/projects.yaml",
    "+++ catalog/projects.yaml",
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function normalizeCatalogPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error("Project catalog path must be a relative path inside the repository");
  }
  return normalized;
}

function runGit(
  repositoryPath: string,
  args: string[],
  options: { input?: string; environment?: Record<string, string>; trim?: boolean } = {},
): string {
  try {
    const output = execFileSync("git", args, {
      cwd: repositoryPath,
      encoding: "utf8",
      input: options.input,
      env: { ...process.env, ...options.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return options.trim === false ? output : output.trim();
  } catch (error) {
    const stderr = isRecord(error) && typeof error.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(`Git command failed: git ${args.join(" ")}${stderr ? `: ${stderr}` : ""}`);
  }
}

function gitRefExists(repositoryPath: string, ref: string): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", ref], {
      cwd: repositoryPath,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredCatalogString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalCatalogString(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredCatalogString(value, field);
}
