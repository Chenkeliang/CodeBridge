import { isConsumable, type FlowRecord } from "@codebridge/flow-catalog";
import {
  aggregateFlowBatchStatus,
  FlowBatchStore,
  FlowBatchStoreError,
  type FlowBatchChildStatus,
  type FlowBatchDraft,
  type FlowBatchItemRun,
  type FlowBatchRun,
  type FlowBatchStatus,
  type Run,
  type SqliteEventStore,
} from "@codebridge/work-items";
import { definitionHash, type PlanIR } from "@codebridge/workflow-engine";
import { compileCatalogFlow, instantiateCatalogPlan } from "./flow-compile.js";
import {
  FlowBatchValidationError,
  validateFlowBatchDraft,
} from "./flow-batch-validation.js";

export interface FlowBatchRunExecutor {
  execute(runId: string): Promise<Run>;
  cancelRunAndWait(runId: string): Promise<Run>;
}

export interface FlowBatchSnapshotItem extends FlowBatchItemRun {
  status: FlowBatchChildStatus;
  terminalReason: string | null;
}

export interface FlowBatchSnapshot {
  batch: FlowBatchRun;
  status: FlowBatchStatus;
  counts: {
    total: number;
    queued: number;
    running: number;
    waiting: number;
    succeeded: number;
    failed: number;
    cancelled: number;
  };
  items: FlowBatchSnapshotItem[];
}

export type FlowBatchServiceErrorCode =
  | "source_run_not_found"
  | "flow_not_consumable"
  | "flow_revision_mismatch"
  | "plan_ir_drift"
  | "batch_not_found"
  | "batch_retry_empty";

export class FlowBatchServiceError extends Error {
  constructor(
    public readonly code: FlowBatchServiceErrorCode,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "FlowBatchServiceError";
  }
}

type FlowLookup = {
  get(flowId: string): FlowRecord | undefined;
};

export class FlowBatchService {
  private readonly activeExecutions = new Set<string>();
  private readonly reconciliations = new Map<string, Promise<FlowBatchSnapshot>>();

  constructor(private readonly options: {
    batches: FlowBatchStore;
    workItems: SqliteEventStore;
    flows: FlowLookup;
    executor: FlowBatchRunExecutor;
  }) {}

  getDraft(draftId: string): FlowBatchDraft | undefined {
    return this.options.batches.getDraft(draftId);
  }

  listDraftsForSession(sessionId: string): FlowBatchDraft[] {
    return this.options.batches.listDraftsForSession(sessionId);
  }

  cancelDraft(draftId: string): FlowBatchDraft {
    return this.options.batches.cancelDraft(draftId);
  }

  createDraft(input: {
    sessionId?: string;
    sourceRunId: string;
    flowId: string;
    definitionRevision: string;
    candidate: unknown;
  }): FlowBatchDraft {
    const sourceRun = this.options.workItems.getRun(input.sourceRunId);
    if (
      !sourceRun?.sessionId
      || (input.sessionId !== undefined && sourceRun.sessionId !== input.sessionId)
    ) {
      throw new FlowBatchServiceError("source_run_not_found");
    }
    const flow = this.requireCurrentFlow(input.flowId, input.definitionRevision);
    const validated = validateFlowBatchDraft(flow, input.candidate);
    const draft = this.options.batches.createDraft({
      sessionId: sourceRun.sessionId,
      sourceRunId: input.sourceRunId,
      flowId: flow.flowId,
      definitionRevision: flow.definitionRevision,
      ...validated,
    });
    this.appendSourceEvent(draft.sourceRunId, {
      type: "FLOW_BATCH_DRAFTED",
      target: draft.draftId,
      inputHash: `flow-batch:drafted:${draft.draftId}:${draft.revision}`,
      payload: {
        draft_id: draft.draftId,
        flow_id: draft.flowId,
        definition_revision: draft.definitionRevision,
        status: draft.status,
        total: draft.items.length,
        blocking: blockingItemCount(draft),
      },
    });
    return draft;
  }

