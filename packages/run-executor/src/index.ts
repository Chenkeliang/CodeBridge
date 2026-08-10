import { createHash } from "node:crypto";
import type { AgentEvent, RunRequest } from "@codebridge/core";
import type { ApprovalService } from "@codebridge/policy";
import {
  SqliteEventStore,
  type Run,
  type WorkItem,
  type PersistedPlan,
  type PersistedPlanStep,
} from "@codebridge/work-items";

export interface RunnerStream {
  run(
    request: RunRequest,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<AgentEvent>;
}

export interface RunExecutorOptions {
  resolveRequest: (workItem: WorkItem, run: Run, step?: PersistedPlanStep) => RunRequest | Promise<RunRequest>;
  onEvent?: (run: Run, event: AgentEvent) => void;
  approvals?: ApprovalService;
}

export class RunExecutor {
  constructor(
    private readonly store: SqliteEventStore,
    private readonly runner: RunnerStream,
    private readonly options: RunExecutorOptions,
  ) {}

  async execute(runId: string, signal?: AbortSignal): Promise<Run> {
    const initial = this.store.getRun(runId);
    if (!initial) throw new Error(`Run not found: ${runId}`);
    if (initial.status !== "queued") return initial;
    const workItem = this.store.getWorkItem(initial.workItemId);
    if (!workItem) throw new Error(`WorkItem not found: ${initial.workItemId}`);
    const plan = initial.planId ? this.store.getPlan(initial.planId) : undefined;
    if (initial.planId && !plan) throw new Error(`Plan not found: ${initial.planId}`);

    if (!plan && workItem.riskLevel === "production_write") {
      if (!this.options.approvals) {
        throw new Error("Approval service is required for production_write runs");
      }
      const inputHash = `sha256:${hashInput(workItem.id, runId, workItem.title)}`;
      const existing = this.options.approvals
        .listForRun(runId)
        .find((approval) => approval.stepId === "run" && approval.inputHash === inputHash);
      if (!existing || existing.status !== "granted") {
        if (!existing || existing.status === "expired" || existing.status === "revoked" || existing.status === "consumed") {
          this.options.approvals.request({
            workItemId: workItem.id,
            runId,
            stepId: "run",
            capabilityId: "run.production",
            inputHash,
            requestedBy: "system",
          });
        }
        this.store.updateRunStatus(runId, "waiting");
        return this.store.getRun(runId)!;
      }
      if (!this.options.approvals.consume(existing.id, runId, "run", inputHash)) {
        this.store.updateRunStatus(runId, "waiting");
        return this.store.getRun(runId)!;
      }
    }

    this.store.updateRunStatus(runId, "running");
    if (!this.hasRunEvent(workItem.id, runId, "RUN_STARTED")) {
      this.store.appendEvent({
        workItemId: workItem.id,
        runId,
        type: "RUN_STARTED",
        actor: "system",
        target: runId,
      });
    }

    try {
      if (plan) {
        const waiting = await this.executePlan(workItem, initial, plan, signal);
        if (waiting) return this.store.getRun(runId)!;
      } else {
        this.store.appendEvent({
          workItemId: workItem.id,
          runId,
          type: "STEP_STARTED",
          actor: "system",
          target: runId,
        });
        await this.executeStep(workItem, initial, null, signal);
        this.store.appendEvent({
          workItemId: workItem.id,
          runId,
          type: "STEP_SUCCEEDED",
          actor: "system",
          target: runId,
        });
      }
      if (signal?.aborted) return this.cancel(runId, workItem.id);
      this.store.updateRunStatus(runId, "succeeded");
      this.store.appendEvent({
        workItemId: workItem.id,
        runId,
        type: "RUN_SUCCEEDED",
        actor: "system",
        target: runId,
      });
      this.store.appendEvent({
        workItemId: workItem.id,
        runId,
        type: "WORK_ITEM_COMPLETED",
        actor: "system",
        target: runId,
      });
      return this.store.getRun(runId)!;
    } catch (error) {
      if (signal?.aborted) return this.cancel(runId, workItem.id);
      this.store.updateRunStatus(runId, "failed");
      this.store.appendEvent({
        workItemId: workItem.id,
        runId,
        type: "STEP_FAILED",
        actor: "system",
        target: plan ? this.failedStepId(workItem.id, runId) : runId,
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
      this.store.appendEvent({
        workItemId: workItem.id,
        runId,
        type: "RUN_FAILED",
        actor: "system",
        target: runId,
      });
      throw error;
    }
  }

  private cancel(runId: string, workItemId: string): Run {
    this.store.updateRunStatus(runId, "cancelled");
    this.store.appendEvent({
      workItemId,
      runId,
      type: "RUN_CANCELLED",
      actor: "system",
      target: runId,
    });
    return this.store.getRun(runId)!;
  }

  private async executePlan(
    workItem: WorkItem,
    run: Run,
    plan: PersistedPlan,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const completed = new Set(
      this.store
        .listEvents(workItem.id)
        .filter((event) => event.runId === run.id && event.type === "STEP_SUCCEEDED")
        .map((event) => event.target)
        .filter((target): target is string => Boolean(target)),
    );
    for (const step of orderSteps(plan.steps)) {
      if (completed.has(step.id)) continue;
      if (!step.dependsOn.every((dependency) => completed.has(dependency))) {
        throw new Error(`Plan dependency is not complete for step ${step.id}`);
      }
      if (step.approval === "required" || step.risk === "production_write") {
        const inputHash = `sha256:${hashInput(workItem.id, run.id, workItem.title, step.id)}`;
        const existing = this.options.approvals
          ?.listForRun(run.id)
          .find((approval) => approval.stepId === step.id && approval.inputHash === inputHash);
        if (!existing || existing.status !== "granted") {
          if (!existing || ["expired", "revoked", "consumed"].includes(existing.status)) {
            if (!this.options.approvals) throw new Error(`Approval service is required for step ${step.id}`);
            this.options.approvals.request({
              workItemId: workItem.id,
              runId: run.id,
              stepId: step.id,
              capabilityId: step.capabilityId ?? `manual.${step.id}`,
              inputHash,
              requestedBy: "system",
            });
          }
          this.store.updateRunStatus(run.id, "waiting");
          return true;
        }
        if (!this.options.approvals!.consume(existing.id, run.id, step.id, inputHash)) {
          this.store.updateRunStatus(run.id, "waiting");
          return true;
        }
      }
      this.store.appendEvent({
        workItemId: workItem.id,
        runId: run.id,
        type: "STEP_STARTED",
        actor: "system",
        target: step.id,
        payload: { capability_id: step.capabilityId, risk: step.risk },
      });
      await this.executeStep(workItem, run, step, signal);
      this.store.appendEvent({
        workItemId: workItem.id,
        runId: run.id,
        type: "STEP_SUCCEEDED",
        actor: "system",
        target: step.id,
      });
      completed.add(step.id);
    }
    return false;
  }

  private async executeStep(
    workItem: WorkItem,
    run: Run,
    step: PersistedPlanStep | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const request = await this.options.resolveRequest(workItem, run, step ?? undefined);
    for await (const event of this.runner.run(request, { signal })) {
      this.options.onEvent?.(run, event);
      this.store.appendEvent({
        workItemId: workItem.id,
        runId: run.id,
        type: "AGENT_EVENT",
        actor: "adapter",
        target: event.type,
        payload: step ? { event, step_id: step.id } : { event },
      });
      if (event.type === "done" && event.exitCode !== 0) {
        throw new Error(`Runner exited with code ${event.exitCode}`);
      }
    }
  }

  private hasRunEvent(workItemId: string, runId: string, type: string): boolean {
    return this.store.listEvents(workItemId).some((event) => event.runId === runId && event.type === type);
  }

  private failedStepId(workItemId: string, runId: string): string {
    return this.store
      .listEvents(workItemId)
      .filter((event) => event.runId === runId && event.type === "STEP_STARTED")
      .at(-1)?.target ?? runId;
  }
}

function hashInput(workItemId: string, runId: string, title: string, stepId?: string): string {
  return createHash("sha256")
    .update(`${workItemId}:${runId}:${title}:${stepId ?? "run"}`)
    .digest("hex");
}

function orderSteps(steps: PersistedPlanStep[]): PersistedPlanStep[] {
  const pending = new Map(steps.map((step) => [step.id, step]));
  const ordered: PersistedPlanStep[] = [];
  while (pending.size) {
    const next = [...pending.values()].find((step) => step.dependsOn.every((dependency) => ordered.some((item) => item.id === dependency)));
    if (!next) throw new Error("Plan contains an unresolved dependency");
    ordered.push(next);
    pending.delete(next.id);
  }
  return ordered;
}
