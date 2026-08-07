import { describe, expect, it } from "vitest";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import { SessionCatalogStore } from "@codebridge/session-catalog";
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

  it("requires a Git revision before publishing a candidate", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    catalog.save({
      flowId: "flow-review",
      name: "Review me",
      kind: "guide",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: "sha256:one",
      steps: [{ id: "inspect", capability: "context.inspect", mode: "read_only" }],
    });
    const app = createFlowApp(catalog, "token");
    const missingRevision = await app.request("/v1/flows/flow-review/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(missingRevision.status).toBe(400);

    const approved = await app.request("/v1/flows/flow-review/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc123" }),
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: "published", review_status: "approved", git_revision: "abc123", definition_revision: "git:abc123" });
    catalog.close();
  });

  it("binds a published Flow to the next Run of a Session", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    catalog.save({
      flowId: "flow-bind",
      name: "Bind me",
      kind: "guide",
      status: "published",
      source: "git",
      definitionRevision: "git:one",
      steps: [{ id: "inspect", capability: "context.inspect", mode: "read_only" }],
    });
    const app = createFlowApp(catalog, "token", { sessions });
    const response = await app.request("/v1/flows/flow-bind/apply", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ session_id: session.id }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true, session_id: session.id, flow_id: "flow-bind", definition_revision: "git:one" });
    expect(sessions.getSession(session.id)?.flowId).toBe("flow-bind");
    sessions.close();
    catalog.close();
  });
});
