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

  it("saves a Session-generated Flow as a candidate", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const app = createFlowApp(catalog, "token");
    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "sess_1",
        definition_revision: "sha256:one",
        flow: {
          flow_id: "flow-candidate",
          name: "当前流程",
          steps: [{ id: "inspect", capability: "context.inspect", mode: "read_only" }],
        },
      }),
    });
    expect(response.status).toBe(201);
    expect((await response.json() as { status: string; flow_id: string })).toMatchObject({ status: "candidate", flow_id: "flow-candidate" });
    catalog.close();
  });

  it("rejects a candidate that violates the Workflow DSL", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const app = createFlowApp(catalog, "token");
    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "sess_1",
        definition_revision: "sha256:invalid",
        flow: { flow_id: "invalid-flow", steps: [{ id: "release", capability: "release.execute", mode: "production_write" }] },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_flow" });
    expect(catalog.get("invalid-flow")).toBeUndefined();
    catalog.close();
  });
});