  updateDraft(input: {
    draftId: string;
    expectedRevision: number;
    candidate: unknown;
  }): FlowBatchDraft {
    const current = this.options.batches.getDraft(input.draftId);
    if (!current) throw new FlowBatchStoreError("batch_draft_not_found");
    const flow = this.requireCurrentFlow(
      current.flowId,
      current.definitionRevision,
    );
    const validated = validateFlowBatchDraft(flow, input.candidate);
    const draft = this.options.batches.replaceDraft({
      draftId: current.draftId,
      expectedRevision: input.expectedRevision,
      ...validated,
    });
    this.appendSourceEvent(draft.sourceRunId, {
      type: "FLOW_BATCH_DRAFTED",
      target: draft.draftId,
      inputHash: `flow-batch:drafted:${draft.draftId}:${draft.revision}`,
      payload: {
        draft_id: draft.draftId,
        flow_id: draft.flowId,
        definition_revision: draft.definitionRevision,
        status: draft.status,
        total: draft.items.length,
        blocking: blockingItemCount(draft),
      },
    });
    return draft;
  }

  async confirm(
    draftId: string,
    expectedRevision: number,
    idempotencyKey: string,
    options: { concurrency?: number; createdBy: string },
  ): Promise<FlowBatchSnapshot> {
    const draft = this.options.batches.getDraft(draftId);
    if (!draft) throw new FlowBatchStoreError("batch_draft_not_found");
    const flow = this.requireCurrentFlow(draft.flowId, draft.definitionRevision);
    const plan = compileCatalogFlow(flow);
    if (definitionHash(plan) !== flow.planIrHash) {
      throw new FlowBatchServiceError("plan_ir_drift", {
        flow_id: flow.flowId,
      });
    }
    const batch = this.options.batches.confirmDraft({
      draftId,
      expectedRevision,
      idempotencyKey,
      planIrHash: flow.planIrHash,
      flowSnapshot: structuredClone(flow) as unknown as Record<string, unknown>,
      concurrency: options.concurrency ?? 3,
      createdBy: options.createdBy,
    });
    this.appendSourceEvent(batch.sourceRunId, {
      type: "FLOW_BATCH_CONFIRMED",
      target: batch.batchId,
      inputHash: `flow-batch:confirmed:${batch.batchId}`,
      payload: {
        batch_id: batch.batchId,
        draft_id: batch.draftId,
        flow_id: batch.flowId,
        definition_revision: batch.definitionRevision,
        status: "queued",
        total: this.options.batches.listBatchItems(batch.batchId).length,
      },
    });
    return this.reconcile(batch.batchId);
  }

  snapshot(batchId: string): FlowBatchSnapshot {
    const batch = this.options.batches.getBatch(batchId);
    if (!batch) throw new FlowBatchServiceError("batch_not_found");
    const items = latestAttempts(
      this.options.batches.listBatchItems(batchId),
    ).map((item): FlowBatchSnapshotItem => {
      if (item.cancelledAt) {
        return { ...item, status: "cancelled", terminalReason: "batch_cancelled" };
      }
      const run = this.options.workItems.getRun(item.runId);
      return {
        ...item,
        status: run?.status ?? "queued",
        terminalReason: run?.terminalReason ?? null,
      };
    });
    const statuses = items.map((item) => item.status);
    const counts = {
      total: items.length,
      queued: statuses.filter((status) => status === "queued").length,
      running: statuses.filter((status) => status === "running").length,
      waiting: statuses.filter((status) => status === "waiting").length,
      succeeded: statuses.filter((status) => status === "succeeded").length,
      failed: statuses.filter((status) =>
        status === "failed" || status === "interrupted"
      ).length,
      cancelled: statuses.filter((status) => status === "cancelled").length,
    };
    return {
      batch,
      status: aggregateFlowBatchStatus(statuses, {
        cancelRequested: Boolean(batch.cancelRequestedAt),
      }),
      counts,
      items,
    };
  }

  reconcile(batchId: string): Promise<FlowBatchSnapshot> {
    const active = this.reconciliations.get(batchId);
    if (active) return active;
    const reconciliation = this.reconcileInner(batchId).finally(() => {
      if (this.reconciliations.get(batchId) === reconciliation) {
        this.reconciliations.delete(batchId);
      }
    });
    this.reconciliations.set(batchId, reconciliation);
    return reconciliation;
  }

  async recover(): Promise<void> {
    for (const batch of this.options.batches.listBatches()) {
      const snapshot = this.snapshot(batch.batchId);
      if (!isTerminalBatchStatus(snapshot.status)) {
        await this.reconcile(batch.batchId);
      }
    }
  }

  async cancel(batchId: string): Promise<FlowBatchSnapshot> {
    this.options.batches.requestBatchCancellation(batchId);
    return this.reconcile(batchId);
  }

