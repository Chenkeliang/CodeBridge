import { describe, expect, it } from "vitest";
import { ProjectCatalogStore, ProjectDiscovery } from "@codebridge/project-catalog";
import { createProjectCatalogApp } from "./project-api.js";

const TOKEN = "project-api-token";

function request(url: string, init: RequestInit = {}) {
  return new Request(`http://localhost${url}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

describe("project catalog API", () => {
  it("queues discovery, exposes the candidate, and accepts it explicitly", async () => {
    const catalog = new ProjectCatalogStore(":memory:");
    const discovery = new ProjectDiscovery(catalog, {
      reader: async () => ({
        remote: "gitlab.luojilab.com/rock/equity-center.git",
        language: "go",
        evidence: [{ kind: "git_remote", ref: "test" }],
      }),
    });
    const app = createProjectCatalogApp(catalog, discovery, TOKEN);
    const queued = await app.request(
      request("/v1/discovery/tasks", {
        method: "POST",
        body: JSON.stringify({ workspace_path: "/tmp/equity-center" }),
      }),
    );
    expect(queued.status).toBe(202);
    const task = (await queued.json()) as { task_id: string };

    let status: Response | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      status = await app.request(request(`/v1/discovery/tasks/${task.task_id}`));
      if ((await status.clone().json() as { status: string }).status !== "queued") break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(((await status!.json()) as { status: string }).status).toBe("succeeded");
    expect(catalog.getDiscoveryTask(task.task_id)).toMatchObject({ status: "succeeded" });
    const candidates = await app.request(request("/v1/projects/candidates"));
    const candidateList = (await candidates.json()) as { candidates: Array<{ id: string }> };
    expect(candidateList.candidates).toHaveLength(1);

    const accepted = await app.request(
      request(`/v1/projects/candidates/${candidateList.candidates[0]!.id}/accept`, { method: "POST" }),
    );
    expect(accepted.status).toBe(201);
    expect(((await accepted.json()) as { id: string }).id).toBe("equity-center");
    discovery.close();
  });

  it("resumes a durable discovery task when the API process starts", async () => {
    const catalog = new ProjectCatalogStore(":memory:");
    const task = catalog.createDiscoveryTask({ workspacePath: "/tmp/resume-project" });
    catalog.updateDiscoveryTask(task.id, { status: "running" });
    const discovery = new ProjectDiscovery(catalog, {
      reader: async () => ({ language: "node", evidence: [] }),
    });
    const app = createProjectCatalogApp(catalog, discovery, TOKEN);

    let body: { status: string; candidate_id?: string | null } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await app.request(request(`/v1/discovery/tasks/${task.id}`));
      body = await response.json() as typeof body;
      if (body?.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(body).toMatchObject({ status: "succeeded" });
    expect(body?.candidate_id).toMatch(/^pc_/);
    discovery.close();
  });

  it("exposes a reviewable catalog diff and drift resolution", async () => {
    const catalog = new ProjectCatalogStore(":memory:");
    const first = catalog.saveCandidate({
      projectId: "catalog-api",
      repositoryRemote: "gitlab/rock/catalog-api",
      language: "go",
      confidence: "high",
      evidence: [{ kind: "test", ref: "first" }],
    });
    catalog.acceptCandidate(first.id);
    catalog.saveCandidate({
      projectId: "catalog-api",
      repositoryRemote: "gitlab/rock/catalog-api-new",
      language: "go",
      confidence: "high",
      evidence: [{ kind: "test", ref: "second" }],
    });
    const discovery = new ProjectDiscovery(catalog);
    const app = createProjectCatalogApp(catalog, discovery, TOKEN);

    const diff = await app.request(request(`/v1/projects/candidates/${first.id}/diff`));
    expect(diff.status).toBe(200);
    expect((await diff.json()) as { unified: string }).toMatchObject({
      unified: expect.stringContaining("catalog/projects.yaml"),
    });
    const drifts = await app.request(request("/v1/projects/drifts?project_id=catalog-api"));
    const driftList = (await drifts.json()) as { drifts: Array<{ id: string }> };
    expect(driftList.drifts).toHaveLength(1);
    const resolved = await app.request(request(`/v1/projects/drifts/${driftList.drifts[0]!.id}/resolve`, { method: "POST" }));
    expect(resolved.status).toBe(200);
    expect((await resolved.json()) as { drift: { status: string } }).toMatchObject({ drift: { status: "resolved" } });
    discovery.close();
  });
});
