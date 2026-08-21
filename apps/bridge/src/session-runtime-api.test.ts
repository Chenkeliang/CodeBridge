import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, RunRequest } from "@codebridge/core";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionCoordinator, SessionLeaseService } from "@codebridge/session-coordinator";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import { compileWorkflow, definitionHash } from "@codebridge/workflow-engine";
import { RunExecutor } from "@codebridge/run-executor";
import {
  CapabilityRegistry,
  CapabilityRuntime,
  PolicyEngine,
  registerDemoCapabilities,
} from "@codebridge/policy";
import { createSessionApp } from "./session-api.js";
import { catalogPlanId } from "./flow-compile.js";

class FakeRunner {
  readonly requests: RunRequest[] = [];
  constructor(private readonly events: AgentEvent[]) {}

  async *run(request: RunRequest): AsyncGenerator<AgentEvent> {
    this.requests.push(request);
    for (const event of this.events) yield event;
  }
}

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

function setupRuntimeLoop(overrides: { flows?: FlowCatalogStore } = {}) {
  const catalog = new SessionCatalogStore(":memory:");
  const workItems = new SqliteEventStore(":memory:");
  const coordinator = new SessionCoordinator(workItems, {
    maxQueuedTurns: 100,
  });
  const session = catalog.createSession({
    agentId: "pi",
    cwd: "/workspace",
  });
  const registry = new CapabilityRegistry();
  const runtime = new CapabilityRuntime();
  registerDemoCapabilities(registry, runtime);
  const runner = new FakeRunner([{ type: "done", exitCode: 0 }]);
  const executor = new RunExecutor(workItems, runner, {
    policy: new PolicyEngine(registry),
    capabilities: runtime,
    sessionCoordinator: coordinator,
    sessionLeaseService: new SessionLeaseService(workItems),
    executorOwner: "test:bridge",
    resolveRequest: (workItem, run) => ({
      runId: run.id,
      sessionKey: { chatId: workItem.conversationId, backendId: "pi", cwd: "/workspace" },
      prompt: "unused",
    }),
  });
  const app = createSessionApp({
    catalog,
    workItems,
    coordinator,
    executor,
    flows: overrides.flows,
    capabilities: registry,
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
  return { app, catalog, workItems, coordinator, session, runner, registry };
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
    bindCatalogFlow(fixture.catalog, fixture.session.id, flows, "flow_demo_echo");
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

  it("rejects an explicit revision mismatch before creating a Run", async () => {
    const flows = new FlowCatalogStore(":memory:");
    const current = savePublishedDemoEcho(flows);
    const fixture = setup({ flows });
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "revision_request_mismatch",
        },
        body: JSON.stringify({
          message: "run",
          flow_id: current.flowId,
          definition_revision: "sha256:old",
          inputs: { text: "hi" },
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "flow_revision_mismatch",
      source: "request",
      flow_id: current.flowId,
      expected_definition_revision: "sha256:old",
      current_definition_revision: current.definitionRevision,
      requires_confirmation: true,
    });
    expect(fixture.workItems.getWorkItemBySessionId(fixture.session.id)).toBeUndefined();
    flows.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("rejects a stale binding without upgrading or falling back to Agent", async () => {
    const flows = new FlowCatalogStore(":memory:");
    const current = savePublishedDemoEcho(flows);
    const fixture = setup({ flows });
    fixture.catalog.bindFlow(fixture.session.id, {
      flowId: current.flowId,
      definitionRevision: "sha256:old",
    });
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      request("run", "revision_binding_mismatch"),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "flow_revision_mismatch",
      source: "binding",
      expected_definition_revision: "sha256:old",
      current_definition_revision: current.definitionRevision,
      requires_confirmation: true,
    });
    expect(fixture.catalog.getSession(fixture.session.id)).toMatchObject({
      flowId: current.flowId,
      flowDefinitionRevision: "sha256:old",
    });
    expect(fixture.workItems.getWorkItemBySessionId(fixture.session.id)).toBeUndefined();
    flows.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("rejects a migrated binding without a revision instead of falling back to Agent", async () => {
    const flows = new FlowCatalogStore(":memory:");
    const current = savePublishedDemoEcho(flows);
    const fixture = setup({ flows });
    const persisted = fixture.catalog.getSession(fixture.session.id)!;
    vi.spyOn(fixture.catalog, "getSession").mockImplementation((sessionId) =>
      sessionId === fixture.session.id
        ? { ...persisted, flowId: current.flowId, flowDefinitionRevision: null }
        : undefined
    );

    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      request("ordinary", "binding_without_revision"),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "flow_binding_invalid",
      source: "binding",
      flow_id: current.flowId,
      requires_confirmation: true,
    });
    expect(fixture.workItems.getWorkItemBySessionId(fixture.session.id)).toBeUndefined();
    flows.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("persists an explicit null Flow unbind after accepting the Web message", async () => {
    const fixture = setup();
    fixture.catalog.bindFlow(fixture.session.id, {
      flowId: "flow-bound",
      definitionRevision: "sha256:bound",
    });

    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "message_unbind",
        },
        body: JSON.stringify({ message: "ordinary", flow_id: null }),
      },
    );

    expect(response.status).toBe(202);
    expect(fixture.catalog.getSession(fixture.session.id)).toMatchObject({
      flowId: null,
      flowDefinitionRevision: null,
    });
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it.each([false, true])("rejects Guide invocation without Agent fallback when dryRun=%s", async (dryRun) => {
    const flows = new FlowCatalogStore(":memory:");
    flows.save({
      flowId: "flow-guide",
      name: "Guide",
      kind: "guide",
      status: "draft",
      source: "agent_generated",
      definitionRevision: "sha256:guide",
      steps: [],
    });
    const fixture = setup({ flows });
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": `guide_${dryRun}`,
        },
        body: JSON.stringify({
          message: "run",
          flow_id: "flow-guide",
          definition_revision: "sha256:guide",
          dry_run: dryRun,
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "flow_not_executable",
      flow_id: "flow-guide",
    });
    expect(fixture.workItems.getWorkItemBySessionId(fixture.session.id)).toBeUndefined();
    flows.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("runs explicit Flow A once while preserving the binding to Flow B", async () => {
    const flows = new FlowCatalogStore(":memory:");
    const flowA = savePublishedDemoEcho(flows, { flowId: "flow_a" });
    const flowB = savePublishedDemoEcho(flows, { flowId: "flow_b" });
    const fixture = setup({ flows });
    fixture.catalog.bindFlow(fixture.session.id, {
      flowId: flowB.flowId,
      definitionRevision: flowB.definitionRevision,
    });
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "one_shot_a",
        },
        body: JSON.stringify({
          message: "run A",
          flow_id: flowA.flowId,
          definition_revision: flowA.definitionRevision,
          actor_ref: { channel: "telegram", id: "spoofed-web-actor" },
          inputs: { text: "hi" },
        }),
      },
    );
    expect(response.status).toBe(202);
    expect(fixture.catalog.getSession(fixture.session.id)).toMatchObject({
      flowId: flowB.flowId,
      flowDefinitionRevision: flowB.definitionRevision,
    });
    const workItem = fixture.workItems.getWorkItemBySessionId(fixture.session.id)!;
    const run = fixture.workItems.listRuns(workItem.id)[0]!;
    expect(fixture.workItems.getPlan(run.planId!)?.workflowId).toBe(flowA.flowId);
    expect(fixture.workItems.listEvents(workItem.id).find((event) => event.type === "MESSAGE_RECEIVED")?.payload).toMatchObject({
      actor_ref: { channel: "web", id: "local" },
      flow_invocation_source: "request",
    });
    flows.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("runs the same Published Flow concurrently with a distinct frozen Plan per Run", async () => {
    const flows = new FlowCatalogStore(":memory:");
    const flow = savePublishedDemoEcho(flows);
    const fixture = setup({ flows });
    const secondSession = fixture.catalog.createSession({ agentId: "pi", cwd: "/workspace" });
    const invoke = (sessionId: string, key: string) => fixture.app.request(
      `/v1/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          message: "run",
          flow_id: flow.flowId,
          definition_revision: flow.definitionRevision,
          inputs: { text: "hi" },
        }),
      },
    );

    const first = await invoke(fixture.session.id, "repeat_flow_first");
    const second = await invoke(secondSession.id, "repeat_flow_second");
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstWorkItem = fixture.workItems.getWorkItemBySessionId(fixture.session.id)!;
    const secondWorkItem = fixture.workItems.getWorkItemBySessionId(secondSession.id)!;
    const firstRun = fixture.workItems.listRuns(firstWorkItem.id)[0]!;
    const secondRun = fixture.workItems.listRuns(secondWorkItem.id)[0]!;
    expect(firstRun.planId).not.toBe(secondRun.planId);
    expect(fixture.workItems.getPlan(firstRun.planId!)?.workflowId).toBe(flow.flowId);
    expect(fixture.workItems.getPlan(secondRun.planId!)?.workflowId).toBe(flow.flowId);
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
    bindCatalogFlow(fixture.catalog, fixture.session.id, flows, "flow_demo_echo");
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
    bindCatalogFlow(fixture.catalog, fixture.session.id, flows, "flow_demo_echo");
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
    bindCatalogFlow(fixture.catalog, fixture.session.id, flows, "flow_demo_echo");
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
    bindCatalogFlow(fixture.catalog, fixture.session.id, flows, "flow_demo_echo");
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

  it("confirms PARAM_RESOLVED when a later turn repeats the same resolved value", async () => {
    const flows = new FlowCatalogStore(":memory:");
    const flow = savePublishedDemoEcho(flows);
    const fixture = setup({ flows });
    bindCatalogFlow(fixture.catalog, fixture.session.id, flows, "flow_demo_echo");
    const first = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "param_same_1",
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
          "Idempotency-Key": "param_same_2",
        },
        body: JSON.stringify({ message: "again", inputs: { text: "hi" } }),
      },
    );
    expect(second.status).toBe(202);
    const workItemId = fixture.workItems.getWorkItemBySessionId(fixture.session.id)!.id;
    const resolved = fixture.workItems.listEvents(workItemId)
      .filter((event) => event.type === "PARAM_RESOLVED");
    expect(resolved).toHaveLength(2);
    expect(resolved[1]?.payload).toMatchObject({
      field: "text",
      candidate_value: "hi",
      final_value: "hi",
      resolution: "confirmed",
      flow_revision: flow.planIrHash,
    });
    flows.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("does not wipe identifiers when a later unbound message reuses the work item", async () => {
    const flows = new FlowCatalogStore(":memory:");
    savePublishedDemoEcho(flows);
    const fixture = setup({ flows });
    bindCatalogFlow(fixture.catalog, fixture.session.id, flows, "flow_demo_echo");
    const bound = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "param_keep",
        },
        body: JSON.stringify({ message: "run", inputs: { text: "hi" } }),
      },
    );
    expect(bound.status).toBe(202);
    fixture.catalog.unbindFlow(fixture.session.id);
    const unbound = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "param_keep_unbound",
        },
        body: JSON.stringify({ message: "freeform" }),
      },
    );
    expect(unbound.status).toBe(202);
    const workItemId = fixture.workItems.getWorkItemBySessionId(fixture.session.id)!.id;
    expect(fixture.workItems.getWorkItem(workItemId)?.identifiers).toEqual({ text: "hi" });
    flows.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("executes a published demo runbook on the session message path without calling the Agent runner", async () => {
    const flows = new FlowCatalogStore(":memory:");
    savePublishedDemoEcho(flows);
    const fixture = setupRuntimeLoop({ flows });
    bindCatalogFlow(fixture.catalog, fixture.session.id, flows, "flow_demo_echo");
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "loop_echo",
        },
        body: JSON.stringify({ message: "run", inputs: { text: "hi" } }),
      },
    );
    expect(response.status).toBe(202);
    expect(fixture.runner.requests).toHaveLength(0);
    const workItemId = fixture.workItems.getWorkItemBySessionId(fixture.session.id)!.id;
    const events = fixture.workItems.listEvents(workItemId);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["PARAM_RESOLVED", "RUN_SNAPSHOT"]),
    );
    expect(fixture.workItems.listRuns(workItemId)[0]?.status).toBe("succeeded");
    const snapshot = events.find((event) => event.type === "RUN_SNAPSHOT");
    expect((snapshot?.payload.steps as Array<{ output_ref: string }>)[0]?.output_ref)
      .toMatch(/^artifact:\/\//);
    flows.close();
    fixture.registry.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("rejects missing runbook inputs without calling FakeRunner or creating a run", async () => {
    const flows = new FlowCatalogStore(":memory:");
    savePublishedDemoEcho(flows);
    const fixture = setupRuntimeLoop({ flows });
    bindCatalogFlow(fixture.catalog, fixture.session.id, flows, "flow_demo_echo");
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "loop_missing",
        },
        body: JSON.stringify({ message: "run" }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "missing_inputs" });
    expect(fixture.runner.requests).toHaveLength(0);
    expect(fixture.workItems.getSessionRuntime(fixture.session.id)?.activeRunId ?? null).toBeNull();
    expect(fixture.catalog.getSession(fixture.session.id)?.taskRecordId ?? null).toBeNull();
    flows.close();
    fixture.registry.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("still calls FakeRunner for an unbound Agent session", async () => {
    const fixture = setupRuntimeLoop();
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      request("hello", "loop_unbound"),
    );
    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(fixture.runner.requests.length).toBeGreaterThanOrEqual(1);
    });
    fixture.registry.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("fails closed on candidate dry-run when a manual step would otherwise call the Agent", async () => {
    const flows = new FlowCatalogStore(":memory:");
    const definition = {
      schema_version: 1,
      workflow_id: "flow_manual_preview",
      name: "manual preview",
      kind: "runbook",
      status: "draft",
      inputs: [],
      steps: [{ id: "ask", mode: "manual", purpose: "confirm" }],
    };
    const plan = compileWorkflow(definition, {
      source: "workflow",
      definitionRevision: definitionHash(definition),
      planId: catalogPlanId("flow_manual_preview"),
    });
    flows.save({
      flowId: "flow_manual_preview",
      name: "manual preview",
      kind: "runbook",
      status: "candidate",
      source: "user_selected",
      definitionRevision: definitionHash(definition),
      planIrHash: definitionHash(plan),
      inputs: plan.inputs,
      steps: [{ id: "ask", mode: "manual", purpose: "confirm" }],
    });
    const fixture = setupRuntimeLoop({ flows });
    bindCatalogFlow(fixture.catalog, fixture.session.id, flows, "flow_manual_preview");
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "loop_manual_dry",
        },
        body: JSON.stringify({ message: "preview", dry_run: true }),
      },
    );
    expect(response.status).toBe(202);
    expect(fixture.runner.requests).toHaveLength(0);
    const workItemId = fixture.workItems.getWorkItemBySessionId(fixture.session.id)!.id;
    expect(fixture.workItems.listRuns(workItemId)[0]?.status).toBe("failed");
    expect(
      fixture.workItems.listEvents(workItemId).some((event) =>
        event.type === "VERIFICATION_FAILED" && event.payload.category === "policy"
      ),
    ).toBe(true);
    flows.close();
    fixture.registry.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("does not persist a candidate flowId onto the session after dry-run", async () => {
    const flows = new FlowCatalogStore(":memory:");
    savePublishedDemoEcho(flows);
    savePublishedDemoEcho(flows, { status: "candidate", flowId: "flow_demo_echo_cand" });
    const fixture = setupRuntimeLoop({ flows });
    expect(fixture.catalog.getSession(fixture.session.id)?.flowId ?? null).toBeNull();
    const unbound = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "loop_cand_dry_unbound",
        },
        body: JSON.stringify({
          message: "preview",
          dry_run: true,
          flow_id: "flow_demo_echo_cand",
          inputs: { text: "hi" },
        }),
      },
    );
    expect(unbound.status).toBe(202);
    expect(fixture.catalog.getSession(fixture.session.id)?.flowId ?? null).toBeNull();

    bindCatalogFlow(fixture.catalog, fixture.session.id, flows, "flow_demo_echo");
    const overlay = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "loop_cand_dry_overlay",
        },
        body: JSON.stringify({
          message: "preview",
          dry_run: true,
          flow_id: "flow_demo_echo_cand",
          inputs: { text: "hi" },
        }),
      },
    );
    expect(overlay.status).toBe(202);
    expect(fixture.catalog.getSession(fixture.session.id)?.flowId).toBe("flow_demo_echo");
    flows.close();
    fixture.registry.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("does not bind an explicit Published Runbook after a live one-shot run", async () => {
    const flows = new FlowCatalogStore(":memory:");
    savePublishedDemoEcho(flows);
    const fixture = setupRuntimeLoop({ flows });
    expect(fixture.catalog.getSession(fixture.session.id)?.flowId ?? null).toBeNull();
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "loop_pub_bind",
        },
        body: JSON.stringify({
          message: "run",
          flow_id: "flow_demo_echo",
          inputs: { text: "hi" },
        }),
      },
    );
    expect(response.status).toBe(202);
    expect(fixture.catalog.getSession(fixture.session.id)).toMatchObject({
      flowId: null,
      flowDefinitionRevision: null,
    });
    flows.close();
    fixture.registry.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("promotes a candidate dry-run to a published run without re-extracting inputs", async () => {
    const flows = new FlowCatalogStore(":memory:");
    savePublishedDemoEcho(flows, { status: "candidate" });
    const fixture = setupRuntimeLoop({ flows });
    bindCatalogFlow(fixture.catalog, fixture.session.id, flows, "flow_demo_echo");
    const preview = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "loop_promote_dry",
        },
        body: JSON.stringify({ message: "preview", dry_run: true, inputs: { text: "hi" } }),
      },
    );
    expect(preview.status).toBe(202);
    const workItemId = fixture.workItems.getWorkItemBySessionId(fixture.session.id)!.id;
    expect(fixture.workItems.getWorkItem(workItemId)?.identifiers).toEqual({ text: "hi" });
    expect(fixture.runner.requests).toHaveLength(0);

    const current = flows.get("flow_demo_echo")!;
    flows.save({
      flowId: current.flowId,
      name: current.name ?? "demo",
      kind: current.kind,
      status: "published",
      source: current.source,
      definitionRevision: current.definitionRevision,
      planIrHash: current.planIrHash,
      inputs: current.inputs,
      steps: current.steps,
    });

    const live = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "loop_promote_live",
        },
        body: JSON.stringify({ message: "run", inputs: { text: "hi" } }),
      },
    );
    expect(live.status).toBe(202);
    expect(fixture.runner.requests).toHaveLength(0);
    expect(fixture.workItems.getWorkItem(workItemId)?.identifiers).toEqual({ text: "hi" });
    expect(fixture.workItems.listRuns(workItemId).every((run) => run.status === "succeeded")).toBe(true);
    const resolved = fixture.workItems.listEvents(workItemId)
      .filter((event) => event.type === "PARAM_RESOLVED");
    expect(resolved.at(-1)?.payload).toMatchObject({
      field: "text",
      candidate_value: "hi",
      final_value: "hi",
      resolution: "confirmed",
    });
    flows.close();
    fixture.registry.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });
});

function savePublishedDemoEcho(
  flows: FlowCatalogStore,
  inputExtra: { default?: string; status?: "candidate" | "published"; flowId?: string } = {},
) {
  const flowId = inputExtra.flowId ?? "flow_demo_echo";
  const definition = {
    schema_version: 1,
    workflow_id: flowId,
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
    planId: catalogPlanId(flowId),
  });
  flows.save({
    flowId,
    name: "demo",
    kind: "runbook",
    status: inputExtra.status ?? "published",
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
  return flows.get(flowId)!;
}

function bindCatalogFlow(
  catalog: SessionCatalogStore,
  sessionId: string,
  flows: FlowCatalogStore,
  flowId: string,
) {
  const record = flows.get(flowId);
  if (!record) throw new Error(`Flow not found: ${flowId}`);
  return catalog.bindFlow(sessionId, {
    flowId,
    definitionRevision: record.definitionRevision,
  });
}
