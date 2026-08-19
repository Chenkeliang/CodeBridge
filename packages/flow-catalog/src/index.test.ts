import { describe, expect, it } from "vitest";
import { FlowCatalogStore } from "./index.js";

describe("flow catalog", () => {
  it("stores candidate and published Flow definitions by revision", () => {
    const store = new FlowCatalogStore(":memory:");
    const flow = store.save({
      flowId: "flow-a",
      name: "Flow A",
      kind: "guide",
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
});
