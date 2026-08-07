import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { ProjectCatalogStore, ProjectDiscovery } from "@codebridge/project-catalog";

type TaskStatus = "queued" | "running" | "succeeded" | "failed";
type Task = {
  id: string;
  status: TaskStatus;
  workspacePath: string;
  candidateId?: string;
  error?: string;
};

export function createProjectCatalogApp(
  catalog: ProjectCatalogStore,
  discovery: ProjectDiscovery,
  token: string,
) {
  const app = new Hono();
  const tasks = new Map<string, Task>();

  app.use("*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) {
      return c.json({ error: { code: "unauthorized", message: "未授权" } }, 401);
    }
    await next();
  });

  app.get("/v1/projects/candidates", (c) => c.json({ candidates: catalog.listCandidates() }));
  app.get("/v1/projects", (c) => c.json({ projects: catalog.listProjects() }));

  app.post("/v1/projects/candidates/:candidate_id/accept", (c) => {
    try {
      return c.json(catalog.acceptCandidate(c.req.param("candidate_id")), 201);
    } catch (error) {
      return c.json({ error: { code: "candidate_not_found", message: messageOf(error) } }, 404);
    }
  });

  app.post("/v1/discovery/tasks", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { workspace_path?: unknown } | null;
    if (!body || typeof body.workspace_path !== "string" || !body.workspace_path.trim()) {
      return c.json({ error: { code: "invalid_discovery", message: "workspace_path 必填" } }, 400);
    }
    const task: Task = {
      id: `dst_${randomUUID().replaceAll("-", "")}`,
      status: "queued",
      workspacePath: body.workspace_path,
    };
    tasks.set(task.id, task);
    void (async () => {
      task.status = "running";
      try {
        const candidate = await discovery.observe(task.workspacePath);
        task.status = "succeeded";
        task.candidateId = candidate.id;
      } catch (error) {
        task.status = "failed";
        task.error = messageOf(error);
      }
    })();
    return c.json({ task_id: task.id, status: task.status }, 202);
  });

  app.get("/v1/discovery/tasks/:task_id", (c) => {
    const task = tasks.get(c.req.param("task_id"));
    if (!task) return c.json({ error: { code: "task_not_found", message: "Discovery task 不存在" } }, 404);
    return c.json(task);
  });

  return app;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
