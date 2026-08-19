import { createHash } from "node:crypto";
import type { AgentEvent, RunRequest } from "@codebridge/core";
import type {
  SessionCoordinator,
  SessionLeaseService,
} from "@codebridge/session-coordinator";
import type {
  ApprovalService,
  CapabilityRuntime,
  PolicyEngine,
  CapabilityExecutionResult,
} from "@codebridge/policy";
import {
  SqliteEventStore,
  type AppendEventInput,
  type Attribution,
  type ReplaySafety,
  type Run,
  type RunSnapshotPayload,
  type WorkItem,
  type PersistedPlan,
  type PersistedPlanStep,
  type DecisionTraceStep as SnapshotTraceStep,
  type VerificationFailedPayload,
} from "@codebridge/work-items";
import { evaluatePostcondition } from "@codebridge/workflow-engine";
import { AgentEventAggregator } from "./agent-event-aggregator.js";
import { RunHeartbeat } from "./run-heartbeat.js";

const PROVIDER_LEASE_MS = 60_000;

class ProviderSessionBusyError extends Error {
  constructor() {
    super("provider_session_busy");
    this.name = "ProviderSessionBusyError";
  }
}

class ProviderSessionOccupiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderSessionOccupiedError";
  }
}

function isProviderSessionOccupiedMessage(message: string): boolean {
  return message.includes("已被另一个 Runner 任务占用")
    || message.includes("正在运行；请等待当前任务结束");
}

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
  policy?: PolicyEngine;
  capabilities?: CapabilityRuntime;
  dryRun?: boolean;
  sessionCoordinator?: SessionCoordinator;
  sessionLeaseService?: SessionLeaseService;
  executorOwner?: string;
  now?: () => Date;
}

export interface DecisionTraceStep {
  step_id: string;
  capability_id: string | null;
  input: Record<string, unknown>;
  verification_status: "passed" | "failed" | "skipped";
}

export interface ReplayDiff {
  identical: boolean;
  original: DecisionTraceStep[];
  replayed: DecisionTraceStep[];
  diffs: string[];
}

interface SnapshotStepDraft {
  step_id: string;
  capability_id: string;
  capability_revision: string;
  output: unknown;
  verification_status: "passed" | "failed" | "skipped";
}

export class RunExecutor {
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly activeCompletions = new Map<string, Promise<void>>();
  private readonly activeAsyncErrors = new Map<string, unknown>();
  private readonly activeProviderSessions = new Map<
    string,
    { agentId: string; providerSessionId: string }
  >();
  private readonly stepOutputs = new Map<string, Record<string, unknown>>();
  private readonly snapshotDrafts = new Map<string, SnapshotStepDraft[]>();
  private currentForce = false;
  private currentDryRun = false;

  constructor(
    private readonly store: SqliteEventStore,
    private readonly runner: RunnerStream,
    private readonly options: RunExecutorOptions,
  ) {}

