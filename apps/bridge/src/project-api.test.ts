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
});
