import { describe, expect, it } from "vitest";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import { createFlowApp } from "./flow-api.js";

describe("flow API", () => {
  it("lists generic Flow Catalog records behind auth", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    catalog.save({
      flowId: "flow-a",
      name: "Flow A",
      kind: "guide",
      status: "published",
      source: "git",
      definitionRevision: "git:one",
      steps: [{ id: "inspect" }],
    });
    const app = createFlowApp(catalog, "token");
    expect((await app.request("/v1/flows")).status).toBe(401);
    const response = await app.request("/v1/flows", { headers: { authorization: "Bearer token" } });
    expect(response.status).toBe(200);
    expect((await response.json() as { flows: Array<{ flow_id: string }> }).flows[0]?.flow_id).toBe("flow-a");
    catalog.close();
  });
});