  private claimProviderSession(
    agentId: string,
    providerSessionId: string,
    runId: string,
  ): boolean {
    const now = new Date();
    const claimed = this.store.claimProviderSession({
      agentId,
      providerSessionId,
      runId,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + PROVIDER_LEASE_MS).toISOString(),
    });
    if (claimed) {
      this.activeProviderSessions.set(runId, { agentId, providerSessionId });
    }
    return claimed;
  }

  private renewProviderSession(runId: string): boolean {
    const active = this.activeProviderSessions.get(runId);
    if (!active) return true;
    return this.store.renewProviderSession({
      agentId: active.agentId,
      providerSessionId: active.providerSessionId,
      runId,
      expiresAt: new Date(Date.now() + PROVIDER_LEASE_MS).toISOString(),
    });
  }

  cancelRun(runId: string): Run {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(run.status)) return run;
    this.activeControllers.get(runId)?.abort();
    return run.sessionId ? run : this.cancel(run);
  }

  async cancelRunAndWait(runId: string): Promise<Run> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
    const controller = this.activeControllers.get(runId);
    const completion = this.activeCompletions.get(runId);
    if (!controller || !completion) return this.cancelRun(runId);
    controller.abort();
    await completion;
    const result = this.store.getRun(runId)!;
    if (result.status === "failed") {
      throw new Error("Runner cancellation failed");
    }
    return result;
  }

  /** Replay a frozen plan with dry-run side effects, returning the decision trace. */
  async replayPlan(plan: PersistedPlan, inputs: Record<string, unknown>): Promise<DecisionTraceStep[]> {
    const trace: DecisionTraceStep[] = [];
    for (const step of orderSteps(plan.steps)) {
      if (!step.capabilityId) continue;
      const definition = this.options.policy?.getCapability(step.capabilityId);
      if (!definition || !this.options.capabilities || !this.options.capabilities.has(definition.adapter)) {
        throw new Error("unknown_capability");
      }
      const result = await this.options.capabilities.execute(definition.adapter, {
        input: { ...inputs, step: { id: step.id, purpose: step.purpose } },
        context: { dry_run: true, environment: step.risk === "production_write" ? "production" : "local" },
      });
      // Replay must mirror B2's definition of "verification result": a
      // successWhen postcondition is evaluated, not just adapter self-report.
      const verificationStatus = step.successWhen
        ? (evaluatePostcondition(step.successWhen, result.output) ? "passed" : "failed")
        : (result.verification?.status ?? "passed");
      trace.push({
        step_id: step.id,
        capability_id: step.capabilityId,
        input: { ...inputs, step: { id: step.id, purpose: step.purpose } },
        verification_status: verificationStatus,
      });
    }
    return trace;
  }

  diffTrace(original: DecisionTraceStep[], replayed: DecisionTraceStep[]): ReplayDiff {
    const diffs: string[] = [];
    const identical = original.length === replayed.length && original.every((step, index) => {
      const replayedStep = replayed[index];
      const same = replayedStep !== undefined && JSON.stringify(step) === JSON.stringify(replayedStep);
      if (!same) {
        diffs.push(`step ${index} (${step.step_id}): original ${JSON.stringify(step)} vs replayed ${JSON.stringify(replayedStep)}`);
      }
      return same;
    });
    return { identical, original, replayed, diffs };
  }

  async execute(runId: string, signal?: AbortSignal, options?: { force?: boolean; dryRun?: boolean }): Promise<Run> {
    this.currentForce = options?.force ?? false;
    this.currentDryRun = options?.dryRun ?? this.options.dryRun === true;
    const initial = this.store.getRun(runId);
    if (!initial) throw new Error(`Run not found: ${runId}`);
    if (initial.status !== "queued") return initial;
    const workItem = this.store.getWorkItem(initial.workItemId);
    if (!workItem) throw new Error(`WorkItem not found: ${initial.workItemId}`);
    const plan = initial.planId ? this.store.getPlan(initial.planId) : undefined;
    if (initial.planId && !plan) throw new Error(`Plan not found: ${initial.planId}`);
    if (plan && runHasIr(initial) && plan.planIrHash && initial.planIrHash !== plan.planIrHash) {
      throw new Error(`Plan IR drift: run ${runId} bound ${initial.planIrHash} but plan resolves to ${plan.planIrHash}`);
    }
    if (initial.sessionId) {
      this.requireSessionExecutionOptions();
      const claimed = this.options.sessionLeaseService!.claim(
        runId,
        this.options.executorOwner!,
      );
      if (!claimed) return this.store.getRun(runId)!;
    }

    if (!plan && workItem.riskLevel === "production_write") {
      this.throwIfCancellationRequested(runId);
      if (!this.options.approvals) {
        throw new Error("Approval service is required for production_write runs");
      }
      const approvalScope = approvalScopeFor(workItem, runId, undefined, "production");
      const inputHash = `sha256:${hashInput(approvalScope)}`;
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
            ...approvalScope,
            inputHash,
            requestedBy: "system",
          });
        }
        this.throwIfCancellationRequested(runId);
        return this.markWaiting(initial);
      }
      if (!this.options.approvals.consume(existing.id, runId, "run", inputHash)) {
        this.throwIfCancellationRequested(runId);
        return this.markWaiting(initial);
      }
      this.throwIfCancellationRequested(runId);
    }

    // Task 9 resume 路径：确定会进入 Runner 之后、调 Runner 前才 claim，
    // 避免审批 markWaiting 提前 return 时留下未释放的 lease。
    if (initial.sessionId && initial.providerSessionId && initial.agentId) {
      const providerClaimed = this.claimProviderSession(
        initial.agentId,
        initial.providerSessionId,
        runId,
      );
      if (!providerClaimed) {
        return this.interrupt(initial, "provider_session_busy");
      }
    }

    if (!initial.sessionId) this.store.updateRunStatus(runId, "running");
    if (!this.hasRunEvent(workItem.id, runId, "RUN_STARTED")) {
      this.appendRunEvent(initial, {
        workItemId: workItem.id,
        runId,
        type: "RUN_STARTED",
        actor: "system",
        target: runId,
      });
    }

    const controller = new AbortController();
    const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let leaseLost = false;
    let providerLeaseLost = false;
    const heartbeat = initial.sessionId
      ? new RunHeartbeat({
          runId,
          owner: this.options.executorOwner!,
          renew: (id, owner) => {
            const renewed = this.options.sessionLeaseService!.renew(id, owner);
            if (!renewed) return null;
            if (!this.renewProviderSession(runId)) {
              // 只标记失败 + abort + 停表，终态由主路径唯一调用 finishRun。
              providerLeaseLost = true;
              controller.abort();
              return null;
            }
            return renewed;
          },
          onLeaseLost: () => {
            leaseLost = true;
            controller.abort();
          },
        })
      : null;
    let completeExecution!: () => void;
    const completion = new Promise<void>((resolve) => {
      completeExecution = resolve;
    });
    this.activeControllers.set(runId, controller);
    this.activeCompletions.set(runId, completion);
    heartbeat?.start();
    try {
      this.throwIfCancellationRequested(runId);
      if (plan) {
        const waiting = await this.executePlan(workItem, initial, plan, activeSignal);
        if (waiting) return this.store.getRun(runId)!;
      } else {
        this.appendRunEvent(initial, {
          workItemId: workItem.id,
          runId,
          type: "STEP_STARTED",
          actor: "system",
          target: runId,
        });
        await this.executeStep(workItem, initial, null, activeSignal);
        if (activeSignal.aborted) {
          if (providerLeaseLost) return this.interrupt(initial, "provider_session_busy");
          if (leaseLost) return this.store.getRun(runId)!;
          return this.cancel(initial);
        }
        this.throwIfCancellationRequested(runId);
        this.appendRunEvent(initial, {
          workItemId: workItem.id,
          runId,
          type: "STEP_SUCCEEDED",
          actor: "system",
          target: runId,
        });
      }
      if (activeSignal.aborted) {
        if (providerLeaseLost) return this.interrupt(initial, "provider_session_busy");
        if (leaseLost) return this.store.getRun(runId)!;
        return this.cancel(initial);
      }
      this.throwIfCancellationRequested(runId);
      return this.succeed(initial);
    } catch (error) {
      const failure = this.activeAsyncErrors.get(runId) ?? error;
      if (providerLeaseLost) {
        return this.interrupt(initial, "provider_session_busy");
      }
      if (leaseLost || isRunLeaseLost(failure)) {
        return this.store.getRun(runId)!;
      }
      if (
        failure instanceof ProviderSessionBusyError
        || failure instanceof ProviderSessionOccupiedError
      ) {
        return this.interrupt(initial, "provider_session_busy");
      }
      if (failure instanceof UnsafeProviderDisconnect) {
        return this.interrupt(
          initial,
          failure.boundary === "outcome_unknown"
            ? "provider_disconnect_unknown_outcome"
            : "provider_disconnect_after_side_effect_boundary",
        );
      }
      if (
        initial.sessionId
        && activeSignal.aborted
        && isRunnerCancellationError(failure)
      ) {
        throw failure;
      }
      if (
        failure instanceof RunCancellationRequested
        || (activeSignal.aborted && !isRunnerCancellationError(failure))
      ) {
        controller.abort();
        return this.cancel(initial);
      }
      this.appendRunEvent(initial, {
        workItemId: workItem.id,
        runId,
        type: "STEP_FAILED",
        actor: "system",
        target: plan ? this.failedStepId(workItem.id, runId) : runId,
        payload: {
          error: failure instanceof Error
            ? failure.message
            : String(failure),
        },
      });
      this.fail(initial, failure);
      throw failure;
    } finally {
      this.currentDryRun = false;
      heartbeat?.close();
      this.stepOutputs.delete(runId);
      this.snapshotDrafts.delete(runId);
      this.activeAsyncErrors.delete(runId);
      this.activeProviderSessions.delete(runId);
      if (this.activeControllers.get(runId) === controller) this.activeControllers.delete(runId);
      completeExecution();
      if (this.activeCompletions.get(runId) === completion) {
        this.activeCompletions.delete(runId);
      }
    }
  }

  private succeed(run: Run): Run {
    this.emitRunSnapshot(run, "succeeded");
    if (run.sessionId) {
      return this.options.sessionCoordinator!.finishRun({
        sessionId: run.sessionId,
        runId: run.id,
        status: "succeeded",
      }).run;
    }
    this.store.updateRunStatus(run.id, "succeeded");
    this.appendRunEvent(run, {
      workItemId: run.workItemId,
      runId: run.id,
      type: "RUN_SUCCEEDED",
      actor: "system",
      target: run.id,
    });
    this.appendRunEvent(run, {
      workItemId: run.workItemId,
      runId: run.id,
      type: "WORK_ITEM_COMPLETED",
      actor: "system",
      target: run.id,
    });
    return this.store.getRun(run.id)!;
  }

  private fail(run: Run, error: unknown): Run {
    this.emitRunSnapshot(run, "failed");
    if (run.sessionId) {
      return this.options.sessionCoordinator!.finishRun({
        sessionId: run.sessionId,
        runId: run.id,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      }).run;
    }
    this.store.updateRunStatus(run.id, "failed");
    this.store.appendEvent({
      workItemId: run.workItemId,
      runId: run.id,
      type: "RUN_FAILED",
      actor: "system",
      target: run.id,
      payload: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return this.store.getRun(run.id)!;
  }

  private markWaiting(run: Run): Run {
    return run.sessionId
      ? this.store.updateRunControl(run.id, {
          status: "waiting",
          leaseOwner: null,
          leaseExpiresAt: null,
        })
      : this.store.updateRunStatus(run.id, "waiting");
  }

  private dropPoisonedProviderSession(run: Run): Run {
    if (!run.sessionId) return { ...run, providerSessionId: null };
    const sessionId = run.sessionId;
    const agentId = run.agentId;
    const providerSessionId = run.providerSessionId;
    this.store.withSessionTransaction((tx) => {
      if (agentId && providerSessionId) {
        tx.releaseProviderSession({
          agentId,
          providerSessionId,
          runId: run.id,
        });
      }
      tx.updateRun(run.id, { providerSessionId: null });
      tx.setSessionProviderSessionId(sessionId, null);
    });
    this.activeProviderSessions.delete(run.id);
    return { ...run, providerSessionId: null };
  }

  private interrupt(run: Run, reason: string): Run {
    if (run.sessionId) {
      return this.options.sessionCoordinator!.finishRun({
        sessionId: run.sessionId,
        runId: run.id,
        status: "interrupted",
        reason,
      }).run;
    }
    this.store.updateRunControl(run.id, {
      status: "interrupted",
      terminalReason: reason,
    });
    this.store.appendEvent({
      workItemId: run.workItemId,
      runId: run.id,
      type: "RUN_INTERRUPTED",
      actor: "system",
      target: run.id,
      payload: { reason },
    });
    return this.store.getRun(run.id)!;
  }

  private cancel(run: Run): Run {
    const current = this.store.getRun(run.id);
    if (current?.status === "cancelled") return current;
    if (run.sessionId) {
      return this.options.sessionCoordinator!.finishRun({
        sessionId: run.sessionId,
        runId: run.id,
        status: "cancelled",
        reason: "cancel_requested",
      }).run;
    }
    this.store.updateRunStatus(run.id, "cancelled");
    this.store.appendEvent({
      workItemId: run.workItemId,
      runId: run.id,
      type: "RUN_CANCELLED",
      actor: "system",
      target: run.id,
    });
    return this.store.getRun(run.id)!;
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
    const skipped = new Set(
      this.store
        .listEvents(workItem.id)
        .filter((event) => event.runId === run.id && event.type === "STEP_SKIPPED")
        .map((event) => event.target)
        .filter((target): target is string => Boolean(target)),
    );
    for (const step of orderSteps(plan.steps)) {
      if (completed.has(step.id) || skipped.has(step.id)) continue;
      const dependencies = dependenciesFor(step, plan.steps);
      if (!dependencies.every((dependency) => completed.has(dependency) || skipped.has(dependency))) {
        throw new Error(`Plan dependency is not complete for step ${step.id}`);
      }
      if (dependencies.length && dependencies.every((dependency) => skipped.has(dependency))) {
        this.skipStep(run, step.id, { reason: "dependency_skipped" });
        skipped.add(step.id);
        continue;
      }
      if (step.branches.length) {
        if (signal?.aborted) return false;
        const selected = selectBranch(step, workItem.identifiers);
        if (!selected) throw new Error(`No branch matched for step ${step.id}`);
        this.appendRunEvent(run, {
          workItemId: workItem.id,
          runId: run.id,
          type: "STEP_STARTED",
          actor: "system",
          target: step.id,
          payload: { capability_id: null, risk: step.risk },
        });
        this.appendRunEvent(run, {
          workItemId: workItem.id,
          runId: run.id,
          type: "BRANCH_SELECTED",
          actor: "system",
          target: step.id,
          payload: { when: selected.when, next: selected.next },
        });
        for (const branch of step.branches) {
          if (branch.next === selected.next || skipped.has(branch.next)) continue;
          this.skipStep(run, branch.next, {
            reason: "branch_not_selected",
            branch_step_id: step.id,
            selected: selected.next,
          });
          skipped.add(branch.next);
        }
        if (signal?.aborted) return false;
        this.appendRunEvent(run, {
          workItemId: workItem.id,
          runId: run.id,
          type: "STEP_SUCCEEDED",
          actor: "system",
          target: step.id,
        });
        completed.add(step.id);
        continue;
      }
      const policyDecision = step.capabilityId && this.options.policy
        ? this.options.policy.evaluate(step.capabilityId, {
            environment: step.risk === "production_write" ? "production" : "local",
          })
        : undefined;
      if (policyDecision && !policyDecision.allowed && !policyDecision.requiresApproval) {
        if (policyDecision.reason === "unknown_capability") {
          this.throwUnknownCapability(run, step);
        }
        throw new Error(`Capability is not allowed in this environment: ${step.capabilityId}`);
      }
      if (
        step.approval === "required" ||
        step.risk === "production_write" ||
        (policyDecision && !policyDecision.allowed && policyDecision.requiresApproval)
      ) {
        this.throwIfCancellationRequested(run.id);
        const environment = step.risk === "production_write" ? "production" : "local";
        const approvalScope = approvalScopeFor(workItem, run.id, step, environment);
        const inputHash = `sha256:${hashInput(approvalScope)}`;
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
              ...approvalScope,
              inputHash,
              requestedBy: "system",
            });
          }
          this.throwIfCancellationRequested(run.id);
          this.markWaiting(run);
          return true;
        }
        if (!this.options.approvals!.consume(existing.id, run.id, step.id, inputHash)) {
          this.throwIfCancellationRequested(run.id);
          this.markWaiting(run);
          return true;
        }
        this.throwIfCancellationRequested(run.id);
      }
      this.appendRunEvent(run, {
        workItemId: workItem.id,
        runId: run.id,
        type: "STEP_STARTED",
        actor: "system",
        target: step.id,
        payload: { capability_id: step.capabilityId, risk: step.risk },
      });
      await this.executeStep(workItem, run, step, signal);
      if (signal?.aborted) return false;
      this.appendRunEvent(run, {
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

  private skipStep(
    run: Run,
    stepId: string,
    payload: Record<string, unknown>,
  ): void {
    this.appendRunEvent(run, {
      workItemId: run.workItemId,
      runId: run.id,
      type: "STEP_SKIPPED",
      actor: "system",
      target: stepId,
      payload,
    });
  }

  private async executeStep(
    workItem: WorkItem,
    run: Run,
    step: PersistedPlanStep | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const maxAttempts = step?.retry?.maxAttempts ?? 1;
    const delayMs = step?.retry?.delayMs ?? 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.executeStepOnce(workItem, run, step, signal);
        return;
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableError(error)) {
          if (step && isRetryableError(error) && attempt >= maxAttempts) {
            const capped = capActual(error instanceof Error ? error.message : String(error));
            this.appendVerificationFailed(run, step.id, {
              category: "infrastructure",
              postcondition: "",
              actual: capped.actual,
              truncated: capped.truncated,
            });
            this.recordSnapshotStep(run, step, {
              output: { error: error instanceof Error ? error.message : String(error) },
              verification_status: "failed",
            });
          }
          throw error;
        }
        this.store.appendEvent({
          workItemId: workItem.id,
          runId: run.id,
          type: "STEP_RETRYING",
          actor: "system",
          target: step?.id ?? run.id,
          payload: {
            attempt,
            next_attempt: attempt + 1,
            max_attempts: maxAttempts,
            delay_ms: delayMs,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        await retryDelay(delayMs, signal);
      }
    }
  }

  private async executeStepOnce(
    workItem: WorkItem,
    run: Run,
    step: PersistedPlanStep | null,
    signal?: AbortSignal,
  ): Promise<void> {
    this.throwIfCancellationRequested(run.id);
    const capabilityResult = await this.executeCapability(workItem, run, step, signal);
    this.throwIfCancellationRequested(run.id);
    if (step?.capabilityId) {
      if (!capabilityResult || capabilityResult.forwardToAgent) {
        this.throwUnknownCapability(run, step);
      }
      if (step.successWhen) {
        const passed = evaluatePostcondition(step.successWhen, capabilityResult.output);
        if (!passed) {
          const capped = capActual(capabilityResult.output);
          this.recordSnapshotStep(run, step, {
            output: capabilityResult.output,
            verification_status: "failed",
          });
          this.appendVerificationFailed(run, step.id, {
            category: "verification",
            postcondition: step.successWhen,
            actual: capped.actual,
            truncated: capped.truncated,
          });
          throw new Error(`Postcondition failed for step ${step.id}: ${step.successWhen}`);
        }
      }
      const outputs = this.stepOutputs.get(run.id) ?? {};
      this.stepOutputs.set(run.id, { ...outputs, [step.id]: capabilityResult.output });
      this.recordSnapshotStep(run, step, {
        output: capabilityResult.output,
        verification_status: "passed",
      });
      return;
    }
    let request = await this.options.resolveRequest(workItem, run, step ?? undefined);
    const latestMessage = this.store
      .listEvents(workItem.id)
      .reverse()
      .find((event) => event.type === "MESSAGE_RECEIVED");
    const attachmentIds = Array.isArray(latestMessage?.payload.attachment_ids)
      ? latestMessage.payload.attachment_ids.filter((id): id is string => typeof id === "string")
      : [];
    const messageAttachments = this.store.listMessageAttachments(workItem.id, attachmentIds).map((attachment) => ({
      name: attachment.name,
      mimeType: attachment.mimeType,
      dataBase64: attachment.dataBase64,
    }));
    if (messageAttachments.length) {
      request = { ...request, attachments: [...(request.attachments ?? []), ...messageAttachments] };
    }
    this.throwIfCancellationRequested(run.id);
    let replaySafety =
      this.store.getRun(run.id)?.replaySafety ?? "safe";
    let droppedOccupiedResume = false;
    const persistAgentEvent = (event: AgentEvent): void => {
      this.throwIfCancellationRequested(run.id);
      // provider lease 丢失后，persist 入口直接拒绝写入（不依赖 runner 尊重 abort）。
      if (signal?.aborted) {
        throw new RunCancellationRequested();
      }
      if (
        event.type === "error"
        && event.fatal
        && isProviderSessionOccupiedMessage(event.message)
      ) {
        throw new ProviderSessionOccupiedError(event.message);
      }
      // Task 9 fresh 路径：首个 session 事件到达时，persist 前原子
      // updateRun(providerSessionId) + claim；失败则中断本 run，不 append AGENT_EVENT。
      if (
        event.type === "session"
        && event.sessionId
        && run.sessionId
        && run.agentId
        && !run.providerSessionId
      ) {
        const agentId = run.agentId;
        const sessionId = run.sessionId;
        const claimed = this.store.withSessionTransaction((tx) => {
          const now = new Date();
          const ok = tx.claimProviderSession({
            agentId,
            providerSessionId: event.sessionId,
            runId: run.id,
            now: now.toISOString(),
            expiresAt: new Date(now.getTime() + PROVIDER_LEASE_MS).toISOString(),
          });
          if (!ok) return false;
          // claim 成功才写 identity；失败时事务内无写，return false 不会留下脏 runtime。
          tx.updateRun(run.id, { providerSessionId: event.sessionId });
          tx.setSessionProviderSessionId(sessionId, event.sessionId);
          return true;
        });
        if (!claimed) {
          throw new ProviderSessionBusyError();
        }
        run = { ...run, providerSessionId: event.sessionId };
        this.activeProviderSessions.set(run.id, {
          agentId,
          providerSessionId: event.sessionId,
        });
      }
      const nextReplaySafety = replaySafetyAfterEvent(
        replaySafety,
        event,
      );
      if (nextReplaySafety !== replaySafety) {
        replaySafety = nextReplaySafety;
        this.updateReplaySafety(run, replaySafety);
      }
      this.appendRunEvent(run, {
        workItemId: workItem.id,
        runId: run.id,
        type: "AGENT_EVENT",
        actor: "adapter",
        target: event.type,
        payload: step ? { event, step_id: step.id } : { event },
      });
      this.options.onEvent?.(run, event);
      this.throwIfCancellationRequested(run.id);
      if (event.type === "plan" && event.entries.length) {
        const flowId = `flow_ephemeral_${run.id}`;
        const flowSteps = event.entries.map((entry, index) => ({
          id: `step_${index + 1}`,
          mode: "manual",
          purpose: entry.content,
          depends_on: index ? [`step_${index}`] : [],
          approval: "none",
        }));
        this.appendRunEvent(run, {
          workItemId: workItem.id,
          runId: run.id,
          type: "FLOW_PROPOSED",
          actor: "agent",
          target: flowId,
          payload: {
            source: "agent_generated",
            definition_revision: `agent:${contentHash(workItem.id, run.id, workItem.title)}`,
            flow: {
              schema_version: 1,
              workflow_id: flowId,
              name: "Agent proposed plan",
              kind: "guide",
              status: "draft",
              steps: flowSteps,
            },
          },
        });
      }
      if (event.type === "done" && event.exitCode !== 0) {
        throw new Error(`Runner exited with code ${event.exitCode}`);
      }
    };
    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
      const attempt = this.store.startRunAttempt(run.id);
      const aggregator = new AgentEventAggregator({
        runId: run.id,
        emit: persistAgentEvent,
        onError: (error) => {
          this.activeAsyncErrors.set(run.id, error);
          this.activeControllers.get(run.id)?.abort();
        },
      });
      try {
        for await (const event of this.runner.run(request, { signal })) {
          aggregator.accept(event);
        }
        const asynchronousError = this.activeAsyncErrors.get(run.id);
        if (asynchronousError) throw asynchronousError;
        aggregator.close();
        this.store.finishRunAttempt(attempt.attemptId, {
          providerError: null,
          sideEffectBoundary: replaySafety,
        });
        return;
      } catch (error) {
        try {
          aggregator.close();
        } catch (flushError) {
          error = flushError;
        }
        this.store.finishRunAttempt(attempt.attemptId, {
          providerError: error instanceof Error
            ? error.message
            : String(error),
          sideEffectBoundary: replaySafety,
        });
        if (
          error instanceof ProviderSessionOccupiedError
          && request.resumeSessionId
          && !droppedOccupiedResume
        ) {
          droppedOccupiedResume = true;
          run = this.dropPoisonedProviderSession(run);
          request = { ...request, resumeSessionId: undefined };
          continue;
        }
        if (!isProviderTransportError(error)) throw error;
        if (replaySafety !== "safe") {
          throw new UnsafeProviderDisconnect(error, replaySafety);
        }
        if (attemptNumber === 3) throw error;
        await retryDelay(500 * 2 ** (attemptNumber - 1), signal);
      }
    }
  }

  private async executeCapability(
    workItem: WorkItem,
    run: Run,
    step: PersistedPlanStep | null,
    signal?: AbortSignal,
  ): Promise<CapabilityExecutionResult | undefined> {
    this.throwIfCancellationRequested(run.id);
    if (!step || !step.capabilityId) return undefined;
    if (!this.options.capabilities || !this.options.policy) {
      this.throwUnknownCapability(run, step);
    }
    const definition = this.options.policy.getCapability(step.capabilityId);
    if (!definition || !this.options.capabilities.has(definition.adapter)) {
      this.throwUnknownCapability(run, step);
    }
    // namespace "flow-step" is deliberately separate from the HTTP idempotency
    // keys ("session:run:*") stored in the same idempotency_responses table.
    const idem = definition.idempotency;
    let idemKey: string | undefined;
    if (idem && !this.currentForce && step.risk !== "read_only") {
      idemKey = idempotencyKey(workItem, step, idem.key);
      const prior = this.store.getIdempotencyRecord("flow-step", idemKey);
      if (prior !== undefined && idempotencyRecordFresh(prior.createdAt, idem.validity_window, this.clock())) {
        return prior.response as CapabilityExecutionResult;
      }
      if (prior !== undefined) {
        this.store.deleteIdempotencyResponse("flow-step", idemKey);
      }
    }
    const capabilityBoundary: ReplaySafety =
      definition.side_effects === false
        ? "side_effect_started"
        : "outcome_unknown";
    this.updateReplaySafety(run, capabilityBoundary);
    const result = await this.options.capabilities.execute(definition.adapter, {
      input: {
        ...this.resolvedValues(workItem),
        step_outputs: this.stepOutputs.get(run.id) ?? {},
        step: { id: step.id, purpose: step.purpose },
      },
      context: {
        cwd: workItem.workspaceScope[0],
        environment: step.risk === "production_write" ? "production" : "local",
        runId: run.id,
        stepId: step.id,
        signal,
        dry_run: this.currentDryRun,
      },
    });
    this.throwIfCancellationRequested(run.id);
    if (idem && idemKey && step.risk !== "read_only") {
      this.store.putIdempotencyResponse("flow-step", idemKey, result, this.clock().toISOString());
    }
    const artifactIds = (result.artifacts ?? []).map((artifact) => this.store.createArtifact({
      workItemId: workItem.id,
      runId: run.id,
      stepId: step.id,
      name: artifact.name,
      content: artifact.content,
      mimeType: artifact.mimeType,
      kind: artifact.kind,
      metadata: artifact.metadata,
      actor: "adapter",
    }).id);
    const verification = result.verification
      ? this.store.recordVerification({
          workItemId: workItem.id,
          runId: run.id,
          stepId: step.id,
          validator: result.verification.validator,
          status: result.verification.status,
          summary: result.verification.summary,
          artifactIds,
        })
      : undefined;
    this.appendRunEvent(run, {
      workItemId: workItem.id,
      runId: run.id,
      type: "AGENT_EVENT",
      actor: "adapter",
      target: step.capabilityId,
      resultRef: artifactIds[0] ? `artifact://${artifactIds[0]}` : verification?.id ? `verification://${verification.id}` : null,
      payload: {
        adapter: definition.adapter,
        capability_id: step.capabilityId,
        output: result.output,
        artifact_ids: artifactIds,
        verification_id: verification?.id,
        retryable: result.retryable ?? false,
      },
    });
    return result;
  }

  private appendRunEvent(run: Run, input: AppendEventInput): void {
    if (run.sessionId) {
      this.store.appendLeasedRunEvent(this.options.executorOwner!, {
        ...input,
        runId: run.id,
        sessionId: run.sessionId,
      });
      return;
    }
    this.store.appendEvent(input);
  }

  private clock(): Date {
    return this.options.now?.() ?? new Date();
  }

  private capabilityRevision(capabilityId: string): string {
    return this.options.policy?.getCapability(capabilityId)?.source?.version ?? "1";
  }

  private recordSnapshotStep(
    run: Run,
    step: PersistedPlanStep,
    draft: Pick<SnapshotStepDraft, "output" | "verification_status">,
  ): void {
    if (!step.capabilityId) return;
    const next: SnapshotStepDraft = {
      step_id: step.id,
      capability_id: step.capabilityId,
      capability_revision: this.capabilityRevision(step.capabilityId),
      output: draft.output,
      verification_status: draft.verification_status,
    };
    const steps = this.snapshotDrafts.get(run.id) ?? [];
    const index = steps.findIndex((item) => item.step_id === step.id);
    if (index >= 0) steps[index] = next;
    else steps.push(next);
    this.snapshotDrafts.set(run.id, steps);
  }

  private appendVerificationFailed(
    run: Run,
    stepId: string,
    payload: Omit<VerificationFailedPayload, "step_id">,
  ): void {
    this.appendRunEvent(run, {
      workItemId: run.workItemId,
      runId: run.id,
      type: "VERIFICATION_FAILED",
      actor: "adapter",
      target: stepId,
      payload: { step_id: stepId, ...payload },
    });
  }

  private throwUnknownCapability(run: Run, step: PersistedPlanStep): never {
    this.appendVerificationFailed(run, step.id, {
      category: "policy",
      postcondition: "unknown_capability",
      actual: null,
      truncated: false,
    });
    this.recordSnapshotStep(run, step, {
      output: { error: "unknown_capability" },
      verification_status: "failed",
    });
    throw new Error("unknown_capability");
  }

  private emitRunSnapshot(run: Run, outcome: "succeeded" | "failed"): void {
    if (!runHasIr(run)) return;
    const workItem = this.store.getWorkItem(run.workItemId);
    if (!workItem) return;
    const plan = run.planId ? this.store.getPlan(run.planId) : undefined;
    const drafts = this.snapshotDrafts.get(run.id) ?? [];
    const steps: SnapshotTraceStep[] = drafts.map((draft) => {
      const artifact = this.store.createArtifact({
        workItemId: workItem.id,
        runId: run.id,
        stepId: draft.step_id,
        name: `${draft.step_id}.output.json`,
        content: JSON.stringify(draft.output ?? null),
        mimeType: "application/json",
        kind: "output",
        actor: "system",
      });
      return {
        step_id: draft.step_id,
        capability_id: draft.capability_id,
        capability_revision: draft.capability_revision,
        output_ref: `artifact://${artifact.id}`,
        verification_status: draft.verification_status,
      };
    });
    const capability_revisions: Record<string, string> = {};
    for (const step of plan?.steps ?? []) {
      if (!step.capabilityId) continue;
      capability_revisions[step.capabilityId] = this.capabilityRevision(step.capabilityId);
    }
    for (const draft of drafts) {
      capability_revisions[draft.capability_id] = draft.capability_revision;
    }
    const attribution: Attribution = {
      flow_revision: plan?.planIrHash ?? run.planIrHash ?? "",
      prompt_revision: sha256Utf8("codebridge:unbound-prompt"),
      tool_schema_revision: sha256Utf8("codebridge:unbound-tools"),
      capability_revisions,
      resolver_revision: "v1",
      authorization_revision: sha256Utf8("codebridge:unbound-auth"),
    };
    const payload: RunSnapshotPayload = {
      flow_id: plan?.workflowId ?? workItem.workflowId ?? "",
      flow_revision: attribution.flow_revision,
      resolved_inputs: Object.entries(workItem.identifiers).map(([field, value]) => ({
        field,
        value,
        source: "user",
        resolver_version: "v1",
      })),
      steps,
      outcome,
      attribution,
    };
    this.appendRunEvent(run, {
      workItemId: workItem.id,
      runId: run.id,
      type: "RUN_SNAPSHOT",
      actor: "system",
      target: run.id,
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  private updateReplaySafety(
    run: Run,
    replaySafety: ReplaySafety,
  ): void {
    if (run.sessionId) {
      this.store.updateLeasedRunReplaySafety(
        run.id,
        this.options.executorOwner!,
        replaySafety,
      );
      return;
    }
    this.store.updateRunControl(run.id, { replaySafety });
  }

  private requireSessionExecutionOptions(): void {
    if (
      !this.options.sessionCoordinator
      || !this.options.sessionLeaseService
      || !this.options.executorOwner
    ) {
      throw new Error(
        "Session-bound Runs require a Coordinator, lease service, and executor owner",
      );
    }
  }

  private throwIfCancellationRequested(runId: string): void {
    if (this.store.getRun(runId)?.cancelRequestedAt) {
      throw new RunCancellationRequested();
    }
  }

  private resolvedValues(workItem: WorkItem): Record<string, unknown> {
    return workItem.identifiers;
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

interface ApprovalScope {
  sessionId: string;
  environment: string;
  targetResource: string;
  input: Record<string, unknown>;
}

class RunCancellationRequested extends Error {
  constructor() {
    super("run_cancellation_requested");
  }
}

class UnsafeProviderDisconnect extends Error {
  constructor(
    public readonly cause: unknown,
    public readonly boundary: Exclude<ReplaySafety, "safe">,
  ) {
    super(
      cause instanceof Error
        ? cause.message
        : "Provider disconnected after a side-effect boundary",
    );
  }
}

function replaySafetyAfterEvent(
  current: ReplaySafety,
  event: AgentEvent,
): ReplaySafety {
  if (current === "outcome_unknown") return current;
  if (event.type === "tool_start" && event.sideEffects !== false) {
    return "outcome_unknown";
  }
  if (event.type === "tool_start") return "side_effect_started";
  if (event.type === "tool_end" && event.sideEffects === true) {
    return "outcome_unknown";
  }
  return current;
}

function isRunLeaseLost(error: unknown): boolean {
  return error instanceof Error && error.message === "run_lease_lost";
}

function isProviderTransportError(error: unknown): boolean {
  return error instanceof Error
    && !isRunnerCancellationError(error)
    && /socket|offline|disconnect|econn|network|fetch failed/i.test(
      error.message,
    );
}

function isRunnerCancellationError(error: unknown): boolean {
  return error instanceof Error && error.name === "RunnerCancellationError";
}

function approvalScopeFor(
  workItem: WorkItem,
  runId: string,
  step: PersistedPlanStep | undefined,
  environment: string,
): ApprovalScope {
  const sessionId = workItem.conversationId.startsWith("conv_")
    ? `sess_${workItem.conversationId.slice("conv_".length)}`
    : workItem.conversationId;
  const targetResource = typeof workItem.identifiers.target_resource === "string"
    ? workItem.identifiers.target_resource
    : step?.capabilityId ?? workItem.workspaceScope[0] ?? "run";
  return {
    sessionId,
    environment,
    targetResource,
    input: {
      workItemId: workItem.id,
      runId,
      title: workItem.title,
      identifiers: workItem.identifiers,
      workspaceScope: workItem.workspaceScope,
      step: step
        ? {
            id: step.id,
            capabilityId: step.capabilityId,
            risk: step.risk,
            purpose: step.purpose,
            dependsOn: step.dependsOn,
            guard: step.guard,
            approval: step.approval,
            branches: step.branches,
            retry: step.retry ?? null,
          }
        : null,
      sessionId,
      environment,
      targetResource,
    },
  };
}

function hashInput(scope: ApprovalScope): string {
  return createHash("sha256")
    .update(stableStringify(scope.input))
    .digest("hex");
}

function contentHash(...values: string[]): string {
  return createHash("sha256").update(values.join(":"), "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function orderSteps(steps: PersistedPlanStep[]): PersistedPlanStep[] {
  const pending = new Map(steps.map((step) => [step.id, step]));
  const ordered: PersistedPlanStep[] = [];
  while (pending.size) {
    const next = [...pending.values()].find((step) => dependenciesFor(step, steps).every((dependency) => ordered.some((item) => item.id === dependency)));
    if (!next) throw new Error("Plan contains an unresolved dependency");
    ordered.push(next);
    pending.delete(next.id);
  }
  return ordered;
}

function dependenciesFor(step: PersistedPlanStep, steps: PersistedPlanStep[]): string[] {
  const branchParents = steps
    .filter((candidate) => candidate.branches.some((branch) => branch.next === step.id))
    .map((candidate) => candidate.id);
  return [...new Set([...step.dependsOn, ...branchParents])];
}

function selectBranch(
  step: PersistedPlanStep,
  facts: Record<string, unknown>,
): { when: string; next: string } | undefined {
  return step.branches.find((branch) => branch.when !== "default" && branch.when !== "else" && matches(branch.when, facts))
    ?? step.branches.find((branch) => branch.when === "default" || branch.when === "else");
}

function matches(expression: string, facts: Record<string, unknown>): boolean {
  const comparison = expression.match(/^([A-Za-z0-9_.-]+)\s*(==|=|!=)\s*(.+)$/);
  if (!comparison) return Boolean(valueAt(facts, expression.trim()));
  const actual = valueAt(facts, comparison[1]!);
  const expected = parseLiteral(comparison[3]!.trim());
  return comparison[2] === "!=" ? actual !== expected : actual === expected;
}

function valueAt(facts: Record<string, unknown>, path: string): unknown {
  let value: unknown = facts;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function parseLiteral(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

function isRetryableError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { retryable?: unknown }).retryable === true);
}

function runHasIr(run: Run): boolean {
  return run.planIrHash !== null && run.planIrHash !== undefined;
}

const ACTUAL_LIMIT = 4096;

function capActual(value: unknown): { actual: unknown; truncated: boolean } {
  const json = JSON.stringify(value) ?? "null";
  if (Buffer.byteLength(json, "utf8") <= ACTUAL_LIMIT) return { actual: value, truncated: false };
  let sliced = json.slice(0, ACTUAL_LIMIT);
  while (sliced.length > 0 && Buffer.byteLength(sliced, "utf8") > ACTUAL_LIMIT) {
    sliced = sliced.slice(0, -1);
  }
  return { actual: sliced, truncated: true };
}

function sha256Utf8(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function validityWindowMs(window: string | undefined): number | null {
  if (!window || window === "permanent") return null;
  if (window === "24h") return 24 * 60 * 60 * 1000;
  if (window === "7d") return 7 * 24 * 60 * 60 * 1000;
  return null;
}

function idempotencyRecordFresh(
  createdAt: string | undefined,
  window: string | undefined,
  now: Date,
): boolean {
  if (!createdAt) return true;
  const limit = validityWindowMs(window);
  if (limit === null) return true;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return true;
  return now.getTime() - created <= limit;
}

function idempotencyKey(
  workItem: WorkItem,
  step: PersistedPlanStep,
  fields: string[],
): string {
  // Key fields are business inputs carried in workItem.identifiers at phase 1
  // (no ResolvedPlan producer yet); the key is flow+step+field-values.
  const parts = fields.map((field) => {
    const value = workItem.identifiers[field];
    return `${field}=${stableStringify(value)}`;
  });
  return `sha256:${createHash("sha256").update([workItem.workflowId ?? "", step.id, ...parts].join(":"), "utf8").digest("hex")}`;
}

async function retryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
