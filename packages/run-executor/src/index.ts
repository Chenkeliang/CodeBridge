import type { AgentEvent, RunRequest } from "@codebridge/core";
import type { ApprovalService, CapabilityRuntime, PolicyEngine } from "@codebridge/policy";
import type { SessionCoordinator, SessionLeaseService } from "@codebridge/session-coordinator";
import {
  SqliteEventStore,
  type AppendEventInput,
  type PersistedPlanStep,
  type ReplaySafety,
  type Run,
  type WorkItem,
} from "@codebridge/work-items";
import { createHash } from "node:crypto";
import { AgentEventAggregator } from "./agent-event-aggregator.js";
import { RunHeartbeat } from "./run-heartbeat.js";

const PROVIDER_LEASE_MS = 60_000;
const AGENT_EVENT_LEASE_RENEW_INTERVAL_MS = 15_000;

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
  shouldPauseDispatch?: () => boolean;
}

export class RunExecutor {
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly activeCompletions = new Map<string, Promise<void>>();
  private readonly activeAsyncErrors = new Map<string, unknown>();
  private readonly activeProviderSessions = new Map<
    string,
    { agentId: string; providerSessionId: string }
  >();

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

  /** 本进程是否仍在执行该 Run（供恢复扫描判断能否自我续租，而不是自杀）。 */
  isExecuting(runId: string): boolean {
    const controller = this.activeControllers.get(runId);
    return controller !== undefined && !controller.signal.aborted;
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

  async execute(runId: string, signal?: AbortSignal, _options?: { force?: boolean; dryRun?: boolean }): Promise<Run> {
    let nextRunId: string | null = null;
    const initial = this.store.getRun(runId);
    if (!initial) throw new Error(`Run not found: ${runId}`);
    if (initial.status !== "queued") return initial;
    if (this.options.shouldPauseDispatch?.()) return initial;
    const workItem = this.store.getWorkItem(initial.workItemId);
    if (!workItem) throw new Error(`WorkItem not found: ${initial.workItemId}`);
    if (initial.sessionId) {
      this.requireSessionExecutionOptions();
      const claimed = this.options.sessionLeaseService!.claim(
        runId,
        this.options.executorOwner!,
      );
      if (!claimed) return this.store.getRun(runId)!;
    }

    if (workItem.riskLevel === "production_write") {
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
      {
        this.appendRunEvent(initial, {
          workItemId: workItem.id,
          runId,
          type: "STEP_STARTED",
          actor: "system",
          target: runId,
        });
        await this.executeStepOnce(workItem, initial, activeSignal);
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
      const succeeded = this.succeed(initial);
      nextRunId = succeeded.nextRunId;
      return succeeded.run;
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
        target: runId,
        payload: {
          error: failure instanceof Error
            ? failure.message
            : String(failure),
        },
      });
      this.fail(initial, failure);
      throw failure;
    } finally {

      heartbeat?.close();

      this.activeAsyncErrors.delete(runId);
      this.activeProviderSessions.delete(runId);
      if (this.activeControllers.get(runId) === controller) this.activeControllers.delete(runId);
      completeExecution();
      if (this.activeCompletions.get(runId) === completion) {
        this.activeCompletions.delete(runId);
      }
      if (nextRunId) {
        void this.execute(nextRunId).catch(() => {});
      }
    }
  }

  private succeed(run: Run): { run: Run; nextRunId: string | null } {

    if (run.sessionId) {
      const finished = this.options.sessionCoordinator!.finishRun({
        sessionId: run.sessionId,
        runId: run.id,
        status: "succeeded",
      });
      return {
        run: finished.run,
        nextRunId: finished.dispatched?.run.id ?? null,
      };
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
    return { run: this.store.getRun(run.id)!, nextRunId: null };
  }

  private fail(run: Run, error: unknown): Run {

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

  private async executeStepOnce(
    workItem: WorkItem,
    run: Run,
    signal?: AbortSignal,
  ): Promise<void> {
    this.throwIfCancellationRequested(run.id);
    let request = await this.options.resolveRequest(workItem, run);
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
    let renewFromEventAfter = 0;
    type ThoughtDelta = Extract<AgentEvent, { type: "thought_delta" }>;
    let pendingThought: ThoughtDelta | null = null;
    let pendingThoughtKey: string | null = null;
    const thoughtKey = (event: ThoughtDelta): string =>
      `${event.blockId ?? event.messageId ?? ""}:${event.type}`;
    const persistCoalescedThought = (): void => {
      if (!pendingThought) return;
      const event = pendingThought;
      pendingThought = null;
      pendingThoughtKey = null;
      this.appendRunEvent(run, {
        workItemId: workItem.id,
        runId: run.id,
        type: "AGENT_EVENT",
        actor: "adapter",
        target: event.type,
        payload: { event },
      });
    };
    const persistAgentEvent = (event: AgentEvent): void => {
      this.throwIfCancellationRequested(run.id);
      // provider lease 丢失后，persist 入口直接拒绝写入（不依赖 runner 尊重 abort）。
      if (signal?.aborted) {
        throw new RunCancellationRequested();
      }
      // Agent 事件本身就是执行器仍存活的持久证据。定时心跳若因事件循环抖动
      // 错过一个窗口，先续租再落事件，避免恢复扫描把仍在产出事件的 Run 误判中断。
      const now = Date.now();
      if (run.sessionId && now >= renewFromEventAfter) {
        if (!this.options.sessionLeaseService!.renew(
          run.id,
          this.options.executorOwner!,
        )) {
          throw new Error("run_lease_lost");
        }
        if (!this.renewProviderSession(run.id)) {
          throw new ProviderSessionBusyError();
        }
        renewFromEventAfter = now + AGENT_EVENT_LEASE_RENEW_INTERVAL_MS;
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
      // thought_delta 只直播、不逐段写 domain_events。Pi 思考流会在主线程
      // 打出成百上千笔同步事务；思考块结束（下一个非 thought 事件或 Run 收尾）
      // 再落一条合并后的 AGENT_EVENT，供时间线和重连回放。
      if (event.type === "thought_delta") {
        const key = thoughtKey(event);
        if (pendingThought && pendingThoughtKey !== key) {
          persistCoalescedThought();
        }
        if (!pendingThought) {
          pendingThought = { ...event };
          pendingThoughtKey = key;
        } else {
          pendingThought = {
            ...pendingThought,
            text: pendingThought.text + event.text,
          };
        }
        this.options.onEvent?.(run, event);
        this.throwIfCancellationRequested(run.id);
        return;
      }
      persistCoalescedThought();
      this.appendRunEvent(run, {
        workItemId: workItem.id,
        runId: run.id,
        type: "AGENT_EVENT",
        actor: "adapter",
        target: event.type,
        payload: { event },
      });
      this.options.onEvent?.(run, event);
      this.throwIfCancellationRequested(run.id);
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
        persistCoalescedThought();
        this.store.finishRunAttempt(attempt.attemptId, {
          providerError: null,
          sideEffectBoundary: replaySafety,
        });
        return;
      } catch (error) {
        try {
          aggregator.close();
          persistCoalescedThought();
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

  private hasRunEvent(workItemId: string, runId: string, type: string): boolean {
    return this.store.listEvents(workItemId).some((event) => event.runId === runId && event.type === type);
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
