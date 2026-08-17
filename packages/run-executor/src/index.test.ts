import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, RunRequest } from "@codebridge/core";
import { SqliteEventStore } from "@codebridge/work-items";
import {
  SessionCoordinator,
  SessionLeaseService,
} from "@codebridge/session-coordinator";
import {
  ApprovalService,
  CapabilityRegistry,
  CapabilityRuntime,
  CapabilityExecutionError,
  FunctionCapabilityAdapter,
  PolicyEngine,
} from "@codebridge/policy";
import { RunExecutor } from "./index.js";

class FakeRunner {
  readonly prompts: string[] = [];
  readonly requests: RunRequest[] = [];
  constructor(private readonly events: AgentEvent[], private readonly fail = false) {}

  async *run(request: RunRequest): AsyncGenerator<AgentEvent> {
    this.requests.push(request);
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

function setupSessionRun() {
  const store = new SqliteEventStore(":memory:");
  const coordinator = new SessionCoordinator(store, {
    maxQueuedTurns: 100,
  });
  const submitted = coordinator.submitTurn({
    sessionId: "sess_1",
    idempotencyKey: "message_1",
    message: {
      text: "调查",
      attachmentIds: [],
      flowId: null,
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    },
    workItem: {
      title: "Session",
      mode: "investigation",
      conversationId: "conv_sess_1",
      agentId: "pi",
      workspaceScope: ["/tmp/project"],
      riskLevel: "read_only",
    },
  });
  return {
    store,
    coordinator,
    leaseService: new SessionLeaseService(store),
    run: submitted.run!,
  };
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

  it("persists aggregated Agent events before notifying subscribers", async () => {
    const { store, item, run } = setup();
    const observed: AgentEvent[] = [];
    const executor = new RunExecutor(
      store,
      new FakeRunner([
        {
          type: "text_delta",
          blockId: "answer",
          phase: "final_answer",
          text: "a",
        },
        {
          type: "text_delta",
          blockId: "answer",
          phase: "final_answer",
          text: "b",
        },
        { type: "done", exitCode: 0 },
      ]),
      {
        resolveRequest: () => ({
          runId: run.id,
          sessionKey: {
            chatId: item.conversationId,
            backendId: "pi",
            cwd: "/tmp/project",
          },
          prompt: "调查",
        }),
        onEvent: (_currentRun, event) => {
          const persisted = store
            .listEvents(item.id)
            .filter((candidate) => candidate.type === "AGENT_EVENT")
            .at(-1);
          expect(persisted?.payload.event).toEqual(event);
          observed.push(event);
        },
      },
    );

    await executor.execute(run.id);

    expect(observed).toEqual([
      {
        type: "text_delta",
        blockId: "answer",
        phase: "final_answer",
        text: "ab",
      },
      { type: "done", exitCode: 0 },
    ]);
    store.close();
  });

  it("claims and finishes a Session-bound Run through the Coordinator", async () => {
    const store = new SqliteEventStore(":memory:");
    const coordinator = new SessionCoordinator(store, {
      maxQueuedTurns: 100,
    });
    const submitted = coordinator.submitTurn({
      sessionId: "sess_1",
      idempotencyKey: "message_1",
      message: {
        text: "调查",
        attachmentIds: [],
        flowId: null,
        model: null,
        effort: null,
        permissionMode: null,
        plan: null,
      },
      workItem: {
        title: "Session",
        mode: "investigation",
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: ["/tmp/project"],
        riskLevel: "read_only",
      },
    });
    const run = submitted.run!;
    const leaseService = new SessionLeaseService(store);
    const claim = vi.spyOn(leaseService, "claim");
    const finish = vi.spyOn(coordinator, "finishRun");
    const executorOwner = "bridge:123";
    const executor = new RunExecutor(
      store,
      new FakeRunner([{ type: "done", exitCode: 0 }]),
      {
        sessionCoordinator: coordinator,
        sessionLeaseService: leaseService,
        executorOwner,
        resolveRequest: () => ({
          runId: run.id,
          sessionKey: {
            chatId: "conv_sess_1",
            backendId: "pi",
            cwd: "/tmp/project",
          },
          prompt: "调查",
        }),
      },
    );

    expect((await executor.execute(run.id)).status).toBe("succeeded");
    expect(claim).toHaveBeenCalledWith(run.id, executorOwner);
    expect(finish).toHaveBeenCalledWith({
      sessionId: "sess_1",
      runId: run.id,
      status: "succeeded",
    });
    store.close();
  });

  it("rejects execution events after a Session Run loses ownership", () => {
    const store = new SqliteEventStore(":memory:");
    const coordinator = new SessionCoordinator(store, {
      maxQueuedTurns: 100,
    });
    const submitted = coordinator.submitTurn({
      sessionId: "sess_1",
      idempotencyKey: "message_1",
      message: {
        text: "调查",
        attachmentIds: [],
        flowId: null,
        model: null,
        effort: null,
        permissionMode: null,
        plan: null,
      },
      workItem: {
        title: "Session",
        mode: "investigation",
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: [],
        riskLevel: "read_only",
      },
    });
    const run = submitted.run!;
    const owner = "bridge:123";
    expect(new SessionLeaseService(store).claim(run.id, owner)).not.toBeNull();
    coordinator.finishRun({
      sessionId: "sess_1",
      runId: run.id,
      status: "interrupted",
    });
    const eventCount = store.listEvents(submitted.workItemId).length;
    const timeline = store.listTimelineTurns("sess_1", {
      limit: 50,
    });

    expect(() =>
      store.appendLeasedRunEvent(owner, {
        workItemId: submitted.workItemId,
        sessionId: "sess_1",
        runId: run.id,
        type: "AGENT_EVENT",
        actor: "agent",
        payload: {
          event: {
            type: "text_delta",
            blockId: "answer",
            text: "late",
          },
        },
      }),
    ).toThrow("run_lease_lost");
    expect(store.listEvents(submitted.workItemId)).toHaveLength(eventCount);
    expect(
      store.listTimelineTurns("sess_1", { limit: 50 }),
    ).toEqual(timeline);
    store.close();
  });

  it("atomically claims the provider session on the first session event", async () => {
    const { store, coordinator, leaseService, run } = setupSessionRun();
    const executor = new RunExecutor(
      store,
      new FakeRunner([
        { type: "session", sessionId: "prov_1" },
        { type: "done", exitCode: 0 },
      ]),
      {
        sessionCoordinator: coordinator,
        sessionLeaseService: leaseService,
        executorOwner: "bridge:123",
        resolveRequest: () => ({
          runId: run.id,
          sessionKey: {
            chatId: "conv_sess_1",
            backendId: "pi",
            cwd: "/tmp/project",
          },
          prompt: "调查",
        }),
      },
    );

    const result = await executor.execute(run.id);
    expect(result.status).toBe("succeeded");
    expect(store.getRun(run.id)?.providerSessionId).toBe("prov_1");
    store.close();
  });

  it("propagates a learned provider session to the auto-dispatched next Run", async () => {
    const store = new SqliteEventStore(":memory:");
    const coordinator = new SessionCoordinator(store, { maxQueuedTurns: 100 });
    const submit = (key: string, text: string) =>
      coordinator.submitTurn({
        sessionId: "sess_1",
        idempotencyKey: key,
        message: {
          text,
          attachmentIds: [],
          flowId: null,
          model: null,
          effort: null,
          permissionMode: null,
          plan: null,
        },
        workItem: {
          title: "Session",
          mode: "investigation",
          conversationId: "conv_sess_1",
          agentId: "pi",
          workspaceScope: [],
          riskLevel: "read_only",
        },
      });
    const first = submit("message_1", "一");
    const second = submit("message_2", "二");
    const run1 = first.run!;
    expect(run1.providerSessionId).toBeNull();

    const executor = new RunExecutor(
      store,
      new FakeRunner([
        { type: "session", sessionId: "prov_1" },
        { type: "done", exitCode: 0 },
      ]),
      {
        sessionCoordinator: coordinator,
        sessionLeaseService: new SessionLeaseService(store),
        executorOwner: "bridge:123",
        resolveRequest: () => ({
          runId: run1.id,
          sessionKey: {
            chatId: "conv_sess_1",
            backendId: "pi",
            cwd: "/tmp/project",
          },
          prompt: "一",
        }),
      },
    );

    const result = await executor.execute(run1.id);
    expect(result.status).toBe("succeeded");

    // 学到 id 之后 runtime 是事实源。
    let learned: string | null = null;
    store.withSessionTransaction((tx) => {
      learned = tx.getSessionProviderSessionId("sess_1");
    });
    expect(learned).toBe("prov_1");

    // 自动推进的下一 Run 带上 providerSessionId（resume 前置）。
    const nextRunId = store.getTurn(second.turn.turnId)?.dispatchedRunId;
    expect(nextRunId).toBeTruthy();
    expect(store.getRun(nextRunId!)?.providerSessionId).toBe("prov_1");
    store.close();
  });

  it("interrupts exactly once when the provider lease renew fails", async () => {
    vi.useFakeTimers();
    try {
      const store = new SqliteEventStore(":memory:");
      const coordinator = new SessionCoordinator(store, { maxQueuedTurns: 100 });
      store.withSessionTransaction((tx) => {
        tx.ensureRuntime("sess_1");
        tx.setSessionProviderSessionId("sess_1", "prov_1");
      });
      const submitted = coordinator.submitTurn({
        sessionId: "sess_1",
        idempotencyKey: "message_1",
        message: {
          text: "调查",
          attachmentIds: [],
          flowId: null,
          model: null,
          effort: null,
          permissionMode: null,
          plan: null,
        },
        workItem: {
          title: "Session",
          mode: "investigation",
          conversationId: "conv_sess_1",
          agentId: "pi",
          workspaceScope: [],
          riskLevel: "read_only",
        },
      });
      const run = submitted.run!;
      const finishSpy = vi.spyOn(coordinator, "finishRun");
      const runner = {
        async *run(
          _request: RunRequest,
          options?: { signal?: AbortSignal },
        ): AsyncGenerator<AgentEvent> {
          yield { type: "text_delta", text: "start" };
          await new Promise<void>((resolve) => {
            const signal = options?.signal;
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new Error("aborted by signal");
        },
      };
      const executor = new RunExecutor(store, runner, {
        sessionCoordinator: coordinator,
        sessionLeaseService: new SessionLeaseService(store),
        executorOwner: "bridge:123",
        resolveRequest: () => ({
          runId: run.id,
          sessionKey: {
            chatId: "conv_sess_1",
            backendId: "pi",
            cwd: "/tmp/project",
          },
          prompt: "调查",
        }),
      });

      const execution = executor.execute(run.id);
      // resume 路径在调 Runner 前同步 claim。
      expect(
        store.findLiveProviderLease("pi", "prov_1", new Date().toISOString()),
      ).toEqual({ runId: run.id });
      // 模拟 lease 被抢/丢失。
      store.releaseProviderSession({
        agentId: "pi",
        providerSessionId: "prov_1",
        runId: run.id,
      });
      vi.advanceTimersByTime(15_000);

      const result = await execution;
      expect(result.status).toBe("interrupted");
      expect(result.terminalReason).toBe("provider_session_busy");
      expect(finishSpy).toHaveBeenCalledTimes(1);
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("interrupts when the fresh provider session is already claimed", async () => {
    const { store, coordinator, leaseService, run } = setupSessionRun();
    store.claimProviderSession({
      agentId: "pi",
      providerSessionId: "prov_1",
      runId: "other_run",
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const executor = new RunExecutor(
      store,
      new FakeRunner([
        { type: "session", sessionId: "prov_1" },
        { type: "done", exitCode: 0 },
      ]),
      {
        sessionCoordinator: coordinator,
        sessionLeaseService: leaseService,
        executorOwner: "bridge:123",
        resolveRequest: () => ({
          runId: run.id,
          sessionKey: {
            chatId: "conv_sess_1",
            backendId: "pi",
            cwd: "/tmp/project",
          },
          prompt: "调查",
        }),
      },
    );

    const result = await executor.execute(run.id);
    expect(result.status).toBe("interrupted");
    expect(store.getRun(run.id)?.terminalReason).toBe("provider_session_busy");
    // claim 失败不得污染 dispatch 事实源：runtime 仍为 null，run 也未被绑定。
    expect(store.getRun(run.id)?.providerSessionId).toBeNull();
    let runtimeId: string | null = null;
    store.withSessionTransaction((tx) => {
      runtimeId = tx.getSessionProviderSessionId("sess_1");
    });
    expect(runtimeId).toBeNull();
    store.close();
  });

  it("interrupts before the Runner when a resume provider session is busy", async () => {
    const store = new SqliteEventStore(":memory:");
    const coordinator = new SessionCoordinator(store, {
      maxQueuedTurns: 100,
    });
    store.withSessionTransaction((tx) => {
      tx.ensureRuntime("sess_1");
      tx.setSessionProviderSessionId("sess_1", "prov_1");
    });
    const submitted = coordinator.submitTurn({
      sessionId: "sess_1",
      idempotencyKey: "message_1",
      message: {
        text: "调查",
        attachmentIds: [],
        flowId: null,
        model: null,
        effort: null,
        permissionMode: null,
        plan: null,
      },
      workItem: {
        title: "Session",
        mode: "investigation",
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: [],
        riskLevel: "read_only",
      },
    });
    const run = submitted.run!;
    expect(run.providerSessionId).toBe("prov_1");
    store.claimProviderSession({
      agentId: "pi",
      providerSessionId: "prov_1",
      runId: "other_run",
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const runner = new FakeRunner([{ type: "done", exitCode: 0 }]);
    const executor = new RunExecutor(store, runner, {
      sessionCoordinator: coordinator,
      sessionLeaseService: new SessionLeaseService(store),
      executorOwner: "bridge:123",
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: {
          chatId: "conv_sess_1",
          backendId: "pi",
          cwd: "/tmp/project",
        },
        prompt: "调查",
      }),
    });

    const result = await executor.execute(run.id);
    expect(result.status).toBe("interrupted");
    expect(runner.requests).toHaveLength(0);
    store.close();
  });

  it("finishes Session cancellation only after the Runner stops", async () => {
    const store = new SqliteEventStore(":memory:");
    const coordinator = new SessionCoordinator(store, {
      maxQueuedTurns: 100,
    });
    const submitted = coordinator.submitTurn({
      sessionId: "sess_1",
      idempotencyKey: "message_1",
      message: {
        text: "调查",
        attachmentIds: [],
        flowId: null,
        model: null,
        effort: null,
        permissionMode: null,
        plan: null,
      },
      workItem: {
        title: "Session",
        mode: "investigation",
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: [],
        riskLevel: "read_only",
      },
    });
    const run = submitted.run!;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const runner = {
      async *run(
        _request: RunRequest,
        options?: { signal?: AbortSignal },
      ): AsyncGenerator<AgentEvent> {
        signalStarted();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      },
    };
    const executor = new RunExecutor(store, runner, {
      sessionCoordinator: coordinator,
      sessionLeaseService: new SessionLeaseService(store),
      executorOwner: "bridge:123",
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: {
          chatId: "conv_sess_1",
          backendId: "pi",
          cwd: "/tmp/project",
        },
        prompt: "调查",
      }),
    });

    const executing = executor.execute(run.id);
    await started;
    coordinator.requestRunCancellation({
      sessionId: "sess_1",
      runId: run.id,
      expectedRuntimeVersion: store.getSessionRuntime("sess_1")!.version,
      idempotencyKey: "cancel_1",
    });
    const cancelled = executor.cancelRunAndWait(run.id);
    expect(store.getRun(run.id)?.status).toBe("running");

    expect((await cancelled).status).toBe("cancelled");
    expect((await executing).status).toBe("cancelled");
    store.close();
  });

  it("retries a Provider disconnect only before a side-effect boundary", async () => {
    vi.useFakeTimers();
    try {
      const { store, coordinator, leaseService, run } =
        setupSessionRun();
      let calls = 0;
      const runner = {
        async *run(): AsyncGenerator<AgentEvent> {
          calls += 1;
          if (calls === 1) throw new Error("socket closed");
          yield {
            type: "text_delta",
            blockId: "answer",
            text: "ok",
          };
        },
      };
      const executor = new RunExecutor(store, runner, {
        sessionCoordinator: coordinator,
        sessionLeaseService: leaseService,
        executorOwner: "bridge:123",
        resolveRequest: () => ({
          runId: run.id,
          sessionKey: {
            chatId: "conv_sess_1",
            backendId: "pi",
            cwd: "/tmp/project",
          },
          prompt: "调查",
        }),
      });

      const execution = executor.execute(run.id);
      await vi.runAllTimersAsync();
      expect((await execution).status).toBe("succeeded");
      expect(calls).toBe(2);
      expect(store.listRunAttempts(run.id)).toMatchObject([
        {
          attemptNumber: 1,
          providerError: "socket closed",
          sideEffectBoundary: "safe",
        },
        {
          attemptNumber: 2,
          providerError: null,
          sideEffectBoundary: "safe",
        },
      ]);
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replay after an unknown tool outcome", async () => {
    const { store, coordinator, leaseService, run } =
      setupSessionRun();
    let calls = 0;
    const runner = {
      async *run(): AsyncGenerator<AgentEvent> {
        calls += 1;
        yield {
          type: "tool_start",
          toolCallId: "tool_1",
          name: "write_file",
          input: {},
        };
        throw new Error("socket closed");
      },
    };
    const executor = new RunExecutor(store, runner, {
      sessionCoordinator: coordinator,
      sessionLeaseService: leaseService,
      executorOwner: "bridge:123",
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: {
          chatId: "conv_sess_1",
          backendId: "pi",
          cwd: "/tmp/project",
        },
        prompt: "调查",
      }),
    });

    expect((await executor.execute(run.id)).status).toBe(
      "interrupted",
    );
    expect(calls).toBe(1);
    expect(store.getRun(run.id)).toMatchObject({
      status: "interrupted",
      replaySafety: "outcome_unknown",
    });
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

  it("forwards the latest message attachment references to the Runner", async () => {
    const { store, item, run } = setup();
    const attachment = store.createMessageAttachment({
      workItemId: item.id,
      name: "context.txt",
      mimeType: "text/plain",
      dataBase64: Buffer.from("context").toString("base64"),
    });
    store.appendEvent({
      workItemId: item.id,
      type: "MESSAGE_RECEIVED",
      actor: "user",
      payload: { message: "read", attachment_ids: [attachment.id] },
    });
    const runner = new FakeRunner([{ type: "done", exitCode: 0 }]);
    const executor = new RunExecutor(store, runner, {
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: { chatId: item.conversationId, backendId: "pi", cwd: "/tmp/project" },
        prompt: "read",
      }),
    });

    await executor.execute(run.id);

    expect(runner.requests[0]?.attachments).toEqual([{
      name: "context.txt",
      mimeType: "text/plain",
      dataBase64: attachment.dataBase64,
    }]);
    store.close();
  });

  it("aborts an active Runner when a channel cancels the Run", async () => {
    const { store, item, run } = setup();
    const runner = {
      async *run(_request: RunRequest, options?: { signal?: AbortSignal }): AsyncGenerator<AgentEvent> {
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const executor = new RunExecutor(store, runner, {
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: { chatId: item.conversationId, backendId: "pi", cwd: "/tmp/project" },
        prompt: "wait",
      }),
    });
    const executing = executor.execute(run.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executor.cancelRun(run.id).status).toBe("cancelled");
    expect((await executing).status).toBe("cancelled");
    expect(store.listEvents(item.id).filter((event) => event.type === "RUN_CANCELLED")).toHaveLength(1);
    expect(store.listEvents(item.id).filter((event) => event.type === "STEP_SUCCEEDED")).toHaveLength(0);
    store.close();
  });

  it("waits for Runner cleanup before acknowledging channel cancellation", async () => {
    const { store, item, run } = setup();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const runner = {
      async *run(_request: RunRequest, options?: { signal?: AbortSignal }): AsyncGenerator<AgentEvent> {
        markStarted();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await cleanupReleased;
      },
    };
    const executor = new RunExecutor(store, runner, {
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: { chatId: item.conversationId, backendId: "pi", cwd: "/tmp/project" },
        prompt: "wait",
      }),
    });
    const executing = executor.execute(run.id);
    await started;

    let cancellationSettled = false;
    const cancellation = executor.cancelRunAndWait(run.id).then((result) => {
      cancellationSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancellationSettled).toBe(false);

    releaseCleanup();
    expect((await cancellation).status).toBe("cancelled");
    expect((await executing).status).toBe("cancelled");
    store.close();
  });

  it("does not report cancellation when Runner rejects the cancel request", async () => {
    const { store, item, run } = setup();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runner = {
      async *run(_request: RunRequest, options?: { signal?: AbortSignal }): AsyncGenerator<AgentEvent> {
        markStarted();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        const error = new Error("Runner cancellation failed: 409");
        error.name = "RunnerCancellationError";
        throw error;
      },
    };
    const executor = new RunExecutor(store, runner, {
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: { chatId: item.conversationId, backendId: "pi", cwd: "/tmp/project" },
        prompt: "wait",
      }),
    });
    const executing = executor.execute(run.id).catch((error: unknown) => error);
    await started;

    await expect(executor.cancelRunAndWait(run.id)).rejects.toThrow("Runner cancellation failed");
    expect(await executing).toBeInstanceOf(Error);
    expect(store.getRun(run.id)?.status).toBe("failed");
    store.close();
  });

  it("pauses production work until a scoped approval is granted", async () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "release",
      mode: "release",
      conversationId: "web:release",
      workspaceScope: ["/tmp/project"],
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
    expect(approval).toMatchObject({
      sessionId: "web:release",
      environment: "production",
      targetResource: "/tmp/project",
      inputHash: expect.stringMatching(/^sha256:/),
    });
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

  it("executes a registered capability adapter without sending the step to an Agent", async () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "lookup",
      mode: "investigation",
      conversationId: "web:capability",
      identifiers: { id: "value" },
      riskLevel: "read_only",
    });
    const plan = store.savePlan({
      planId: "plan_capability",
      source: "workflow",
      workflowId: "capability-flow",
      definitionRevision: "git:capability",
      steps: [{
        id: "lookup",
        capabilityId: "catalog.lookup",
        risk: "read_only",
        dependsOn: [],
        guard: null,
        approval: "none",
        branches: [],
        purpose: null,
      }],
    });
    const run = store.createRun({ workItemId: item.id, mode: item.mode, planId: plan.planId });
    const runner = new FakeRunner([{ type: "done", exitCode: 0 }]);
    const registry = new CapabilityRegistry([{ id: "catalog.lookup", risk: "read_only", adapter: "local.lookup" }]);
    const runtime = new CapabilityRuntime([
      new FunctionCapabilityAdapter("local.lookup", ({ input }) => ({
        output: input.identifiers,
        artifacts: [{
          name: "lookup.json",
          mimeType: "application/json",
          content: JSON.stringify(input.identifiers),
          kind: "output",
        }],
        verification: {
          validator: "lookup-contract",
          status: "passed",
          summary: "Lookup returned structured data",
        },
      })),
    ]);
    const executor = new RunExecutor(store, runner, {
      policy: new PolicyEngine(registry),
      capabilities: runtime,
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: { chatId: item.conversationId, backendId: "pi", cwd: "/tmp/project" },
        prompt: "should not run",
      }),
    });

    expect((await executor.execute(run.id)).status).toBe("succeeded");
    expect(runner.prompts).toEqual([]);
    expect(store.listEvents(item.id).find((event) => event.type === "AGENT_EVENT")).toMatchObject({
      actor: "adapter",
      target: "catalog.lookup",
      payload: { adapter: "local.lookup", output: { id: "value" } },
    });
    expect(store.listArtifacts(run.id)).toHaveLength(1);
    expect(store.listVerifications(run.id)).toMatchObject([
      { validator: "lookup-contract", status: "passed", artifactIds: [store.listArtifacts(run.id)[0]!.id] },
    ]);
    registry.close();
    store.close();
  });

  it("retries only explicitly retryable step failures within the Plan policy", async () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "retry lookup",
      mode: "investigation",
      conversationId: "web:retry",
      riskLevel: "read_only",
    });
    const plan = store.savePlan({
      planId: "plan_retry",
      source: "workflow",
      workflowId: "retry-flow",
      definitionRevision: "git:retry",
      steps: [{
        id: "lookup",
        capabilityId: "catalog.lookup",
        risk: "read_only",
        dependsOn: [],
        guard: null,
        approval: "none",
        branches: [],
        purpose: null,
        retry: { maxAttempts: 2, delayMs: 0 },
      }],
    });
    const run = store.createRun({ workItemId: item.id, mode: item.mode, planId: plan.planId });
    const registry = new CapabilityRegistry([{ id: "catalog.lookup", risk: "read_only", adapter: "local.lookup" }]);
    let attempts = 0;
    const runtime = new CapabilityRuntime([
      new FunctionCapabilityAdapter("local.lookup", () => {
        attempts += 1;
        if (attempts === 1) {
          throw new CapabilityExecutionError("temporary outage", { retryable: true });
        }
        return { output: { found: true } };
      }),
    ]);
    const executor = new RunExecutor(store, new FakeRunner([]), {
      policy: new PolicyEngine(registry),
      capabilities: runtime,
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: { chatId: item.conversationId, backendId: "pi", cwd: "/tmp/project" },
        prompt: "unused",
      }),
    });

    expect((await executor.execute(run.id)).status).toBe("succeeded");
    expect(attempts).toBe(2);
    expect(store.listEvents(item.id).find((event) => event.type === "STEP_RETRYING")).toMatchObject({
      target: "lookup",
      payload: { attempt: 1, next_attempt: 2, max_attempts: 2, error: "temporary outage" },
    });
    registry.close();
    store.close();
  });

  it("invalidates a step approval when its retry policy changes", async () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "release",
      mode: "release",
      conversationId: "web:retry-approval",
      riskLevel: "production_write",
    });
    const step = {
      id: "release",
      capabilityId: "release.execute",
      risk: "production_write" as const,
      dependsOn: [],
      guard: null,
      approval: "required" as const,
      branches: [],
      purpose: "release",
      retry: { maxAttempts: 2, delayMs: 0 },
    };
    const plan = store.savePlan({
      planId: "plan_retry_approval",
      source: "workflow",
      workflowId: "release-flow",
      definitionRevision: "git:one",
      steps: [step],
    });
    const run = store.createRun({ workItemId: item.id, mode: item.mode, planId: plan.planId });
    const approvals = new ApprovalService(store, ":memory:");
    const executor = new RunExecutor(store, new FakeRunner([{ type: "done", exitCode: 0 }]), {
      approvals,
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: { chatId: item.conversationId, backendId: "pi", cwd: "/tmp/project" },
        prompt: "release",
      }),
    });
    expect((await executor.execute(run.id)).status).toBe("waiting");
    const firstApproval = approvals.listForRun(run.id)[0]!;
    approvals.grant(firstApproval.id, "user");
    store.savePlan({
      planId: plan.planId,
      source: plan.source,
      workflowId: plan.workflowId,
      definitionRevision: "git:two",
      steps: [{ ...step, retry: { maxAttempts: 3, delayMs: 0 } }],
    });
    store.requeueRun(run.id);

    expect((await executor.execute(run.id)).status).toBe("waiting");
    const allApprovals = approvals.listForRun(run.id);
    expect(allApprovals).toHaveLength(2);
    expect(allApprovals[1]?.inputHash).not.toBe(firstApproval.inputHash);
    approvals.close();
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

  it("does not mark a branch step successful after the run is cancelled", async () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "cancelled branch",
      mode: "investigation",
      conversationId: "web:cancelled-branch",
      identifiers: { ready: true },
      riskLevel: "read_only",
    });
    const plan = store.savePlan({
      planId: "plan_cancelled_branch",
      source: "workflow",
      workflowId: "cancelled-branch-flow",
      definitionRevision: "git:cancelled-branch",
      steps: [
        {
          id: "decision",
          capabilityId: null,
          risk: "read_only",
          dependsOn: [],
          guard: null,
          approval: "none",
          branches: [{ when: "ready == true", next: "ready-path" }],
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
    const executor = new RunExecutor(store, new FakeRunner([]), {
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: { chatId: item.conversationId, backendId: "pi", cwd: "/tmp/project" },
        prompt: "must not run",
      }),
    });
    const controller = new AbortController();
    controller.abort();

    expect((await executor.execute(run.id, controller.signal)).status).toBe("cancelled");
    expect(store.listEvents(item.id).filter((event) => event.type === "STEP_SUCCEEDED")).toHaveLength(0);
    store.close();
  });

  it("turns an Agent plan event into an ephemeral Flow proposal", async () => {
    const { store, item, run } = setup();
    const runner = new FakeRunner([
      {
        type: "plan",
        entries: [{ content: "inspect context", priority: "high", status: "pending" }],
      },
      { type: "done", exitCode: 0 },
    ]);
    const executor = new RunExecutor(store, runner, {
      resolveRequest: () => ({
        runId: run.id,
        sessionKey: { chatId: item.conversationId, backendId: "pi", cwd: "/tmp/project" },
        prompt: "plan",
      }),
    });

    await executor.execute(run.id);
    expect(store.listEvents(item.id).find((event) => event.type === "FLOW_PROPOSED")).toMatchObject({
      actor: "agent",
      payload: {
        source: "agent_generated",
        flow: { kind: "guide", steps: [{ id: "step_1", mode: "manual", purpose: "inspect context" }] },
      },
    });
    store.close();
  });

  it("rejects a run whose bound plan_ir_hash drifted from the plan", async () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "t", mode: "auto", conversationId: "c", riskLevel: "read_only",
    });
    store.savePlan({
      planId: "plan_1", source: "workflow", workflowId: "flow_1",
      definitionRevision: "sha256:def", planIrHash: "sha256:plan",
      steps: [{ id: "s", capabilityId: "c.d", risk: "read_only", dependsOn: [], guard: null, approval: "none", branches: [], purpose: null }],
    });
    const run = store.createRun({
      workItemId: item.id, mode: "auto", planId: "plan_1", planIrHash: "sha256:other",
    });
    const executor = new RunExecutor(store, new FakeRunner([{ type: "done", exitCode: 0 }]), {
      resolveRequest: () => ({ runId: run.id, sessionKey: { chatId: "c", backendId: "pi", cwd: "/tmp" }, prompt: "x" }),
    });
    await expect(executor.execute(run.id)).rejects.toThrow(/drift/);
    store.close();
  });

  it("dedupes write steps by idempotency key across runs", async () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "deliver", mode: "change", conversationId: "web:deliver",
      riskLevel: "workspace_write",
      identifiers: { company_id: "8821" },
    });
    store.savePlan({
      planId: "plan_deliver", source: "workflow", workflowId: "deliver-flow",
      definitionRevision: "git:deliver",
      steps: [{
        id: "deliver", capabilityId: "equity.deliver", risk: "workspace_write",
        dependsOn: [], guard: null, approval: "none", branches: [], purpose: null,
      }],
    });
    const registry = new CapabilityRegistry([{
      id: "equity.deliver", risk: "workspace_write", adapter: "local.deliver",
      idempotency: { key: ["company_id"], validity_window: "24h" },
    }]);
    let invocations = 0;
    const runtime = new CapabilityRuntime([
      new FunctionCapabilityAdapter("local.deliver", () => {
        invocations += 1;
        return { output: { order_id: "o1" } };
      }),
    ]);
    const executor = new RunExecutor(store, new FakeRunner([]), {
      policy: new PolicyEngine(registry),
      capabilities: runtime,
      resolveRequest: (_w, run) => ({
        runId: run.id, sessionKey: { chatId: "web:deliver", backendId: "pi", cwd: "/tmp" }, prompt: "unused",
      }),
    });

    const run1 = store.createRun({ workItemId: item.id, mode: item.mode, planId: "plan_deliver" });
    await executor.execute(run1.id);
    const run2 = store.createRun({ workItemId: item.id, mode: item.mode, planId: "plan_deliver" });
    await executor.execute(run2.id);

    expect(invocations).toBe(1);
    registry.close();
    store.close();
  });

  it("fails a step whose success_when postcondition is unmet", async () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "deliver", mode: "change", conversationId: "web:pc", riskLevel: "read_only",
    });
    const plan = store.savePlan({
      planId: "plan_pc", source: "workflow", workflowId: "pc-flow",
      definitionRevision: "git:pc",
      steps: [{
        id: "deliver", capabilityId: "equity.deliver", risk: "read_only",
        dependsOn: [], guard: null, approval: "none", branches: [], purpose: null,
        successWhen: "output.order_id != null",
      }],
    });
    const run = store.createRun({ workItemId: item.id, mode: item.mode, planId: plan.planId });
    const registry = new CapabilityRegistry([{ id: "equity.deliver", risk: "read_only", adapter: "local.deliver" }]);
    const runtime = new CapabilityRuntime([
      new FunctionCapabilityAdapter("local.deliver", () => ({ output: {} })),
    ]);
    const executor = new RunExecutor(store, new FakeRunner([]), {
      policy: new PolicyEngine(registry),
      capabilities: runtime,
      resolveRequest: (_w, run) => ({ runId: run.id, sessionKey: { chatId: "web:pc", backendId: "pi", cwd: "/tmp" }, prompt: "unused" }),
    });

    await expect(executor.execute(run.id)).rejects.toThrow(/Postcondition failed/);
    const failed = store.listEvents(item.id).find((e) => e.type === "VERIFICATION_FAILED");
    expect(failed?.payload).toMatchObject({ step_id: "deliver", category: "verification" });
    registry.close();
    store.close();
  });

  it("replays a plan deterministically and diffs decision traces", async () => {
    const store = new SqliteEventStore(":memory:");
    const plan = store.savePlan({
      planId: "plan_rp", source: "workflow", workflowId: "rp-flow",
      definitionRevision: "git:rp",
      steps: [{
        id: "lookup", capabilityId: "catalog.lookup", risk: "read_only",
        dependsOn: [], guard: null, approval: "none", branches: [], purpose: null,
        successWhen: "output.id != null",
      }],
    });
    const registry = new CapabilityRegistry([{ id: "catalog.lookup", risk: "read_only", adapter: "local.lookup" }]);
    const runtime = new CapabilityRuntime([
      new FunctionCapabilityAdapter("local.lookup", ({ input }) => ({
        output: { id: String(input.id ?? "v") },
      })),
    ]);
    const executor = new RunExecutor(store, new FakeRunner([]), {
      policy: new PolicyEngine(registry),
      capabilities: runtime,
      resolveRequest: (_w, run) => ({ runId: run.id, sessionKey: { chatId: "c", backendId: "pi", cwd: "/tmp" }, prompt: "x" }),
    });

    const trace1 = await executor.replayPlan(plan, { id: "value" });
    const trace2 = await executor.replayPlan(plan, { id: "value" });
    expect(trace1).toHaveLength(1);
    expect(executor.diffTrace(trace1, trace2).identical).toBe(true);

    const changed = await executor.replayPlan(plan, { id: "other" });
    expect(executor.diffTrace(trace1, changed).identical).toBe(false);
    registry.close();
    store.close();
  });
});
