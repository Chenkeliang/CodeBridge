import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FlowCatalogStore } from "./index.js";
import { InvalidFlowStateError } from "./policy.js";

describe("flow catalog", () => {
  it("stores candidate and published Flow definitions by revision", () => {
    const store = new FlowCatalogStore(":memory:");
    const flow = store.save({
      flowId: "flow-a",
      name: "Flow A",
      kind: "runbook",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: "sha256:one",
      steps: [{ id: "inspect" }],
    });
    expect(store.get("flow-a")).toEqual(flow);
    expect(flow.reviewStatus).toBe("pending");
    expect(flow.gitRevision).toBeNull();
    expect(store.list()).toHaveLength(1);
    expect(store.save({ ...flow, status: "published", definitionRevision: "sha256:two", reviewStatus: "approved", gitRevision: "abc" })).toMatchObject({ reviewStatus: "approved", gitRevision: "abc" });
    store.close();
  });

  it("rejects illegal Flow states before persistence", () => {
    const store = new FlowCatalogStore(":memory:");

    expect(() =>
      store.save({
        flowId: "guide-published",
        name: "Invalid Guide",
        kind: "guide",
        status: "published",
        source: "user_selected",
        definitionRevision: "sha256:guide",
        steps: [],
      }),
    ).toThrow(InvalidFlowStateError);
    expect(() =>
      store.save({
        flowId: "ephemeral-draft",
        name: "Invalid Ephemeral",
        kind: "ephemeral",
        status: "draft",
        source: "agent_generated",
        definitionRevision: "sha256:ephemeral",
        steps: [],
      }),
    ).toThrow(InvalidFlowStateError);
    expect(store.list()).toEqual([]);
    store.close();
  });

  it("persists typed inputs and the compile-tuple plan_ir_hash", () => {
    const store = new FlowCatalogStore(":memory:");
    const flow = store.save({
      flowId: "flow-typed",
      name: "Typed",
      kind: "runbook",
      status: "candidate",
      source: "user_selected",
      definitionRevision: "sha256:def",
      planIrHash: "sha256:plan",
      inputs: [
        { id: "company_id", type: "string", required: true, source: "user", pattern: "^\\d{4,}$" },
        { id: "env", type: "enum", source: "user", values: ["test", "production"], default: "test", confirmation: { when: "value == 'production'" } },
      ],
      steps: [{ id: "deliver", capability: "equity.deliver" }],
    });
    const loaded = store.get("flow-typed");
    expect(loaded?.planIrHash).toBe("sha256:plan");
    expect(loaded?.inputs).toEqual(flow.inputs);
    expect(loaded?.inputs[0]).toMatchObject({ pattern: "^\\d{4,}$" });
    store.close();
  });

  it("persists successWhen on steps", () => {
    const store = new FlowCatalogStore(":memory:");
    const flow = store.save({
      flowId: "flow-pc",
      name: "PC",
      kind: "runbook",
      status: "candidate",
      source: "user_selected",
      definitionRevision: "sha256:def",
      planIrHash: "sha256:plan",
      inputs: [{ id: "text", type: "string", source: "user", required: true }],
      steps: [{
        id: "echo",
        capability: "demo.echo",
        mode: "read_only",
        successWhen: "output.text exists",
      }],
    });
    expect(store.get("flow-pc")?.steps[0]?.successWhen).toBe("output.text exists");
    expect(flow.steps[0]?.successWhen).toBe("output.text exists");
    store.close();
  });

  it("persists lineage and provenance with append-only revision history", () => {
    const store = new FlowCatalogStore(":memory:");
    const source = store.save({
      flowId: "flow-source",
      name: "Source",
      description: "Published baseline",
      kind: "runbook",
      status: "published",
      source: "git",
      definitionRevision: "sha256:source",
      publicationSequence: 1,
      steps: [],
    });
    const candidate = store.save({
      flowId: "flow-candidate",
      name: "Candidate",
      description: "Derived definition",
      kind: "runbook",
      status: "candidate",
      source: "user_selected",
      definitionRevision: "sha256:candidate",
      lineageRootFlowId: source.flowId,
      parentFlowId: source.flowId,
      provenance: {
        sourceRunId: "run-1",
        sourceSessionId: "sess-1",
        sourceFlowId: source.flowId,
        sourceDefinitionRevision: source.definitionRevision,
      },
      steps: [],
    });

    expect(store.get(candidate.flowId)).toMatchObject({
      description: "Derived definition",
      lineageRootFlowId: "flow-source",
      parentFlowId: "flow-source",
      publicationSequence: 0,
      provenance: {
        sourceRunId: "run-1",
        sourceSessionId: "sess-1",
        sourceFlowId: "flow-source",
        sourceDefinitionRevision: "sha256:source",
      },
    });
    expect(store.history(candidate.flowId)).toHaveLength(1);
    expect(store.history(candidate.flowId)[0]).toMatchObject({
      action: "created",
      definitionRevision: "sha256:candidate",
    });
    expect(store.getRevision(candidate.flowId, candidate.definitionRevision)?.flowId)
      .toBe(candidate.flowId);
    expect(store.listLineage(source.lineageRootFlowId).map((flow) => flow.flowId).sort())
      .toEqual(["flow-candidate", "flow-source"]);

    store.save({ ...candidate });
    expect(store.history(candidate.flowId)).toHaveLength(1);
    store.save({ ...candidate, reviewStatus: "rejected" });
    expect(store.history(candidate.flowId).map((entry) => entry.action)).toEqual([
      "created",
      "review_rejected",
    ]);
    store.close();
  });

  it("persists sourceRequestId across reopen and revision history reads", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-flow-provenance-"));
    const databasePath = path.join(directory, "flows.sqlite");
    try {
      const first = new FlowCatalogStore(databasePath);
      const candidate = first.save({
        flowId: "flow-save-request",
        name: "Save Request Candidate",
        kind: "runbook",
        status: "candidate",
        source: "agent_generated",
        definitionRevision: "sha256:request",
        provenance: {
          sourceRunId: "run-source",
          sourceSessionId: "sess-source",
          sourceFlowId: "flow-source",
          sourceDefinitionRevision: "sha256:source",
          sourceRequestId: "fsr-source",
        },
        steps: [{ id: "inspect", purpose: "核对来源" }],
      });
      first.close();

      const reopened = new FlowCatalogStore(databasePath);
      expect(reopened.get(candidate.flowId)?.provenance?.sourceRequestId).toBe("fsr-source");
      expect(reopened.history(candidate.flowId)[0]?.snapshot.provenance?.sourceRequestId)
        .toBe("fsr-source");
      reopened.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("defaults legacy records to their own lineage root", () => {
    const store = new FlowCatalogStore(":memory:");
    const flow = store.save({
      flowId: "flow-legacy",
      name: "Legacy",
      kind: "runbook",
      status: "published",
      source: "git",
      definitionRevision: "sha256:legacy",
      steps: [],
    });

    expect(flow).toMatchObject({
      description: null,
      lineageRootFlowId: "flow-legacy",
      parentFlowId: null,
      provenance: null,
      publicationSequence: 1,
    });
    store.close();
  });

  it("clears stale review metadata when a Candidate definition is edited", () => {
    const store = new FlowCatalogStore(":memory:");
    const candidate = store.save({
      flowId: "flow-review-reset",
      name: "Before",
      kind: "runbook",
      status: "candidate",
      source: "user_selected",
      definitionRevision: "sha256:before",
      reviewStatus: "rejected",
      gitRevision: "stale-git-revision",
      steps: [],
    });
    const edited = store.save({
      ...candidate,
      name: "After",
      definitionRevision: "sha256:after",
      reviewStatus: "pending",
      gitRevision: null,
    });
    expect(edited).toMatchObject({ reviewStatus: "pending", gitRevision: null });
    store.close();
  });
});
