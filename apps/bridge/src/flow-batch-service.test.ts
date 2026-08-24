import { afterEach, describe, expect, it } from "vitest";
import type { FlowRecord } from "@codebridge/flow-catalog";
import {
  FlowBatchStore,
  SqliteEventStore,
  type Run,
} from "@codebridge/work-items";
import { definitionHash } from "@codebridge/workflow-engine";
import { compileCatalogFlow } from "./flow-compile.js";
import { FlowBatchService, type FlowBatchRunExecutor } from "./flow-batch-service.js";

interface Deferred {
  resolve: (run: Run) => void;
  reject: (error: Error) => void;
}

class FakeExecutor implements FlowBatchRunExecutor {
  readonly started: string[] = [];
  private readonly deferred = new Map<string, Deferred>();

  constructor(private readonly workItems: SqliteEventStore) {}

  execute(runId: string): Promise<Run> {
    if (!this.started.includes(runId)) this.started.push(runId);
    const current = this.workItems.getRun(runId)!;
    if (current.status === "queued") this.workItems.updateRunStatus(runId, "running");
    return new Promise<Run>((resolve, reject) => {
      this.deferred.set(runId, { resolve, reject });
    });
  }

  async cancelRunAndWait(runId: string): Promise<Run> {
    const run = this.workItems.updateRunStatus(runId, "cancelled");
    this.deferred.get(runId)?.resolve(run);
    return run;
  }

  succeed(runId: string): void {
    const run = this.workItems.updateRunStatus(runId, "succeeded");
    this.deferred.get(runId)?.resolve(run);
  }

  fail(runId: string): void {
    const run = this.workItems.updateRunStatus(runId, "failed");
    this.deferred.get(runId)?.resolve(run);
  }

  startCount(runId: string): number {
    return this.started.filter((value) => value === runId).length;
  }
}

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

function publishedFlow(): FlowRecord {
  const flow: FlowRecord = {
    schemaVersion: 1,
    flowId: "flow_batch_echo",
    name: "批量核验",
    description: null,
    kind: "runbook",
    status: "published",
    source: "user_selected",
    definitionRevision: "sha256:def",
    planIrHash: null,
    inputs: [{ id: "oid", type: "integer", source: "user", required: true }],
    reviewStatus: "approved",
    gitRevision: null,
    validationIssues: [],
    steps: [{
      id: "lookup",
      capability: "demo.lookup",
      mode: "read_only",
      successWhen: "output.found exists",
    }],
    lineageRootFlowId: "flow_batch_echo",
    parentFlowId: null,
    provenance: null,
    publicationSequence: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  flow.planIrHash = definitionHash(compileCatalogFlow(flow));
  return flow;
}

function harness(itemCount = 3, concurrency = 2) {
  const batches = new FlowBatchStore(":memory:");
  const workItems = new SqliteEventStore(":memory:");
  cleanup.push(() => batches.close(), () => workItems.close());
  const sourceWorkItem = workItems.createWorkItem({
    id: "wi_source",
    title: "source",
    mode: "auto",
    conversationId: "conv_batch",
    sessionId: "sess_batch",
    agentId: "codex",
    workspaceScope: ["/tmp/workspace"],
    riskLevel: "read_only",
  });
  const sourceRun = workItems.createRun({
    id: "run_source",
    workItemId: sourceWorkItem.id,
    sessionId: "sess_batch",
    mode: "auto",
  });
  workItems.updateRunStatus(sourceRun.id, "succeeded");
  const flow = publishedFlow();
  const executor = new FakeExecutor(workItems);
  const service = new FlowBatchService({
    batches,
    workItems,
    flows: { get: (flowId) => flowId === flow.flowId ? flow : undefined },
    executor,
  });
  const draft = batches.createDraft({
    sessionId: "sess_batch",
    sourceRunId: sourceRun.id,
    flowId: flow.flowId,
    definitionRevision: flow.definitionRevision,
    status: "ready",
    globalInputs: {},
    items: Array.from({ length: itemCount }, (_, ordinal) => ({
      itemId: `item_${ordinal + 1}`,
      ordinal,
      label: null,
      inputs: { oid: ordinal + 1 },
      evidence: {},
      issues: [],
    })),
    sourceRefs: ["event:source"],
  });
  return { batches, workItems, flow, executor, service, draft, concurrency };
}

describe("FlowBatchService", () => {
  it("materializes one ordinary Runtime Run per item and respects concurrency", async () => {
    const value = harness(3, 2);
    const batch = await value.service.confirm(
      value.draft.draftId,
      value.draft.revision,
      "confirm-1",
      { concurrency: value.concurrency, createdBy: "web:local" },
    );

    expect(value.batches.listBatchItems(batch.batch.batchId)).toHaveLength(3);
    expect(value.executor.started).toHaveLength(2);
    expect(batch.counts).toMatchObject({ total: 3, running: 2, queued: 1 });

    value.executor.succeed(value.executor.started[0]!);
    await value.service.reconcile(batch.batch.batchId);
    expect(value.executor.started).toHaveLength(3);
    expect(value.batches.listBatchItems(batch.batch.batchId).every((item) =>
      value.workItems.getRun(item.runId)?.sessionId === null
    )).toBe(true);
  });

  it("does not recreate a succeeded child after service restart", async () => {
    const value = harness(2, 1);
    const batch = await value.service.confirm(
      value.draft.draftId,
      value.draft.revision,
      "confirm-1",
      { concurrency: 1, createdBy: "web:local" },
    );
    const firstRunId = value.executor.started[0]!;
    value.executor.succeed(firstRunId);
    await value.service.reconcile(batch.batch.batchId);

    const restarted = new FlowBatchService({
      batches: value.batches,
      workItems: value.workItems,
      flows: { get: () => value.flow },
      executor: value.executor,
    });
    await restarted.recover();

    expect(value.executor.startCount(firstRunId)).toBe(1);
  });

  it("retries only the latest failed item", async () => {
    const value = harness(2, 2);
    const batch = await value.service.confirm(
      value.draft.draftId,
      value.draft.revision,
      "confirm-1",
      { concurrency: 2, createdBy: "web:local" },
    );
    value.executor.succeed(value.executor.started[0]!);
    value.executor.fail(value.executor.started[1]!);
    await value.service.reconcile(batch.batch.batchId);

    const retried = await value.service.retryFailed(batch.batch.batchId, "retry-1");
    expect(retried.items.filter((item) => item.attempt === 2)).toHaveLength(1);
    expect(retried.counts.total).toBe(2);
    expect(value.batches.listBatchItems(batch.batch.batchId)).toHaveLength(3);
  });

  it("cancels queued and active items without executing a new item", async () => {
    const value = harness(3, 1);
    const batch = await value.service.confirm(
      value.draft.draftId,
      value.draft.revision,
      "confirm-1",
      { concurrency: 1, createdBy: "web:local" },
    );
    const cancelled = await value.service.cancel(batch.batch.batchId);

    expect(cancelled.status).toBe("cancelled");
    expect(value.executor.started).toHaveLength(1);
    expect(cancelled.counts.cancelled).toBe(3);
  });
});
