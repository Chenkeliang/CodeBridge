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
    expect(store.list()).toHaveLength(1);
    expect(store.save({ ...flow, status: "published", definitionRevision: "sha256:two" }).status).toBe("published");
    store.close();
  });
});
