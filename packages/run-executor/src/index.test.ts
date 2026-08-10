import { describe, expect, it } from "vitest";
import type { AgentEvent, RunRequest } from "@codebridge/core";
import { SqliteEventStore } from "@codebridge/work-items";
import { ApprovalService, CapabilityRegistry, PolicyEngine } from "@codebridge/policy";
import { RunExecutor } from "./index.js";

class FakeRunner {
  readonly prompts: string[] = [];
  constructor(private readonly events: AgentEvent[], private readonly fail = false) {}

  async *run(request: RunRequest): AsyncGenerator<AgentEvent> {
    this.prompts.push(request.prompt);
    for (const event of this.events) yield event;
    if (this.fail) throw new Error("runner offline");
  }
}

function setup() {
  const store = new SqliteEventStore(":memory:");
  const item = store.createWorkItem({
    title: "Investigate",
    mode: "investigation",
    conversationId: "web:conversation",
    agentId: "pi-investigator",
    workspaceScope: ["/tmp/project"],
    riskLevel: "read_only",
  });
  const run = store.createRun({ workItemId: item.id, mode: item.mode });
  return { store, item, run };
}

describe("RunExecutor", () => {
  it("executes a queued run and persists Agent events and terminal state", async () => {
    const { store, item, run } = setup();
    const runner = new FakeRunner([
      { type: "text_delta", text: "调查结果" },
      { type: "done", exitCode: 0 },
    ]);
    const executor = new RunExecutor(store, runner, {
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: {
          chatId: item.conversationId,
          backendId: "pi",
          cwd: "/tmp/project",
        },
        prompt: "调查",
      }),
    });

    const result = await executor.execute(run.id);
    expect(result.status).toBe("succeeded");
    expect(store.getRun(run.id)?.status).toBe("succeeded");
    expect(store.getWorkItem(item.id)?.status).toBe("completed");
    expect(store.listEvents(item.id).map((event) => event.type)).toEqual([
      "WORK_ITEM_CREATED",
      "RUN_CREATED",
      "RUN_STARTED",
      "STEP_STARTED",
      "AGENT_EVENT",
      "AGENT_EVENT",
      "STEP_SUCCEEDED",
      "RUN_SUCCEEDED",
      "WORK_ITEM_COMPLETED",
    ]);
    store.close();
  });

  it("marks a run failed when the Runner stream errors", async () => {
    const { store, item, run } = setup();
    const executor = new RunExecutor(store, new FakeRunner([], true), {
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: { chatId: item.conversationId, backendId: "pi", cwd: "/tmp/project" },
        prompt: "调查",
      }),
    });

    await expect(executor.execute(run.id)).rejects.toThrow("runner offline");
    expect(store.getRun(run.id)?.status).toBe("failed");
    expect(store.getWorkItem(item.id)?.status).toBe("failed");
    store.close();
  });

  it("pauses production work until a scoped approval is granted", async () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "release",
      mode: "release",
      conversationId: "web:release",
      riskLevel: "production_write",
    });
    const run = store.createRun({ workItemId: item.id, mode: item.mode });
    const approvals = new ApprovalService(store, ":memory:");
    const executor = new RunExecutor(store, new FakeRunner([{ type: "done", exitCode: 0 }]), {
      approvals,
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: { chatId: item.conversationId, backendId: "pi", cwd: "/tmp/project" },
        prompt: "发布",
      }),
    });

    expect((await executor.execute(run.id)).status).toBe("waiting");
    const approval = approvals.listForRun(run.id)[0];
    expect(approval?.status).toBe("requested");
    approvals.grant(approval!.id, "user");
    store.requeueRun(run.id);
    expect((await executor.execute(run.id)).status).toBe("succeeded");
    expect(approvals.get(approval!.id)?.status).toBe("consumed");
    approvals.close();
    store.close();
  });

  it("executes a persisted Plan one dependency-ordered step at a time", async () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "planned change",
      mode: "change",
      conversationId: "web:planned",
      riskLevel: "workspace_write",
    });
    const plan = store.savePlan({
      planId: "plan_ordered",
      source: "workflow",
      workflowId: "review-change",
      definitionRevision: "git:abc",
      steps: [
        {
          id: "change",
          capabilityId: "workspace.change",
          risk: "workspace_write",
          dependsOn: ["inspect"],
          guard: null,
          approval: "none",
          branches: [],
          purpose: null,
        },
        {
          id: "inspect",
          capabilityId: "context.inspect",
          risk: "read_only",
          dependsOn: [],
          guard: null,
          approval: "none",
          branches: [],
          purpose: null,
        },
      ],
    });
    const run = store.createRun({ workItemId: item.id, mode: item.mode, planId: plan.planId });
    const runner = new FakeRunner([{ type: "done", exitCode: 0 }]);
    const executor = new RunExecutor(store, runner, {
      resolveRequest: (_workItem, _run, step) => ({
        runId: run.id,
        sessionKey: { chatId: item.conversationId, backendId: "pi", cwd: "/tmp/project" },
        prompt: `step:${step?.id}`,
      }),
    });

    expect((await executor.execute(run.id)).status).toBe("succeeded");
    expect(runner.prompts).toEqual(["step:inspect", "step:change"]);
    expect(store.listEvents(item.id).filter((event) => event.type === "STEP_STARTED").map((event) => event.target)).toEqual(["inspect", "change"]);
    expect(store.listEvents(item.id).filter((event) => event.type === "STEP_SUCCEEDED").map((event) => event.target)).toEqual(["inspect", "change"]);
    store.close();
  });

  it("rejects a planned step that is absent from the Capability Registry", async () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "unknown capability",
      mode: "investigation",
      conversationId: "web:policy",
      riskLevel: "read_only",
    });
    const plan = store.savePlan({
      planId: "plan_policy",
      source: "workflow",
      workflowId: "policy-flow",
      definitionRevision: "git:policy",
      steps: [{
        id: "inspect",
        capabilityId: "missing.inspect",
        risk: "read_only",
        dependsOn: [],
        guard: null,
        approval: "none",
        branches: [],
        purpose: null,
      }],
    });
    const run = store.createRun({ workItemId: item.id, mode: item.mode, planId: plan.planId });
    const capabilities = new CapabilityRegistry();
    const executor = new RunExecutor(store, new FakeRunner([{ type: "done", exitCode: 0 }]), {
      policy: new PolicyEngine(capabilities),
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: { chatId: item.conversationId, backendId: "pi", cwd: "/tmp/project" },
        prompt: "inspect",
      }),
    });

    await expect(executor.execute(run.id)).rejects.toThrow("Unknown capability: missing.inspect");
    expect(store.getRun(run.id)?.status).toBe("failed");
    capabilities.close();
    store.close();
  });

  it("selects a structured branch and skips the unselected path", async () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "branch",
      mode: "investigation",
      conversationId: "web:branch",
      identifiers: { ready: true },
      riskLevel: "read_only",
    });
    const plan = store.savePlan({
      planId: "plan_branch",
      source: "workflow",
      workflowId: "branch-flow",
      definitionRevision: "git:branch",
      steps: [
        {
          id: "decision",
          capabilityId: null,
          risk: "read_only",
          dependsOn: [],
          guard: null,
          approval: "none",
          branches: [
            { when: "ready == true", next: "ready-path" },
            { when: "default", next: "fallback-path" },
          ],
          purpose: null,
        },
        {
          id: "fallback-path",
          capabilityId: "fallback.inspect",
          risk: "read_only",
          dependsOn: [],
          guard: null,
          approval: "none",
          branches: [],
          purpose: null,
        },
        {
          id: "ready-path",
          capabilityId: "ready.inspect",
          risk: "read_only",
          dependsOn: [],
          guard: null,
          approval: "none",
          branches: [],
          purpose: null,
        },
      ],
    });
    const run = store.createRun({ workItemId: item.id, mode: item.mode, planId: plan.planId });
    const runner = new FakeRunner([{ type: "done", exitCode: 0 }]);
    const executor = new RunExecutor(store, runner, {
      resolveRequest: (_workItem, _run, step) => ({
        runId: run.id,
        sessionKey: { chatId: item.conversationId, backendId: "pi", cwd: "/tmp/project" },
        prompt: `step:${step?.id}`,
      }),
    });

    expect((await executor.execute(run.id)).status).toBe("succeeded");
    expect(runner.prompts).toEqual(["step:ready-path"]);
    expect(store.listEvents(item.id).find((event) => event.type === "BRANCH_SELECTED")).toMatchObject({
      target: "decision",
      payload: { when: "ready == true", next: "ready-path" },
    });
    expect(store.listEvents(item.id).find((event) => event.type === "STEP_SKIPPED")).toMatchObject({
      target: "fallback-path",
    });
    store.close();
  });
});
