import { createHash } from "node:crypto";
import type { AgentEvent, RunRequest } from "@codebridge/core";
import type {
  ApprovalService,
  CapabilityRuntime,
  PolicyEngine,
  CapabilityExecutionResult,
} from "@codebridge/policy";
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
  policy?: PolicyEngine;
  capabilities?: CapabilityRuntime;
}

export class RunExecutor {
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly activeCompletions = new Map<string, Promise<void>>();

  constructor(
    private readonly store: SqliteEventStore,
    private readonly runner: RunnerStream,
    private readonly options: RunExecutorOptions,
  ) {}

  cancelRun(runId: string): Run {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
    this.activeControllers.get(runId)?.abort();
    return this.cancel(run.id, run.workItemId);
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

    const controller = new AbortController();
    const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let completeExecution!: () => void;
    const completion = new Promise<void>((resolve) => {
      completeExecution = resolve;
    });
    this.activeControllers.set(runId, controller);
    this.activeCompletions.set(runId, completion);
    try {
      if (plan) {
        const waiting = await this.executePlan(workItem, initial, plan, activeSignal);
        if (waiting) return this.store.getRun(runId)!;
      } else {
        this.store.appendEvent({
          workItemId: workItem.id,
          runId,
          type: "STEP_STARTED",
          actor: "system",
          target: runId,
        });
        await this.executeStep(workItem, initial, null, activeSignal);
        if (activeSignal.aborted) return this.cancel(runId, workItem.id);
        this.store.appendEvent({
          workItemId: workItem.id,
          runId,
          type: "STEP_SUCCEEDED",
          actor: "system",
          target: runId,
        });
      }
      if (activeSignal.aborted) return this.cancel(runId, workItem.id);
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
      if (activeSignal.aborted && !isRunnerCancellationError(error)) {
        return this.cancel(runId, workItem.id);
      }
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
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    } finally {
      if (this.activeControllers.get(runId) === controller) this.activeControllers.delete(runId);
      completeExecution();
      if (this.activeCompletions.get(runId) === completion) {
        this.activeCompletions.delete(runId);
      }
    }
  }

  private cancel(runId: string, workItemId: string): Run {
    const current = this.store.getRun(runId);
    if (current?.status === "cancelled") return current;
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
        this.skipStep(workItem.id, run.id, step.id, { reason: "dependency_skipped" });
        skipped.add(step.id);
        continue;
      }
      if (step.branches.length) {
        if (signal?.aborted) return false;
        const selected = selectBranch(step, workItem.identifiers);
        if (!selected) throw new Error(`No branch matched for step ${step.id}`);
        this.store.appendEvent({
          workItemId: workItem.id,
          runId: run.id,
          type: "STEP_STARTED",
          actor: "system",
          target: step.id,
          payload: { capability_id: null, risk: step.risk },
        });
        this.store.appendEvent({
          workItemId: workItem.id,
          runId: run.id,
          type: "BRANCH_SELECTED",
          actor: "system",
          target: step.id,
          payload: { when: selected.when, next: selected.next },
        });
        for (const branch of step.branches) {
          if (branch.next === selected.next || skipped.has(branch.next)) continue;
          this.skipStep(workItem.id, run.id, branch.next, {
            reason: "branch_not_selected",
            branch_step_id: step.id,
            selected: selected.next,
          });
          skipped.add(branch.next);
        }
        if (signal?.aborted) return false;
        this.store.appendEvent({
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
          throw new Error(`Unknown capability: ${step.capabilityId}`);
        }
        throw new Error(`Capability is not allowed in this environment: ${step.capabilityId}`);
      }
      if (
        step.approval === "required" ||
        step.risk === "production_write" ||
        (policyDecision && !policyDecision.allowed && policyDecision.requiresApproval)
      ) {
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
      if (signal?.aborted) return false;
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

  private skipStep(
    workItemId: string,
    runId: string,
    stepId: string,
    payload: Record<string, unknown>,
  ): void {
    this.store.appendEvent({
      workItemId,
      runId,
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
        if (attempt >= maxAttempts || !isRetryableError(error)) throw error;
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
    const capabilityResult = await this.executeCapability(workItem, run, step, signal);
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
    if (capabilityResult?.forwardToAgent) {
      const instructions = capabilityResult.output && typeof capabilityResult.output === "object"
        ? (capabilityResult.output as Record<string, unknown>).instructions
        : undefined;
      if (typeof instructions === "string" && instructions.trim()) {
        request = { ...request, prompt: `${instructions}\n\n${request.prompt}` };
      }
    } else if (capabilityResult) {
      return;
    }
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
      if (event.type === "plan" && event.entries.length) {
        const flowId = `flow_ephemeral_${run.id}`;
        const flowSteps = event.entries.map((entry, index) => ({
          id: `step_${index + 1}`,
          mode: "manual",
          purpose: entry.content,
          depends_on: index ? [`step_${index}`] : [],
          approval: "none",
        }));
        this.store.appendEvent({
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
    }
  }

  private async executeCapability(
    workItem: WorkItem,
    run: Run,
    step: PersistedPlanStep | null,
    signal?: AbortSignal,
  ): Promise<CapabilityExecutionResult | undefined> {
    if (!step?.capabilityId || !this.options.capabilities || !this.options.policy) return undefined;
    const definition = this.options.policy.getCapability(step.capabilityId);
    if (!definition || !this.options.capabilities.has(definition.adapter)) return undefined;
    const result = await this.options.capabilities.execute(definition.adapter, {
      input: {
        title: workItem.title,
        identifiers: workItem.identifiers,
        workspaceScope: workItem.workspaceScope,
        step: { id: step.id, purpose: step.purpose },
      },
      context: {
        cwd: workItem.workspaceScope[0],
        environment: step.risk === "production_write" ? "production" : "local",
        runId: run.id,
        stepId: step.id,
        signal,
      },
    });
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
    this.store.appendEvent({
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
