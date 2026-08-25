import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, RunRequest } from "@codebridge/core";
import type { FlowRecord } from "@codebridge/flow-catalog";
import {
  CapabilityRegistry,
  CapabilityRuntime,
  FunctionCapabilityAdapter,
  PolicyEngine,
} from "@codebridge/policy";
import { RunExecutor } from "@codebridge/run-executor";
import { FlowBatchStore, SqliteEventStore } from "@codebridge/work-items";
import { definitionHash } from "@codebridge/workflow-engine";
import { compileCatalogFlow } from "./flow-compile.js";
import { FlowBatchService } from "./flow-batch-service.js";
import { FlowBatchValidationError } from "./flow-batch-validation.js";

class ForbiddenAgentRunner {
  readonly requests: RunRequest[] = [];
  async *run(request: RunRequest): AsyncGenerator<AgentEvent> {
    this.requests.push(request);
    throw new Error("Batch Runbook must never fall back to the Agent");
  }
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

function publishedFlow(): FlowRecord {
  const flow: FlowRecord = {
    schemaVersion: 1,
    flowId: "flow_batch_verify",
    name: "批量只读核验",
    description: "使用本地内存 capability 验证一组参数。",
    kind: "runbook",
    status: "published",
    source: "user_selected",
    definitionRevision: "sha256:batch-v1",
    planIrHash: null,
    inputs: [
      { id: "oid", type: "integer", source: "user", required: true },
      { id: "region", type: "enum", source: "user", required: true, values: ["cn", "us"] },
      { id: "credential", type: "secret_ref", source: "user" },
    ],
    reviewStatus: "approved",
    gitRevision: null,
    validationIssues: [],
    steps: [{
      id: "verify",
      capability: "test.batch.verify",
      mode: "read_only",
      successWhen: "output.verified == true",
    }],
    lineageRootFlowId: "flow_batch_verify",
    parentFlowId: null,
    provenance: null,
    publicationSequence: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  flow.planIrHash = definitionHash(compileCatalogFlow(flow));
  return flow;
}

function harness(options: { hold?: boolean } = {}) {
  const batches = new FlowBatchStore(":memory:");
  const workItems = new SqliteEventStore(":memory:");
  const capabilities = new CapabilityRegistry();
  const runtime = new CapabilityRuntime();
  const flow = publishedFlow();
  const calls = new Map<number, number>();
  capabilities.register({
    id: "test.batch.verify",
    adapter: "test.batch.verify",
    risk: "read_only",
    side_effects: false,
    source: { kind: "function", ref: "goal-validation" },
  });
  runtime.register(new FunctionCapabilityAdapter("test.batch.verify", ({ input, context }) => {
    const oid = Number(input.oid);
    calls.set(oid, (calls.get(oid) ?? 0) + 1);
    if (options.hold) {
      return new Promise((resolve, reject) => {
        context.signal?.addEventListener("abort", () => reject(new Error("cancelled by test")), { once: true });
        if (context.signal?.aborted) reject(new Error("cancelled by test"));
        void resolve;
      });
    }
    if (oid === 3 && calls.get(oid) === 1) throw new Error("synthetic first-attempt failure");
    return { output: { verified: true, oid, region: input.region } };
  }));
  const runner = new ForbiddenAgentRunner();
  const executor = new RunExecutor(workItems, runner, {
    policy: new PolicyEngine(capabilities),
    capabilities: runtime,
    resolveRequest: (workItem, run) => ({
      runId: run.id,
      sessionKey: { chatId: workItem.conversationId, backendId: "test", cwd: "/tmp" },
      prompt: "must-not-run",
    }),
  });
  const sourceWorkItem = workItems.createWorkItem({
    id: "wi_source", title: "source conversation", mode: "auto",
    conversationId: "conversation_1", sessionId: "session_1", agentId: "codex",
    workspaceScope: ["/tmp"], riskLevel: "read_only",
  });
  const sourceRun = workItems.createRun({
    id: "run_source", workItemId: sourceWorkItem.id, sessionId: "session_1", mode: "auto",
    executionKind: "agent",
  });
  workItems.updateRunStatus(sourceRun.id, "succeeded");
  const service = new FlowBatchService({
    batches,
    workItems,
    flows: { get: (flowId) => flowId === flow.flowId ? flow : undefined },
    executor,
  });
  cleanup.push(() => capabilities.close(), () => batches.close(), () => workItems.close());
  return { batches, workItems, flow, calls, runner, executor, service, sourceRun };
}

describe("conversational Flow batch goal", () => {
  it("turns evidence-backed multi-row input into isolated Runtime Runs and retries only failure", async () => {
    const value = harness();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    try {
      const draft = value.service.createDraft({
        sourceRunId: value.sourceRun.id,
        flowId: value.flow.flowId,
        definitionRevision: value.flow.definitionRevision,
        candidate: {
          global_inputs: { region: "cn" },
          global_evidence: { region: evidence("event:markdown-table#global:region") },
          source_refs: ["event:markdown-table", "attachment:orders.csv", "event:json-block"],
          items: [
            row("markdown-row", "1", "event:markdown-table#line:2"),
            row("csv-row", "2", "attachment:orders.csv#line:3"),
            row("json-row", "3", "event:json-block#/items/0"),
          ],
        },
      });
      expect(draft).toMatchObject({ status: "ready", sessionId: "session_1" });
      expect(draft.sourceRefs).toHaveLength(3);

      const first = await value.service.confirm(draft.draftId, draft.revision, "confirm-once", {
        concurrency: 3, createdBy: "web:local",
      });
      const repeated = await value.service.confirm(draft.draftId, draft.revision, "confirm-once", {
        concurrency: 3, createdBy: "web:local",
      });
      expect(repeated.batch.batchId).toBe(first.batch.batchId);
      expect(value.batches.listBatchItems(first.batch.batchId)).toHaveLength(3);

      await vi.waitFor(async () => {
        await value.service.reconcile(first.batch.batchId);
        expect(value.service.snapshot(first.batch.batchId).status).toBe("partial_succeeded");
      });
      expect(value.service.snapshot(first.batch.batchId).counts).toMatchObject({ succeeded: 2, failed: 1, total: 3 });

      await value.service.retryFailed(first.batch.batchId, "retry-failed-once");
      await vi.waitFor(async () => {
        await value.service.reconcile(first.batch.batchId);
        expect(value.service.snapshot(first.batch.batchId).status).toBe("succeeded");
      });
      const final = value.service.snapshot(first.batch.batchId);
      expect(final.items.map((item) => [item.itemId, item.attempt, item.status])).toEqual([
        ["markdown-row", 1, "succeeded"],
        ["csv-row", 1, "succeeded"],
        ["json-row", 2, "succeeded"],
      ]);
      expect(Object.fromEntries(value.calls)).toEqual({ 1: 1, 2: 1, 3: 2 });
      expect(final.items.every((item) => value.workItems.getRun(item.runId)?.sessionId === null)).toBe(true);
      expect(final.items.every((item) => value.workItems.getRun(item.runId)?.workflowRevision === value.flow.definitionRevision)).toBe(true);

      const restarted = new FlowBatchService({
        batches: value.batches,
        workItems: value.workItems,
        flows: { get: () => value.flow },
        executor: value.executor,
      });
      await restarted.recover();
      expect(Object.fromEntries(value.calls)).toEqual({ 1: 1, 2: 1, 3: 2 });
      expect(value.runner.requests).toHaveLength(0);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it("rejects stale revisions, oversized input and Agent-extracted raw secrets before execution", async () => {
    const value = harness();
    const secretDraft = value.service.createDraft({
      sourceRunId: value.sourceRun.id,
      flowId: value.flow.flowId,
      definitionRevision: value.flow.definitionRevision,
      candidate: {
        global_inputs: { region: "cn" },
        global_evidence: { region: evidence("event:1#region") },
        items: [{
          ...row("secret-row", "9", "event:1"),
          inputs: { oid: "9", credential: "raw-secret" },
          evidence: {
            oid: evidence("event:1"),
            credential: evidence("event:1"),
          },
        }],
      },
    });
    expect(secretDraft.status).toBe("needs_input");
    expect(secretDraft.items[0]?.inputs).not.toHaveProperty("credential");

    expect(() => value.service.createDraft({
      sourceRunId: value.sourceRun.id,
      flowId: value.flow.flowId,
      definitionRevision: value.flow.definitionRevision,
      candidate: {
        global_inputs: { region: "cn" },
        global_evidence: { region: evidence("event:limit#region") },
        items: Array.from({ length: 501 }, (_, index) => row(`row-${index}`, String(index), `event:${index}`)),
      },
    })).toThrowError(expect.objectContaining<Partial<FlowBatchValidationError>>({ code: "batch_limit_exceeded" }));

    const ready = value.service.createDraft({
      sourceRunId: value.sourceRun.id,
      flowId: value.flow.flowId,
      definitionRevision: value.flow.definitionRevision,
      candidate: {
        global_inputs: { region: "cn" },
        global_evidence: { region: evidence("event:stale#region") },
        items: [row("stale", "10", "event:stale")],
      },
    });
    value.flow.definitionRevision = "sha256:batch-v2";
    await expect(value.service.confirm(ready.draftId, ready.revision, "stale", {
      createdBy: "web:local",
    })).rejects.toMatchObject({ code: "flow_revision_mismatch" });
  });

  it("cancels the active item and every queued item, then recovers without relaunching", async () => {
    const value = harness({ hold: true });
    const draft = value.service.createDraft({
      sourceRunId: value.sourceRun.id,
      flowId: value.flow.flowId,
      definitionRevision: value.flow.definitionRevision,
      candidate: {
        global_inputs: { region: "cn" },
        global_evidence: { region: evidence("event:cancel#region") },
        items: [row("one", "1", "event:cancel#1"), row("two", "2", "event:cancel#2"), row("three", "3", "event:cancel#3")],
      },
    });
    const batch = await value.service.confirm(draft.draftId, draft.revision, "cancel-batch", {
      concurrency: 1, createdBy: "web:local",
    });
    expect(batch.counts).toMatchObject({ running: 1, queued: 2 });
    const cancelled = await value.service.cancel(batch.batch.batchId);
    expect(cancelled).toMatchObject({ status: "cancelled", counts: { cancelled: 3, total: 3 } });
    const callsBeforeRecovery = Object.fromEntries(value.calls);
    const restarted = new FlowBatchService({
      batches: value.batches,
      workItems: value.workItems,
      flows: { get: () => value.flow },
      executor: value.executor,
    });
    await restarted.recover();
    expect(Object.fromEntries(value.calls)).toEqual(callsBeforeRecovery);
  });
});

function evidence(reference: string) {
  return { source: "agent_extracted", evidence_ref: reference, inferred: false };
}

function row(itemId: string, oid: string, reference: string) {
  return {
    item_id: itemId,
    inputs: { oid },
    evidence: { oid: evidence(reference) },
  };
}
