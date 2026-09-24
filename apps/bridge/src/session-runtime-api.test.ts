import type { AgentEvent, RunRequest } from "@codebridge/core";
import { CapabilityRegistry, CapabilityRuntime, PolicyEngine, registerDemoCapabilities } from "@codebridge/policy";
import { RunExecutor } from "@codebridge/run-executor";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SessionCoordinator, SessionLeaseService } from "@codebridge/session-coordinator";
import { SqliteEventStore } from "@codebridge/work-items";
import { describe, expect, it, vi } from "vitest";
import { createSessionApp } from "./session-api.js";

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

function setupRuntimeLoop() {
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
    resolveRequest: (workItem, run) => {
      return {
        runId: run.id,
        sessionKey: { chatId: workItem.conversationId, backendId: "pi", cwd: "/workspace" },
        prompt: "unused",
      };
    },
  });
  const app = createSessionApp({
    catalog,
    workItems,
    coordinator,
    executor,
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
  return {
    app,
    catalog,
    workItems,
    coordinator,
    session,
    runner,
    registry,
  };
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
  it("re-observes a committed queue resume after a handoff crash", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const fixture = setup({
      executor: { execute } as unknown as RunExecutor,
    });
    const submitted = fixture.coordinator.submitTurn({
      sessionId: fixture.session.id,
      idempotencyKey: "message_1",
      message: {
        text: "检查项目",
        attachmentIds: [],
        executionKind: "agent",
        model: null,
        effort: null,
        permissionMode: null,
        plan: null,
      },
      workItem: {
        title: "Session",
        mode: "auto",
        conversationId: `conv_${fixture.session.id}`,
        agentId: "pi",
        workspaceScope: [],
        riskLevel: "read_only",
      },
    });
    fixture.coordinator.pauseQueue({
      sessionId: fixture.session.id,
      reason: "stale",
    });
    const commandId = "resume:feishu:message-A";
    fixture.coordinator.resumeQueue({
      sessionId: fixture.session.id,
      expectedRuntimeVersion:
        fixture.workItems.getSessionRuntime(fixture.session.id)!.version,
      idempotencyKey: commandId,
    });

    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/queue/resume`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": commandId,
          "if-match": String(
            fixture.workItems.getSessionRuntime(fixture.session.id)!.version,
          ),
        },
        body: "{}",
      },
    );

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      submitted.run!.id,
      undefined,
      { dryRun: undefined },
    );
    fixture.catalog.close();
    fixture.workItems.close();
  });

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

  it("dispatches the next message when the paused queue was empty", async () => {
    const fixture = setup();
    const first = fixture.coordinator.submitTurn({
      sessionId: fixture.session.id,
      idempotencyKey: "message_failed",
      message: {
        text: "失败任务",
        attachmentIds: [],
        executionKind: "agent",
        model: null,
        effort: null,
        permissionMode: null,
        plan: null,
      },
      workItem: {
        title: "Session",
        mode: "auto",
        conversationId: `conv_${fixture.session.id}`,
        agentId: "pi",
        workspaceScope: [],
        riskLevel: "read_only",
      },
    });
    fixture.coordinator.finishRun({
      sessionId: fixture.session.id,
      runId: first.run!.id,
      status: "failed",
      reason: "provider_failed",
    });

    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      request("直接继续", "message_after_pause"),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      acceptance: "dispatched",
      turn: { status: "dispatched" },
      runtime: {
        queue_state: "ready",
        queue_pause_reason: null,
        active_run: { status: "queued" },
        queue: { total: 0 },
      },
    });
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

  it("rejects a delivery without an explicit boolean thinking snapshot", async () => {
    const fixture = setup();
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": "invalid-delivery-thinking",
        },
        body: JSON.stringify({
          message: "hello",
          delivery: {
            channel: "feishu",
            conversation_id: "chat-1|",
            reply_to_message_id: "message-1",
            show_thinking: "false",
          },
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_delivery" });
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
    const workItemId = fixture.workItems.getWorkItemBySessionId(fixture.session.id)!.id;
    expect(fixture.workItems.listRuns(workItemId).at(-1)?.executionKind).toBe("agent");
    fixture.registry.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });
});
