import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "@codebridge/work-items";
import {
  ProjectCatalogStore,
  ProjectDiscovery,
  type DiscoveryEvidenceReader,
} from "./index.js";

const evidenceReader: DiscoveryEvidenceReader = async () => ({
  remote: "gitlab.luojilab.com/rock/equity-center.git",
  language: "go",
  evidence: [{ kind: "git_remote", ref: "git config remote.origin.url" }],
});

describe("project catalog discovery", () => {
  it("deduplicates observations and keeps evidence before registration", async () => {
    const catalog = new ProjectCatalogStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    const item = events.createWorkItem({
      title: "discover",
      mode: "investigation",
      conversationId: "web:discover",
      riskLevel: "read_only",
    });
    const discovery = new ProjectDiscovery(catalog, { reader: evidenceReader, events });

    const first = await discovery.observe("/workspace/equity-center", item.id);
    const second = await discovery.observe("/workspace/equity-center", item.id);
    expect(first.id).toBe(second.id);
    expect(catalog.listCandidates()).toHaveLength(1);
    expect(catalog.getProject("equity-center")).toBeUndefined();
    expect(events.listEvents(item.id).at(-1)).toMatchObject({
      type: "PROJECT_CANDIDATE_FOUND",
      payload: { project_id: "equity-center" },
    });

    const accepted = catalog.acceptCandidate(first.id);
    expect(accepted).toMatchObject({ id: "equity-center", status: "registered" });
    expect(catalog.getProject("equity-center")?.repositoryRemote).toContain("equity-center");
    expect(catalog.listCandidates()[0]?.status).toBe("accepted");
    discovery.close();
    events.close();
  });

  it("does not overwrite a registered project when a later candidate differs", async () => {
    const catalog = new ProjectCatalogStore(":memory:");
    const first = catalog.saveCandidate({
      projectId: "equity-center",
      repositoryRemote: "gitlab/rock/equity-center",
      language: "go",
      deployService: "equity-center",
      dependencies: ["account-center"],
      confidence: "high",
      evidence: [{ kind: "git_remote", ref: "first" }],
    });
    catalog.acceptCandidate(first.id);
    const second = catalog.saveCandidate({
      projectId: "equity-center",
      repositoryRemote: "other/evil",
      language: "python",
      deployService: "other-service",
      dependencies: ["other-center"],
      confidence: "high",
      evidence: [{ kind: "git_remote", ref: "second" }],
    });
    expect(second.id).toBe(first.id);
    expect(catalog.getProject("equity-center")).toMatchObject({
      repositoryRemote: "gitlab/rock/equity-center",
      language: "go",
      deployService: "equity-center",
      dependencies: ["account-center"],
    });
    expect(catalog.listDrifts("equity-center")).toEqual([
      expect.objectContaining({
        projectId: "equity-center",
        status: "open",
        changes: expect.arrayContaining([
          { field: "repositoryRemote", registered: "gitlab/rock/equity-center", observed: "other/evil" },
          { field: "language", registered: "go", observed: "python" },
          { field: "deployService", registered: "equity-center", observed: "other-service" },
          { field: "dependencies", registered: ["account-center"], observed: ["other-center"] },
        ]),
      }),
    ]);
    const drift = catalog.listDrifts("equity-center")[0]!;
    expect(catalog.resolveDrift(drift.id)?.status).toBe("resolved");
    expect(catalog.listDrifts("equity-center")).toHaveLength(0);
    catalog.saveCandidate({
      projectId: "equity-center",
      repositoryRemote: "other/evil",
      language: "python",
      deployService: "other-service",
      dependencies: ["other-center"],
      confidence: "high",
      evidence: [{ kind: "git_remote", ref: "third" }],
    });
    expect(catalog.applyDrift(catalog.listDrifts("equity-center")[0]!.id)).toMatchObject({
      repositoryRemote: "other/evil",
      language: "python",
      deployService: "other-service",
      dependencies: ["other-center"],
    });
    catalog.close();
  });

  it("reads portable project metadata and previews a Git-reviewable catalog change", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-project-"));
    fs.mkdirSync(path.join(workspace, ".codebridge"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "go.mod"), "module example/project\n");
    fs.writeFileSync(path.join(workspace, ".codebridge/project.json"), JSON.stringify({
      deploy_service: "project-api",
      log_service: "project-api",
      apm_service: "project-api",
      dependencies: ["shared-api"],
    }));
    const catalog = new ProjectCatalogStore(":memory:");
    const discovery = new ProjectDiscovery(catalog);

    const candidate = await discovery.observe(workspace);
    expect(candidate).toMatchObject({
      language: "go",
      deployService: "project-api",
      logService: "project-api",
      apmService: "project-api",
      dependencies: ["shared-api"],
    });
    expect(catalog.previewCandidate(candidate.id)).toMatchObject({
      path: "catalog/projects.yaml",
      before: "",
    });
    expect(catalog.previewCandidate(candidate.id).unified).toContain("+    deploy_service: \"project-api\"");
    discovery.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("persists discovery tasks and keeps their state in the catalog", () => {
    const catalog = new ProjectCatalogStore(":memory:");
    const task = catalog.createDiscoveryTask({
      id: "dst_01JTEST",
      workspacePath: "/workspace/project",
      workItemId: "wi_01JTEST",
    });
    expect(task).toMatchObject({
      id: "dst_01JTEST",
      status: "queued",
      workspacePath: "/workspace/project",
      workItemId: "wi_01JTEST",
    });
    expect(catalog.updateDiscoveryTask(task.id, { status: "running" })).toMatchObject({ status: "running" });
    expect(catalog.updateDiscoveryTask(task.id, { status: "succeeded", candidateId: "pc_01JTEST" })).toMatchObject({
      status: "succeeded",
      candidateId: "pc_01JTEST",
    });
    expect(catalog.getDiscoveryTask(task.id)).toMatchObject({ candidateId: "pc_01JTEST" });
    expect(catalog.listDiscoveryTasks()).toHaveLength(1);
    catalog.close();
  });
});