  async retryFailed(
    batchId: string,
    idempotencyKey: string,
  ): Promise<FlowBatchSnapshot> {
    const failedItemIds = this.snapshot(batchId).items
      .filter((item) => item.status === "failed" || item.status === "interrupted")
      .map((item) => item.itemId);
    if (failedItemIds.length === 0) {
      throw new FlowBatchServiceError("batch_retry_empty");
    }
    this.options.batches.reserveRetry({
      batchId,
      itemIds: failedItemIds,
      idempotencyKey,
    });
    return this.reconcile(batchId);
  }

  private async reconcileInner(batchId: string): Promise<FlowBatchSnapshot> {
    let snapshot = this.snapshot(batchId);
    if (snapshot.batch.cancelRequestedAt) {
      await this.cancelLatestItems(snapshot);
      snapshot = this.snapshot(batchId);
      this.appendSnapshotEvent(snapshot);
      return snapshot;
    }
    if (isTerminalBatchStatus(snapshot.status)) {
      this.appendSnapshotEvent(snapshot);
      return snapshot;
    }

    const occupied = snapshot.items.filter((item) =>
      item.status === "running"
      || item.status === "waiting"
      || this.activeExecutions.has(item.runId)
    ).length;
    let available = Math.max(0, snapshot.batch.concurrency - occupied);
    for (const item of snapshot.items) {
      if (available === 0) break;
      if (item.status !== "queued" || this.activeExecutions.has(item.runId)) {
        continue;
      }
      this.materialize(snapshot.batch, item);
      this.launch(item.runId, snapshot.batch.batchId);
      available -= 1;
    }
    snapshot = this.snapshot(batchId);
    this.appendSnapshotEvent(snapshot);
    return snapshot;
  }

  private materialize(batch: FlowBatchRun, item: FlowBatchSnapshotItem): Run {
    const existingRun = this.options.workItems.getRun(item.runId);
    if (existingRun) {
      this.options.batches.markItemMaterialized(
        item.batchId,
        item.itemId,
        item.attempt,
      );
      return existingRun;
    }
    const frozenFlow = batch.flowSnapshot as unknown as FlowRecord;
    const compiled = compileCatalogFlow(frozenFlow);
    if (
      definitionHash(compiled) !== batch.planIrHash
      || frozenFlow.definitionRevision !== batch.definitionRevision
    ) {
      throw new FlowBatchServiceError("plan_ir_drift", {
        flow_id: batch.flowId,
      });
    }
    const plan = instantiateCatalogPlan(compiled);
    const sourceRun = this.options.workItems.getRun(batch.sourceRunId);
    const sourceWorkItem = sourceRun
      ? this.options.workItems.getWorkItem(sourceRun.workItemId)
      : undefined;
    if (!this.options.workItems.getWorkItem(item.workItemId)) {
      this.options.workItems.createWorkItem({
        id: item.workItemId,
        title: `${frozenFlow.name ?? frozenFlow.flowId} · ${item.ordinal + 1}`,
        mode: "auto",
        conversationId: `batch:${batch.batchId}`,
        sessionId: null,
        agentId: sourceWorkItem?.agentId ?? null,
        workflowId: batch.flowId,
        workflowRevision: batch.definitionRevision,
        workspaceScope: sourceWorkItem?.workspaceScope ?? [],
        identifiers: item.resolvedInputs,
        riskLevel: maxStepRisk(plan),
      });
    }
    if (!this.options.workItems.getPlan(plan.planId)) {
      this.options.workItems.savePlan({
        ...plan,
        sessionId: null,
        runId: item.runId,
        planIrHash: batch.planIrHash,
      });
    }
    const run = this.options.workItems.createRun({
      id: item.runId,
      workItemId: item.workItemId,
      sessionId: null,
      mode: "auto",
      agentId: sourceWorkItem?.agentId ?? null,
      planId: plan.planId,
      planIrHash: batch.planIrHash,
      workflowRevision: batch.definitionRevision,
    });
    this.options.batches.markItemMaterialized(
      item.batchId,
      item.itemId,
      item.attempt,
    );
    return run;
  }

  private launch(runId: string, batchId: string): void {
    this.activeExecutions.add(runId);
    void this.options.executor.execute(runId)
      .catch(() => undefined)
      .finally(() => {
        this.activeExecutions.delete(runId);
        void this.reconcile(batchId).catch(() => undefined);
      });
  }

