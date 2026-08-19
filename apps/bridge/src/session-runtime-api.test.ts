import { describe, expect, it } from "vitest";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionCoordinator } from "@codebridge/session-coordinator";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import { compileWorkflow, definitionHash } from "@codebridge/workflow-engine";
import type { RunExecutor } from "@codebridge/run-executor";
import type { CapabilityRegistry } from "@codebridge/policy";
import { createSessionApp } from "./session-api.js";
import { catalogPlanId } from "./flow-compile.js";

const token = "runtime-token";

function setup(overrides: {
  flows?: FlowCatalogStore;
  executor?: RunExecutor;
  capabilities?: CapabilityRegistry;
} = {}) {
  const catalog = new SessionCatalogStore(":memory:");
  const workItems = new SqliteEventStore(":memory:");
  const coordinator = new SessionCoordinator(workItems, {
    maxQueuedTurns: 100,
  });
  const session = catalog.createSession({
    agentId: "pi",
    cwd: "/workspace",
  });
  const app = createSessionApp({
    catalog,
    workItems,
    coordinator,
    flows: overrides.flows,
    executor: overrides.executor,
    capabilities: overrides.capabilities,
    agents: [{
      agentId: "pi",
      displayName: "Pi",
      adapter: "sdk",
      status: "healthy",
      capabilities: ["session"],
      models: [],
      sessionFeatures: ["resume"],
    }],
  }, token);
  return { app, catalog, workItems, coordinator, session };
}

function request(message: string, key?: string) {
  return {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify({ message }),
  };
}

