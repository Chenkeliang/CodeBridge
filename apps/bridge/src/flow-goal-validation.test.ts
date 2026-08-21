import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, RunRequest } from "@codebridge/core";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import {
  CapabilityRegistry,
  CapabilityRuntime,
  PolicyEngine,
  registerDemoCapabilities,
} from "@codebridge/policy";
import { RunExecutor } from "@codebridge/run-executor";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SessionCoordinator, SessionLeaseService } from "@codebridge/session-coordinator";
import { SqliteEventStore } from "@codebridge/work-items";
import { createFlowApp } from "./flow-api.js";
import { createSessionApp } from "./session-api.js";

class FailingAgentRunner {
  readonly requests: RunRequest[] = [];

  async *run(request: RunRequest): AsyncGenerator<AgentEvent> {
    this.requests.push(request);
    throw new Error("Published Runbook must not fall back to the Agent");
  }
}

const token = "flow-goal-validation";
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};

const anonymousRunbook = {
  flow_id: "flow_catalog_change_simulation",
  name: "商品状态变更方案模拟与验证",
  description: "读取匿名商品参数，生成变更方案，在内存中模拟应用并验证；不连接线上系统。",
  inputs: [
    { id: "product_ids", type: "string", source: "user", required: true },
    { id: "product_type", type: "integer", source: "user", required: true },
    { id: "target_price", type: "integer", source: "user", required: true },
    {
      id: "target_status",
      type: "enum",
      source: "user",
      required: true,
      values: ["enabled", "disabled"],
    },
    {
      id: "environment",
      type: "enum",
      source: "user",
      required: true,
      values: ["simulation"],
      default: "simulation",
    },
  ],
  steps: [
    {
      id: "inspect",
      capability: "demo.catalog.inspect",
      purpose: "读取当前匿名商品状态",
      mode: "read_only",
      success_when: "output.product_ids exists",
    },
    {
      id: "plan",
      capability: "demo.catalog.plan_change",
      purpose: "生成参数化变更方案",
      depends_on: ["inspect"],
      mode: "read_only",
      success_when: "output.change_count > 0",
    },
    {
      id: "simulate",
      capability: "demo.catalog.simulate_apply",
      purpose: "仅在内存中模拟应用",
      depends_on: ["plan"],
      mode: "read_only",
      success_when: "output.simulation == true",
    },
    {
      id: "verify",
      capability: "demo.catalog.verify",
      purpose: "验证模拟结果满足目标",
      depends_on: ["simulate"],
      mode: "read_only",
      success_when: "output.verified == true",
    },
  ],
};

