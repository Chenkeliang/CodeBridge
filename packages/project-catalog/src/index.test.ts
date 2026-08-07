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
      confidence: "high",
      evidence: [{ kind: "git_remote", ref: "first" }],
    });
    catalog.acceptCandidate(first.id);
    const second = catalog.saveCandidate({
      projectId: "equity-center",
      repositoryRemote: "other/evil",
      language: "python",
      confidence: "high",
      evidence: [{ kind: "git_remote", ref: "second" }],
    });
    expect(second.id).toBe(first.id);
    expect(catalog.getProject("equity-center")).toMatchObject({
      repositoryRemote: "gitlab/rock/equity-center",
      language: "go",
    });
    catalog.close();
  });
});
