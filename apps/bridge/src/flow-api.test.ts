import { describe, expect, it } from "vitest";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import {
  CapabilityRegistry,
  CapabilityRuntime,
  registerDemoCapabilities,
  registerEquityCapabilities,
} from "@codebridge/policy";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SqliteEventStore } from "@codebridge/work-items";
import { createFlowApp } from "./flow-api.js";

describe("flow API", () => {
  it("separates management and consumption views behind auth", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    for (const flow of [
      { flowId: "guide-draft", kind: "guide", status: "draft" },
      { flowId: "runbook-draft", kind: "runbook", status: "draft" },
      { flowId: "runbook-candidate", kind: "runbook", status: "candidate" },
      { flowId: "runbook-published", kind: "runbook", status: "published" },
      { flowId: "runbook-deprecated", kind: "runbook", status: "deprecated" },
    ] as const) {
      catalog.save({
        ...flow,
        name: flow.flowId,
        source: "git",
        definitionRevision: `git:${flow.flowId}`,
        steps: [],
      });
    }
    const app = createFlowApp(catalog, "token");
    expect((await app.request("/v1/flows")).status).toBe(401);
    const manage = await app.request("/v1/flows?view=manage", { headers: { authorization: "Bearer token" } });
    expect(manage.status).toBe(200);
    expect((await manage.json() as { flows: Array<{ flow_id: string }> }).flows.map((flow) => flow.flow_id).sort()).toEqual([
      "guide-draft",
      "runbook-candidate",
      "runbook-deprecated",
      "runbook-draft",
      "runbook-published",
    ]);

    const consume = await app.request("/v1/flows?view=consume", { headers: { authorization: "Bearer token" } });
    expect(consume.status).toBe(200);
    expect((await consume.json() as { flows: Array<{ flow_id: string }> }).flows.map((flow) => flow.flow_id)).toEqual([
      "runbook-published",
    ]);

    const safeDefault = await app.request("/v1/flows", { headers: { authorization: "Bearer token" } });
    expect(safeDefault.status).toBe(200);
    expect((await safeDefault.json() as { flows: Array<{ flow_id: string }> }).flows).toEqual([
      expect.objectContaining({ flow_id: "runbook-published" }),
    ]);

    const invalid = await app.request("/v1/flows?view=other", { headers: { authorization: "Bearer token" } });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_flow_view" });
    catalog.close();
  });

  it("saves a Session-generated Flow as a candidate", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    const app = createFlowApp(catalog, "token", { sessions });
    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        definition_revision: "sha256:one",
        flow: {
          flow_id: "flow-candidate",
          name: "当前流程",
          steps: [{
            id: "inspect",
            capability: "context.inspect",
            mode: "read_only",
            retry: { max_attempts: 3, delay_ms: 10 },
          }],
        },
      }),
    });
    expect(response.status).toBe(201);
    expect((await response.json() as { status: string; flow_id: string })).toMatchObject({
      kind: "runbook",
      status: "candidate",
      flow_id: "flow-candidate",
      steps: [{ retry: { max_attempts: 3, delay_ms: 10 } }],
    });
    sessions.close();
    catalog.close();
  });

  it("rejects a candidate with a nonexistent Session before writing the Catalog", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const app = createFlowApp(catalog, "token", { sessions });

    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "sess_missing",
        flow: {
          flow_id: "flow-untraceable",
          steps: [{ id: "inspect", capability: "context.inspect", mode: "read_only" }],
        },
      }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "session_not_found" });
    expect(catalog.get("flow-untraceable")).toBeUndefined();
    sessions.close();
    catalog.close();
  });

  it("does not let a candidate overwrite an existing Published Flow", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    catalog.save({
      flowId: "flow-stable",
      name: "Stable",
      kind: "runbook",
      status: "published",
      source: "git",
      definitionRevision: "sha256:published",
      steps: [{ id: "inspect", capability: "context.inspect", mode: "read_only" }],
    });
    const app = createFlowApp(catalog, "token", { sessions });

    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        flow: {
          flow_id: "flow-stable",
          steps: [{ id: "replace", capability: "context.inspect", mode: "read_only" }],
        },
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "flow_id_conflict",
      flow_id: "flow-stable",
    });
    expect(catalog.get("flow-stable")).toMatchObject({
      status: "published",
      definitionRevision: "sha256:published",
      steps: [expect.objectContaining({ id: "inspect" })],
    });
    sessions.close();
    catalog.close();
  });

  it.each(["guide", "ephemeral"])("rejects an explicit %s candidate kind", async (kind) => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    const app = createFlowApp(catalog, "token", { sessions });
    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        flow: { flow_id: `flow-${kind}`, kind, steps: [] },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_flow_state" });
    expect(catalog.get(`flow-${kind}`)).toBeUndefined();
    sessions.close();
    catalog.close();
  });

  it("rejects a candidate that violates the Workflow DSL", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    const app = createFlowApp(catalog, "token", { sessions });
    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        definition_revision: "sha256:invalid",
        flow: { flow_id: "invalid-flow", steps: [{ id: "release", capability: "release.execute", mode: "production_write" }] },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_flow" });
    expect(catalog.get("invalid-flow")).toBeUndefined();
    sessions.close();
    catalog.close();
  });

  it("requires a Git revision before publishing a candidate", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    catalog.save({
      flowId: "flow-review",
      name: "Review me",
      kind: "runbook",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: "sha256:one",
      steps: [],
    });
    const capabilities = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    const app = createFlowApp(catalog, "token", { capabilities, runtime });
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
    expect(await approved.json()).toMatchObject({ status: "published", review_status: "approved", git_revision: "abc123", definition_revision: "sha256:one" });
    capabilities.close();
    catalog.close();
  });

  it("binds a published Flow to the next Run of a Session", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    catalog.save({
      flowId: "flow-bind",
      name: "Bind me",
      kind: "runbook",
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
    expect(sessions.getSession(session.id)?.flowDefinitionRevision).toBe("git:one");
    sessions.close();
    catalog.close();
  });

  it.each([
    ["guide", "draft"],
    ["runbook", "draft"],
    ["runbook", "candidate"],
    ["runbook", "deprecated"],
  ] as const)("rejects applying a %s %s without changing the existing binding", async (kind, status) => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    sessions.bindFlow(session.id, { flowId: "flow-current", definitionRevision: "sha256:current" });
    catalog.save({
      flowId: `flow-${kind}-${status}`,
      name: "Not bindable",
      kind,
      status,
      source: "git",
      definitionRevision: "sha256:new",
      steps: [],
    });
    const app = createFlowApp(catalog, "token", { sessions });
    const response = await app.request(`/v1/flows/flow-${kind}-${status}/apply`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ session_id: session.id }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "flow_not_bindable" });
    expect(sessions.getSession(session.id)).toMatchObject({
      flowId: "flow-current",
      flowDefinitionRevision: "sha256:current",
    });
    sessions.close();
    catalog.close();
  });

  it("records Flow selection and candidate persistence on the Session event stream", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    const workItem = events.createWorkItem({
      title: "flow events",
      mode: "auto",
      conversationId: "conv_flow_events",
      riskLevel: "read_only",
    });
    const session = sessions.createSession({ agentId: "pi", taskRecordId: workItem.id });
    catalog.save({
      flowId: "flow-select",
      name: "Select",
      kind: "runbook",
      status: "published",
      source: "git",
      definitionRevision: "git:select",
      steps: [{ id: "inspect", capability: "context.inspect", mode: "read_only" }],
    });
    const app = createFlowApp(catalog, "token", { sessions, events });
    await app.request("/v1/flows/flow-select/apply", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ session_id: session.id }),
    });
    await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        definition_revision: "agent:one",
        flow: {
          flow_id: "flow-generated",
          steps: [{ id: "inspect", capability: "context.inspect", mode: "read_only" }],
        },
      }),
    });

    expect(events.listEvents(workItem.id).filter((event) => event.type.startsWith("FLOW_")).map((event) => event.type)).toEqual([
      "FLOW_SELECTED",
      "FLOW_SAVED_AS_CANDIDATE",
    ]);
    events.close();
    sessions.close();
    catalog.close();
  });

  // Enforces spec rule PROTO-FLOW-REVISION-001 (server-owned content-hash revisions) — docs/spec/RULES.md.
  it("computes content-hash revisions server-side and stores the compile tuple", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    const app = createFlowApp(catalog, "token", { sessions });
    const body = {
      session_id: session.id,
      definition_revision: "agent:caller-supplied-will-be-ignored",
      flow: {
        flow_id: "flow-hashed",
        name: "Hashed",
        kind: "runbook",
        inputs: [{ id: "company_id", type: "string", source: "user", required: true }],
        steps: [{ id: "deliver", capability: "equity.deliver", mode: "read_only" }],
      },
    };
    const headers = { authorization: "Bearer token", "content-type": "application/json" };
    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    const flow = catalog.get("flow-hashed");
    expect(flow?.definitionRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(flow?.planIrHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(flow?.definitionRevision).not.toBe(flow?.planIrHash);
    // Typed inputs must survive the API boundary end-to-end (not silently dropped).
    expect(flow?.inputs).toEqual([{ id: "company_id", type: "string", source: "user", required: true }]);
    // Re-posting the identical definition yields identical hashes (deterministic).
    await app.request("/v1/flows/candidates", { method: "POST", headers, body: JSON.stringify(body) });
    expect(catalog.get("flow-hashed")?.definitionRevision).toBe(flow?.definitionRevision);
    expect(catalog.get("flow-hashed")?.planIrHash).toBe(flow?.planIrHash);
    sessions.close();
    catalog.close();
  });

  it("persists success_when from the candidate body", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    const app = createFlowApp(catalog, "token", { sessions });
    const response = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        flow: {
          flow_id: "flow-when",
          kind: "runbook",
          steps: [{
            id: "echo",
            capability: "demo.echo",
            mode: "read_only",
            success_when: "output.text exists",
          }],
        },
      }),
    });
    expect(response.status).toBe(201);
    expect(catalog.get("flow-when")?.steps[0]?.successWhen).toBe("output.text exists");
    const body = await response.json() as { steps: Array<{ success_when: string | null }> };
    expect(body.steps[0]?.success_when).toBe("output.text exists");
    sessions.close();
    catalog.close();
  });

  it("rejects publishing a runbook with a manual step", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    catalog.save({
      flowId: "flow-manual",
      name: "Manual",
      kind: "runbook",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: "sha256:one",
      steps: [{ id: "ask", mode: "manual", purpose: "confirm" }],
    });
    const app = createFlowApp(catalog, "token");
    const approved = await app.request("/v1/flows/flow-manual/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc" }),
    });
    expect(approved.status).toBe(409);
    expect(await approved.json()).toMatchObject({ error: "flow_not_publishable" });
    expect(catalog.get("flow-manual")?.status).toBe("candidate");
    catalog.close();
  });

  it("rejects publishing a runbook step without success_when", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const capabilities = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    registerDemoCapabilities(capabilities, runtime);
    catalog.save({
      flowId: "flow-no-when",
      name: "No when",
      kind: "runbook",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: "sha256:one",
      steps: [{ id: "echo", capability: "demo.echo", mode: "read_only" }],
    });
    const app = createFlowApp(catalog, "token", { capabilities, runtime });
    const approved = await app.request("/v1/flows/flow-no-when/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc" }),
    });
    expect(approved.status).toBe(409);
    expect(await approved.json()).toMatchObject({
      error: "flow_not_publishable",
      issues: expect.arrayContaining(["success_when required: echo"]),
    });
    expect(catalog.get("flow-no-when")?.status).toBe("candidate");
    capabilities.close();
    catalog.close();
  });

  it("rejects publishing a runbook whose success_when fails static validation", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const capabilities = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    registerDemoCapabilities(capabilities, runtime);
    catalog.save({
      flowId: "flow-bad-when",
      name: "Bad when",
      kind: "runbook",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: "sha256:one",
      steps: [{
        id: "echo",
        capability: "demo.echo",
        mode: "read_only",
        successWhen: "output.a ===",
      }],
    });
    const app = createFlowApp(catalog, "token", { capabilities, runtime });
    const approved = await app.request("/v1/flows/flow-bad-when/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc" }),
    });
    expect(approved.status).toBe(409);
    const body = await approved.json() as { error: string; issues: string[] };
    expect(body.error).toBe("flow_not_publishable");
    expect(body.issues.some((issue) => issue.includes("invalid success_when for echo"))).toBe(true);
    expect(catalog.get("flow-bad-when")?.status).toBe("candidate");
    capabilities.close();
    catalog.close();
  });

  it("publishes a runbook whose demo capabilities are registered", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    const capabilities = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    registerDemoCapabilities(capabilities, runtime);
    const app = createFlowApp(catalog, "token", { capabilities, runtime, sessions });
    const created = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        flow: {
          flow_id: "flow_demo_echo",
          kind: "runbook",
          inputs: [{ id: "text", type: "string", source: "user", required: true }],
          steps: [
            {
              id: "echo",
              capability: "demo.echo",
              mode: "read_only",
              success_when: "output.text exists",
            },
            {
              id: "concat",
              capability: "demo.concat",
              mode: "read_only",
              depends_on: ["echo"],
              success_when: "output.result exists",
            },
          ],
        },
      }),
    });
    expect(created.status).toBe(201);
    const approved = await app.request("/v1/flows/flow_demo_echo/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc" }),
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: "published" });
    capabilities.close();
    sessions.close();
    catalog.close();
  });

  it("publishes a runbook whose equity capability is registered", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    const sessions = new SessionCatalogStore(":memory:");
    const session = sessions.createSession({ agentId: "pi" });
    const capabilities = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    registerEquityCapabilities(capabilities, runtime);
    const app = createFlowApp(catalog, "token", { capabilities, runtime, sessions });
    const created = await app.request("/v1/flows/candidates", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        flow: {
          flow_id: "flow_equity_balance",
          name: "Equity Balance",
          kind: "runbook",
          inputs: [{ id: "user_id", type: "string", source: "user", required: true }],
          steps: [{
            id: "lookup",
            capability: "equity.balance",
            mode: "read_only",
            success_when: "output.balance exists",
          }],
        },
      }),
    });
    expect(created.status).toBe(201);
    const approved = await app.request("/v1/flows/flow_equity_balance/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc" }),
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: "published" });
    expect(catalog.get("flow_equity_balance")?.status).toBe("published");
    capabilities.close();
    sessions.close();
    catalog.close();
  });

  it("rejects publishing a runbook whose capability is not registered", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    catalog.save({
      flowId: "flow-equity",
      name: "Equity",
      kind: "runbook",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: "sha256:one",
      steps: [{ id: "deliver", capability: "equity.deliver", mode: "read_only" }],
    });
    const capabilities = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    const app = createFlowApp(catalog, "token", { capabilities, runtime });
    const approved = await app.request("/v1/flows/flow-equity/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc" }),
    });
    expect(approved.status).toBe(409);
    expect(await approved.json()).toMatchObject({ error: "flow_not_publishable" });
    expect(catalog.get("flow-equity")?.status).toBe("candidate");
    capabilities.close();
    catalog.close();
  });

  it("rejects review for a Guide draft", async () => {
    const catalog = new FlowCatalogStore(":memory:");
    catalog.save({
      flowId: "flow-skill-guide",
      name: "Skill guide",
      kind: "guide",
      status: "draft",
      source: "agent_generated",
      definitionRevision: "sha256:one",
      steps: [{ id: "investigate", capability: "skill.investigate", mode: "read_only" }],
    });
    const app = createFlowApp(catalog, "token");
    const approved = await app.request("/v1/flows/flow-skill-guide/review", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", git_revision: "abc" }),
    });
    expect(approved.status).toBe(409);
    expect(await approved.json()).toMatchObject({ error: "flow_not_reviewable" });
    expect(catalog.get("flow-skill-guide")?.status).toBe("draft");
    catalog.close();
  });
});