describe("Session runtime command API", () => {
  it("atomically dispatches the first message", async () => {
    const fixture = setup();
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      request("检查项目", "message_1"),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      acceptance: "dispatched",
      turn: { status: "dispatched" },
      runtime: { active_run: { status: "queued" } },
    });
    expect(
      fixture.workItems.getSessionRuntime(fixture.session.id)?.activeRunId,
    ).toBeTruthy();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("returns the committed receipt for an ambiguous retry", async () => {
    const fixture = setup();
    const first = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      request("检查项目", "message_1"),
    );
    const second = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      request("检查项目", "message_1"),
    );
    expect(await second.json()).toEqual(await first.json());
    expect(
      fixture.workItems.listRuns(
        fixture.workItems.getWorkItemBySessionId(fixture.session.id)!.id,
      ),
    ).toHaveLength(1);
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("requires an idempotency key for mutation", async () => {
    const fixture = setup();
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      request("检查项目"),
    );
    expect(response.status).toBe(400);
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("rejects candidate runbook execution without dry_run", async () => {
    const flows = new FlowCatalogStore(":memory:");
    flows.save({
      flowId: "flow_demo_echo",
      name: "demo",
      kind: "runbook",
      status: "candidate",
      source: "user_selected",
      definitionRevision: "sha256:def",
      planIrHash: "sha256:plan",
      inputs: [{ id: "text", type: "string", source: "user", required: true }],
      steps: [{ id: "echo", capability: "demo.echo", mode: "read_only", successWhen: "output.text exists" }],
    });
    const fixture = setup({ flows });
    fixture.catalog.updateSession(fixture.session.id, { flowId: "flow_demo_echo" });
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "k1",
        },
        body: JSON.stringify({ message: "run", inputs: { text: "hi" } }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "flow_not_executable" });
    flows.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("returns missing_inputs without creating a run", async () => {
    const flows = new FlowCatalogStore(":memory:");
    const definition = {
      schema_version: 1,
      workflow_id: "flow_demo_echo",
      name: "demo",
      kind: "runbook",
      status: "draft",
      inputs: [{ id: "text", type: "string", source: "user", required: true }],
      steps: [{ id: "echo", capability: "demo.echo", mode: "read_only", success_when: "output.text exists" }],
    };
    const plan = compileWorkflow(definition, {
      source: "workflow",
      definitionRevision: definitionHash(definition),
      planId: catalogPlanId("flow_demo_echo"),
    });
    flows.save({
      flowId: "flow_demo_echo",
      name: "demo",
      kind: "runbook",
      status: "published",
      source: "user_selected",
      definitionRevision: definitionHash(definition),
      planIrHash: definitionHash(plan),
      inputs: plan.inputs,
      steps: [{
        id: "echo",
        capability: "demo.echo",
        mode: "read_only",
        successWhen: "output.text exists",
      }],
    });
    const fixture = setup({ flows });
    fixture.catalog.updateSession(fixture.session.id, { flowId: "flow_demo_echo" });
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "k2",
        },
        body: JSON.stringify({ message: "run" }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "missing_inputs",
      missing: [{ id: "text", type: "string", source: "user", reason: "required" }],
    });
    expect(fixture.workItems.getSessionRuntime(fixture.session.id)?.activeRunId ?? null).toBeNull();
    expect(fixture.catalog.getSession(fixture.session.id)?.taskRecordId ?? null).toBeNull();
    flows.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("rejects a published runbook when catalog steps drift from plan_ir_hash", async () => {
    const flows = new FlowCatalogStore(":memory:");
    const definition = {
      schema_version: 1,
      workflow_id: "flow_demo_echo",
      name: "demo",
      kind: "runbook",
      status: "draft",
      inputs: [{ id: "text", type: "string", source: "user", required: true }],
      steps: [{ id: "echo", capability: "demo.echo", mode: "read_only", success_when: "output.text exists" }],
    };
    const plan = compileWorkflow(definition, {
      source: "workflow",
      definitionRevision: definitionHash(definition),
      planId: catalogPlanId("flow_demo_echo"),
    });
    flows.save({
      flowId: "flow_demo_echo",
      name: "demo",
      kind: "runbook",
      status: "published",
      source: "user_selected",
      definitionRevision: definitionHash(definition),
      planIrHash: definitionHash(plan),
      inputs: plan.inputs,
      steps: [{
        id: "echo",
        capability: "demo.echo",
        mode: "read_only",
        successWhen: "output.missing exists",
      }],
    });
    const fixture = setup({ flows });
    fixture.catalog.updateSession(fixture.session.id, { flowId: "flow_demo_echo" });
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "k3",
        },
        body: JSON.stringify({ message: "run", inputs: { text: "hi" } }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "plan_ir_drift" });
    flows.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("records confirmed PARAM_RESOLVED from explicit runbook inputs", async () => {
    const flows = new FlowCatalogStore(":memory:");
    const flow = savePublishedDemoEcho(flows);
    const fixture = setup({ flows });
    fixture.catalog.updateSession(fixture.session.id, { flowId: "flow_demo_echo" });
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "param_confirmed",
        },
        body: JSON.stringify({ message: "run", inputs: { text: "hi" } }),
      },
    );
    expect(response.status).toBe(202);
    const workItemId = fixture.workItems.getWorkItemBySessionId(fixture.session.id)!.id;
    const resolved = fixture.workItems.listEvents(workItemId)
      .filter((event) => event.type === "PARAM_RESOLVED");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.actor).toBe("user");
    expect(resolved[0]?.payload).toMatchObject({
      flow_id: "flow_demo_echo",
      field: "text",
      final_value: "hi",
      resolution: "confirmed",
      source: "user",
      flow_revision: flow.planIrHash,
      resolver_version: "v1",
    });
    expect(resolved[0]?.payload).toHaveProperty("candidate_value");
    expect(resolved[0]?.payload.source).not.toBe("agent_extracted");
    expect(fixture.workItems.getWorkItem(workItemId)?.identifiers).toEqual({ text: "hi" });
    flows.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("records edited PARAM_RESOLVED when a later turn changes a resolved input", async () => {
    const flows = new FlowCatalogStore(":memory:");
    const flow = savePublishedDemoEcho(flows, { default: "hi" });
    const fixture = setup({ flows });
    fixture.catalog.updateSession(fixture.session.id, { flowId: "flow_demo_echo" });
    const first = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "param_hi",
        },
        body: JSON.stringify({ message: "run", inputs: { text: "hi" } }),
      },
    );
    expect(first.status).toBe(202);
    const second = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "param_yo",
        },
        body: JSON.stringify({ message: "again", inputs: { text: "yo" } }),
      },
    );
    expect(second.status).toBe(202);
    const workItemId = fixture.workItems.getWorkItemBySessionId(fixture.session.id)!.id;
    const resolved = fixture.workItems.listEvents(workItemId)
      .filter((event) => event.type === "PARAM_RESOLVED");
    expect(resolved).toHaveLength(2);
    expect(resolved[1]?.payload).toMatchObject({
      flow_id: "flow_demo_echo",
      field: "text",
      candidate_value: "hi",
      final_value: "yo",
      resolution: "edited",
      source: "user",
      flow_revision: flow.planIrHash,
      resolver_version: "v1",
    });
    expect(resolved[1]?.payload.source).not.toBe("agent_extracted");
    expect(fixture.workItems.getWorkItem(workItemId)?.identifiers).toEqual({ text: "yo" });

    const replay = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "param_yo",
        },
        body: JSON.stringify({ message: "again", inputs: { text: "yo" } }),
      },
    );
    expect(replay.status).toBe(202);
    expect(
      fixture.workItems.listEvents(workItemId)
        .filter((event) => event.type === "PARAM_RESOLVED"),
    ).toHaveLength(2);
    flows.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });
});

function savePublishedDemoEcho(
  flows: FlowCatalogStore,
  inputExtra: { default?: string } = {},
) {
  const definition = {
    schema_version: 1,
    workflow_id: "flow_demo_echo",
    name: "demo",
    kind: "runbook",
    status: "draft",
    inputs: [{
      id: "text",
      type: "string",
      source: "user",
      required: true,
      ...(inputExtra.default === undefined ? {} : { default: inputExtra.default }),
    }],
    steps: [{
      id: "echo",
      capability: "demo.echo",
      mode: "read_only",
      success_when: "output.text exists",
    }],
  };
  const plan = compileWorkflow(definition, {
    source: "workflow",
    definitionRevision: definitionHash(definition),
    planId: catalogPlanId("flow_demo_echo"),
  });
  flows.save({
    flowId: "flow_demo_echo",
    name: "demo",
    kind: "runbook",
    status: "published",
    source: "user_selected",
    definitionRevision: definitionHash(definition),
    planIrHash: definitionHash(plan),
    inputs: plan.inputs,
    steps: [{
      id: "echo",
      capability: "demo.echo",
      mode: "read_only",
      successWhen: "output.text exists",
    }],
  });
  return flows.get("flow_demo_echo")!;
}