  private async cancelLatestItems(snapshot: FlowBatchSnapshot): Promise<void> {
    for (const item of snapshot.items) {
      if (["succeeded", "failed", "interrupted", "cancelled"].includes(item.status)) {
        continue;
      }
      const run = this.options.workItems.getRun(item.runId);
      if (!run) {
        this.options.batches.markItemCancelled(
          item.batchId,
          item.itemId,
          item.attempt,
        );
        continue;
      }
      await this.options.executor.cancelRunAndWait(run.id);
    }
  }

  private requireCurrentFlow(flowId: string, revision: string): FlowRecord {
    const flow = this.options.flows.get(flowId);
    if (!flow || !isConsumable(flow)) {
      throw new FlowBatchServiceError("flow_not_consumable", {
        flow_id: flowId,
      });
    }
    if (flow.definitionRevision !== revision) {
      throw new FlowBatchServiceError("flow_revision_mismatch", {
        flow_id: flowId,
        expected_definition_revision: revision,
        current_definition_revision: flow.definitionRevision,
      });
    }
    return flow;
  }

  private appendSnapshotEvent(snapshot: FlowBatchSnapshot): void {
    const terminal = isTerminalBatchStatus(snapshot.status);
    const digest = definitionHash({
      status: snapshot.status,
      counts: snapshot.counts,
      items: snapshot.items.map((item) => [item.runId, item.status]),
    });
    this.appendSourceEvent(snapshot.batch.sourceRunId, {
      type: terminal ? "FLOW_BATCH_COMPLETED" : "FLOW_BATCH_UPDATED",
      target: snapshot.batch.batchId,
      inputHash: `flow-batch:snapshot:${snapshot.batch.batchId}:${digest}`,
      payload: {
        batch_id: snapshot.batch.batchId,
        draft_id: snapshot.batch.draftId,
        flow_id: snapshot.batch.flowId,
        definition_revision: snapshot.batch.definitionRevision,
        status: snapshot.status,
        counts: snapshot.counts,
      },
    });
  }

  private appendSourceEvent(
    sourceRunId: string,
    event: {
      type:
        | "FLOW_BATCH_DRAFTED"
        | "FLOW_BATCH_CONFIRMED"
        | "FLOW_BATCH_UPDATED"
        | "FLOW_BATCH_COMPLETED";
      target: string;
      inputHash: string;
      payload: Record<string, unknown>;
    },
  ): void {
    const sourceRun = this.options.workItems.getRun(sourceRunId);
    if (!sourceRun) return;
    this.options.workItems.appendEventOnce({
      workItemId: sourceRun.workItemId,
      runId: sourceRun.id,
      type: event.type,
      actor: "system",
      target: event.target,
      inputHash: event.inputHash,
      payload: event.payload,
    });
  }
}

function latestAttempts(items: FlowBatchItemRun[]): FlowBatchItemRun[] {
  const latest = new Map<string, FlowBatchItemRun>();
  for (const item of items) {
    const current = latest.get(item.itemId);
    if (!current || item.attempt > current.attempt) latest.set(item.itemId, item);
  }
  return [...latest.values()].sort((left, right) => left.ordinal - right.ordinal);
}

function blockingItemCount(draft: FlowBatchDraft): number {
  return draft.items.filter((item) =>
    item.issues.some((entry) => entry.blocking)
  ).length;
}

function isTerminalBatchStatus(status: FlowBatchStatus): boolean {
  return ["succeeded", "partial_succeeded", "failed", "cancelled"].includes(status);
}

function maxStepRisk(
  plan: PlanIR,
): "read_only" | "workspace_write" | "git_write" | "production_write" {
  const rank = {
    read_only: 0,
    workspace_write: 1,
    git_write: 2,
    production_write: 3,
  } as const;
  let result: keyof typeof rank = "read_only";
  for (const step of plan.steps) {
    const risk = step.risk as keyof typeof rank;
    if ((rank[risk] ?? 0) > rank[result]) result = risk;
  }
  return result;
}

export function isFlowBatchInputError(
  error: unknown,
): error is FlowBatchStoreError | FlowBatchValidationError | FlowBatchServiceError {
  return error instanceof FlowBatchStoreError
    || error instanceof FlowBatchValidationError
    || error instanceof FlowBatchServiceError;
}