describe("single-goal Flow validation", () => {
  it("creates, dry-runs, reviews, publishes, discovers and reuses one generalized Runbook", async () => {
    const sessions = new SessionCatalogStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    const flows = new FlowCatalogStore(":memory:");
    const capabilities = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    registerDemoCapabilities(capabilities, runtime);
    const coordinator = new SessionCoordinator(events, { maxQueuedTurns: 20 });
    const runner = new FailingAgentRunner();
    const executor = new RunExecutor(events, runner, {
      policy: new PolicyEngine(capabilities),
      capabilities: runtime,
      sessionCoordinator: coordinator,
      sessionLeaseService: new SessionLeaseService(events),
      executorOwner: "test:flow-goal",
      resolveRequest: (workItem, run) => ({
        runId: run.id,
        sessionKey: { chatId: workItem.conversationId, backendId: "pi", cwd: "/workspace" },
        prompt: "unused",
      }),
    });
    const session = sessions.createSession({ agentId: "pi", cwd: "/workspace" });
    const flowApp = createFlowApp(flows, token, { sessions, events, capabilities, runtime });
    const sessionApp = createSessionApp({
      catalog: sessions,
      workItems: events,
      coordinator,
      executor,
      flows,
      capabilities,
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

    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden in Flow validation"));
    try {
      const guideResponse = await flowApp.request("/v1/flows/guides", {
        method: "POST",
        headers,
        body: JSON.stringify({
          flow: {
            name: "商品状态变更经验草稿",
            description: "从一次真实 Agent 工作过程归纳出的稳定步骤。",
            steps: [
              { id: "inspect", purpose: "查询当前状态", depends_on: [] },
              { id: "plan", purpose: "生成变更方案", depends_on: ["inspect"] },
              { id: "simulate", purpose: "模拟应用", depends_on: ["plan"] },
              { id: "verify", purpose: "回查验证", depends_on: ["simulate"] },
            ],
          },
        }),
      });
      expect(guideResponse.status).toBe(201);
      const guide = await guideResponse.json() as { flow_id: string; kind: string; status: string };
      expect(guide).toMatchObject({ kind: "guide", status: "draft" });

      const candidateResponse = await flowApp.request("/v1/flows/candidates", {
        method: "POST",
        headers,
        body: JSON.stringify({
          session_id: session.id,
          flow: { ...anonymousRunbook, parent_flow_id: guide.flow_id },
        }),
      });
      expect(candidateResponse.status).toBe(201);
      const candidate = await candidateResponse.json() as {
        flow_id: string;
        definition_revision: string;
        kind: string;
        status: string;
      };
      expect(candidate).toMatchObject({ kind: "runbook", status: "candidate" });

      const firstInputs = {
        product_ids: "P-1001,P-1002",
        product_type: 66,
        target_price: 12,
        target_status: "enabled",
        environment: "simulation",
      };
      const preview = await invoke(sessionApp, events, session.id, candidate, firstInputs, true, "preview-one");
      expect(preview.status).toBe("succeeded");

      const review = await flowApp.request(`/v1/flows/${candidate.flow_id}/review`, {
        method: "POST",
        headers,
        body: JSON.stringify({ decision: "approve", git_revision: "validation-only" }),
      });
      expect(review.status).toBe(200);
      const published = await review.json() as {
        flow_id: string;
        definition_revision: string;
        kind: string;
        status: string;
      };
      expect(published).toMatchObject({ kind: "runbook", status: "published" });

      const consume = await flowApp.request("/v1/flows?view=consume", { headers });
      expect(consume.status).toBe(200);
      expect(await consume.json()).toMatchObject({
        flows: [expect.objectContaining({ flow_id: published.flow_id, status: "published" })],
      });

      const firstRun = await invoke(sessionApp, events, session.id, published, firstInputs, false, "live-one");
      const secondRun = await invoke(sessionApp, events, session.id, published, {
        product_ids: "P-2001",
        product_type: 88,
        target_price: 20,
        target_status: "disabled",
        environment: "simulation",
      }, false, "live-two");

      expect(verifyOutput(events, firstRun.id)).toMatchObject({
        verified: true,
        product_ids: ["P-1001", "P-1002"],
        target: { price: 12, status: "enabled" },
        simulation: true,
      });
      expect(verifyOutput(events, secondRun.id)).toMatchObject({
        verified: true,
        product_ids: ["P-2001"],
        target: { price: 20, status: "disabled" },
        simulation: true,
      });
      expect(firstRun.planIrHash).toBe(secondRun.planIrHash);
      expect(runner.requests).toHaveLength(0);
      expect(network).not.toHaveBeenCalled();
      expect(runtime.list().every((adapter) => adapter.kind === "function")).toBe(true);
      expect(sessions.getSession(session.id)).toMatchObject({ flowId: null, flowDefinitionRevision: null });
    } finally {
      network.mockRestore();
      capabilities.close();
      flows.close();
      sessions.close();
      events.close();
    }
  });
});

async function invoke(
  app: ReturnType<typeof createSessionApp>,
  events: SqliteEventStore,
  sessionId: string,
  flow: { flow_id: string; definition_revision: string },
  inputs: Record<string, unknown>,
  dryRun: boolean,
  idempotencyKey: string,
) {
  const response = await app.request(`/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": idempotencyKey },
    body: JSON.stringify({
      message: dryRun ? "预演商品状态变更方案" : "执行商品状态变更模拟",
      flow_id: flow.flow_id,
      definition_revision: flow.definition_revision,
      inputs,
      dry_run: dryRun,
    }),
  });
  expect(response.status).toBe(202);
  await vi.waitFor(() => {
    const workItem = events.getWorkItemBySessionId(sessionId);
    expect(workItem).toBeDefined();
    expect(events.listRuns(workItem!.id).at(-1)?.status).toBe("succeeded");
  });
  const workItem = events.getWorkItemBySessionId(sessionId)!;
  return events.listRuns(workItem.id).at(-1)!;
}

function verifyOutput(events: SqliteEventStore, runId: string): Record<string, unknown> {
  const artifact = events.listArtifacts(runId).find((item) => item.name === "verify.output.json");
  if (!artifact) throw new Error(`verify output missing for ${runId}`);
  return JSON.parse(artifact.content) as Record<string, unknown>;
}
