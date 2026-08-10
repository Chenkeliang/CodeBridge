import { Hono } from "hono";
import type {
  DiscoveryTask,
  ProjectCatalogStore,
  ProjectDiscovery,
} from "@codebridge/project-catalog";

export function createProjectCatalogApp(
  catalog: ProjectCatalogStore,
  discovery: ProjectDiscovery,
  token: string,
) {
  const app = new Hono();

  app.use("/v1/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) {
      return c.json({ error: { code: "unauthorized", message: "未授权" } }, 401);
    }
    await next();
  });

  app.get("/v1/projects/candidates", (c) => c.json({ candidates: catalog.listCandidates().map(toApiCandidate) }));
  app.get("/v1/projects", (c) => c.json({ projects: catalog.listProjects().map(toApiProject) }));
  app.get("/v1/projects/drifts", (c) => {
    const projectId = c.req.query("project_id");
    return c.json({ drifts: catalog.listDrifts(projectId || undefined) });
  });

  app.get("/v1/projects/candidates/:candidate_id/diff", (c) => {
    try {
      return c.json(catalog.previewCandidate(c.req.param("candidate_id")));
    } catch (error) {
      return c.json({ error: { code: "candidate_not_found", message: messageOf(error) } }, 404);
    }
  });

  app.post("/v1/projects/candidates/:candidate_id/accept", (c) => {
    try {
      return c.json(toApiProject(catalog.acceptCandidate(c.req.param("candidate_id"))), 201);
    } catch (error) {
      return c.json({ error: { code: "candidate_not_found", message: messageOf(error) } }, 404);
    }
  });

  app.post("/v1/projects/drifts/:drift_id/resolve", (c) => {
    const drift = catalog.resolveDrift(c.req.param("drift_id"));
    if (!drift) return c.json({ error: { code: "drift_not_found", message: "Project drift 不存在" } }, 404);
    return c.json({ drift });
  });

  app.post("/v1/projects/drifts/:drift_id/apply", (c) => {
    const project = catalog.applyDrift(c.req.param("drift_id"));
    if (!project) return c.json({ error: { code: "drift_not_found", message: "Project drift 不存在或已处理" } }, 404);
    return c.json({ project: toApiProject(project) });
  });

  app.post("/v1/discovery/tasks", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { workspace_path?: unknown; work_item_id?: unknown } | null;
    if (!body || typeof body.workspace_path !== "string" || !body.workspace_path.trim()) {
      return c.json({ error: { code: "invalid_discovery", message: "workspace_path 必填" } }, 400);
    }
    const task = catalog.createDiscoveryTask({
      workspacePath: body.workspace_path,
      workItemId: typeof body.work_item_id === "string" ? body.work_item_id : null,
    });
    launchTask(task);
    return c.json({ task_id: task.id, status: task.status }, 202);
  });

  app.get("/v1/discovery/tasks/:task_id", (c) => {
    const task = catalog.getDiscoveryTask(c.req.param("task_id"));
    if (!task) return c.json({ error: { code: "task_not_found", message: "Discovery task 不存在" } }, 404);
    return c.json(toApiTask(task));
  });

  for (const task of catalog.listDiscoveryTasks(["queued", "running"])) launchTask(task);

  return app;

  function launchTask(task: DiscoveryTask): void {
    catalog.updateDiscoveryTask(task.id, { status: "running", error: null });
    void (async () => {
      try {
        const candidate = await discovery.observe(task.workspacePath, task.workItemId ?? undefined);
        catalog.updateDiscoveryTask(task.id, { status: "succeeded", candidateId: candidate.id, error: null });
      } catch (error) {
        catalog.updateDiscoveryTask(task.id, { status: "failed", error: messageOf(error) });
      }
    })();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toApiCandidate(candidate: ReturnType<ProjectCatalogStore["listCandidates"]>[number]) {
  return {
    id: candidate.id,
    project_id: candidate.projectId,
    display_name: candidate.displayName,
    repository_remote: candidate.repositoryRemote,
    language: candidate.language,
    deploy_service: candidate.deployService,
    log_service: candidate.logService,
    apm_service: candidate.apmService,
    dependencies: candidate.dependencies ?? [],
    confidence: candidate.confidence,
    status: candidate.status,
    evidence: candidate.evidence,
    observed_at: candidate.observedAt,
  };
}

function toApiTask(task: DiscoveryTask) {
  return {
    task_id: task.id,
    status: task.status,
    workspace_path: task.workspacePath,
    work_item_id: task.workItemId,
    candidate_id: task.candidateId,
    error: task.error,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

function toApiProject(project: ReturnType<ProjectCatalogStore["listProjects"]>[number]) {
  return {
    id: project.id,
    project_id: project.id,
    display_name: project.displayName,
    repository_remote: project.repositoryRemote,
    language: project.language,
    deploy_service: project.deployService,
    log_service: project.logService,
    apm_service: project.apmService,
    dependencies: project.dependencies ?? [],
    confidence: project.confidence,
    status: project.status,
    evidence: project.evidence,
    registered_at: project.registeredAt,
  };
}
