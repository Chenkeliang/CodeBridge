import type { AgentEvent, RunRequest } from "@codebridge/core";
import { ApprovalService } from "@codebridge/policy";
import { SessionCoordinator, SessionLeaseService, SessionRecoveryService } from "@codebridge/session-coordinator";
import { SqliteEventStore } from "@codebridge/work-items";
import { describe, expect, it, vi } from "vitest";
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
  const run = store.createRun({ workItemId: item.id, mode: item.mode, executionKind: "agent" });
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
      executionKind: "agent",
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

  it("coalesces thought_delta into one AGENT_EVENT at the next semantic boundary", async () => {
    const { store, item, run } = setup();
    const observed: AgentEvent[] = [];
    const source = "界".repeat(2_000);
    const executor = new RunExecutor(
      store,
      new FakeRunner([
        {
          type: "thought_delta",
          blockId: "thought",
          text: source,
        },
        {
          type: "tool_start",
          toolCallId: "tool_1",
          name: "rg",
          input: {},
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
          observed.push(event);
        },
      },
    );

    await executor.execute(run.id);

    const agentEvents = store
      .listEvents(item.id)
      .filter((event) => event.type === "AGENT_EVENT")
      .map((event) => event.payload.event as AgentEvent);
    expect(agentEvents).toEqual([
      { type: "thought_delta", blockId: "thought", text: source },
      { type: "tool_start", toolCallId: "tool_1", name: "rg", input: {} },
      { type: "done", exitCode: 0 },
    ]);
    expect(observed.filter((event) => event.type === "thought_delta").length)
      .toBeGreaterThan(1);
    expect(
      observed
        .filter((event) => event.type === "thought_delta")
        .map((event) => ("text" in event ? event.text : ""))
        .join(""),
    ).toBe(source);
    store.close();
  });

  it("flushes a trailing thought_delta when the Run ends without another event", async () => {
    const { store, item, run } = setup();
    const executor = new RunExecutor(
      store,
      new FakeRunner([
        { type: "thought_delta", blockId: "thought", text: "检查" },
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
      },
    );

    await executor.execute(run.id);

    const agentEvents = store
      .listEvents(item.id)
      .filter((event) => event.type === "AGENT_EVENT")
      .map((event) => event.payload.event as AgentEvent);
    expect(agentEvents).toEqual([
      { type: "thought_delta", blockId: "thought", text: "检查" },
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
        executionKind: "agent",
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

  it("renews the Session lease when Agent events prove the Run is active", async () => {
    const startedAt = new Date("2026-09-06T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
    const { store, coordinator, leaseService, run } = setupSessionRun();
    try {
      const renew = vi.spyOn(leaseService, "renew");
      const renewProvider = vi.spyOn(store, "renewProviderSession");
      const executorOwner = "bridge:123";
      const runner = {
        async *run(): AsyncGenerator<AgentEvent> {
          yield { type: "session", sessionId: "prov_1" };
          vi.setSystemTime(new Date(startedAt.getTime() + 20_000));
          yield { type: "session_info_update" };
          vi.setSystemTime(new Date(startedAt.getTime() + 40_000));
          yield { type: "session_info_update" };
          vi.setSystemTime(new Date(startedAt.getTime() + 61_000));
          yield { type: "done", exitCode: 0 };
        },
      };
      const executor = new RunExecutor(store, runner, {
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
      });

      expect((await executor.execute(run.id)).status).toBe("succeeded");
      expect(renew).toHaveBeenCalledWith(run.id, executorOwner);
      expect(renewProvider).toHaveBeenCalledWith(expect.objectContaining({
        providerSessionId: "prov_1",
        runId: run.id,
      }));
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("rejects the first Agent event after the Session lease has expired", async () => {
    const startedAt = new Date("2026-09-06T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
    const { store, coordinator, leaseService, run } = setupSessionRun();
    try {
      const executor = new RunExecutor(store, {
        async *run(): AsyncGenerator<AgentEvent> {
          vi.setSystemTime(new Date(startedAt.getTime() + 61_000));
          yield { type: "session_info_update" };
        },
      }, {
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

      expect((await executor.execute(run.id)).status).toBe("running");
      expect(store.listEvents(run.workItemId).filter((event) =>
        event.type === "AGENT_EVENT"
      )).toHaveLength(0);
      const recovery = new SessionRecoveryService(
        store,
        coordinator,
        new SessionLeaseService(store, { now: () => new Date() }),
      );
      expect(recovery.scanExpired()).toEqual([
        { runId: run.id, action: "interrupted" },
      ]);
    } finally {
      store.close();
      vi.useRealTimers();
    }
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
        executionKind: "agent",
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
          executionKind: "agent",
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

  it("executes the auto-dispatched next Run after the current execute finishes", async () => {
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
          executionKind: "agent",
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
    const first = submit("message_1", "一");
    const second = submit("message_2", "二");
    let releaseSecond!: () => void;
    let secondStarted!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const secondHold = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const prompts: string[] = [];
    const executor = new RunExecutor(
      store,
      {
        async *run(request) {
          prompts.push(request.prompt);
          if (request.prompt === "二") {
            secondStarted();
            await secondHold;
          }
          yield { type: "text_delta", text: "ok" };
          yield { type: "done", exitCode: 0 };
        },
      },
      {
        sessionCoordinator: coordinator,
        sessionLeaseService: new SessionLeaseService(store),
        executorOwner: "bridge:123",
        resolveRequest: (_workItem, run) => ({
          runId: run.id,
          sessionKey: {
            chatId: "conv_sess_1",
            backendId: "pi",
            cwd: "/tmp/project",
          },
          prompt: store.getTurn(run.turnId ?? "")?.message.text ?? "",
        }),
      },
    );

    const result = await executor.execute(first.run!.id);
    expect(result.status).toBe("succeeded");
    await secondGate;
    const nextRunId = store.getTurn(second.turn.turnId)?.dispatchedRunId;
    expect(store.getRun(nextRunId!)?.status).toBe("running");
    releaseSecond();
    await vi.waitFor(() => {
      expect(store.getRun(nextRunId!)?.status).toBe("succeeded");
    });
    expect(prompts).toEqual(["一", "二"]);
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
          executionKind: "agent",
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

  it("retries without resume when the Runner says the ACP session is occupied", async () => {
    const store = new SqliteEventStore(":memory:");
    const coordinator = new SessionCoordinator(store, {
      maxQueuedTurns: 100,
    });
    store.withSessionTransaction((tx) => {
      tx.ensureRuntime("sess_1");
      tx.setSessionProviderSessionId("sess_1", "prov_poisoned");
    });
    const submitted = coordinator.submitTurn({
      sessionId: "sess_1",
      idempotencyKey: "message_1",
      message: {
        text: "继续",
        attachmentIds: [],
        flowId: null,
        executionKind: "agent",
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
    expect(run.providerSessionId).toBe("prov_poisoned");

    const runner = {
      requests: [] as RunRequest[],
      async *run(request: RunRequest): AsyncGenerator<AgentEvent> {
        this.requests.push(request);
        if (request.resumeSessionId) {
          yield {
            type: "error",
            message: `ACP session ${request.resumeSessionId} 已被另一个 Runner 任务占用`,
            fatal: true,
          };
          yield { type: "done", exitCode: 1 };
          return;
        }
        yield { type: "session", sessionId: "prov_fresh" };
        yield { type: "done", exitCode: 0 };
      },
    };
    const executor = new RunExecutor(store, runner, {
      sessionCoordinator: coordinator,
      sessionLeaseService: new SessionLeaseService(store),
      executorOwner: "bridge:123",
      resolveRequest: (_workItem, current) => ({
        runId: current.id,
        sessionKey: {
          chatId: "conv_sess_1",
          backendId: "pi",
          cwd: "/tmp/project",
        },
        prompt: "继续",
        resumeSessionId: current.providerSessionId ?? undefined,
      }),
    });

    const result = await executor.execute(run.id);
    expect(result.status).toBe("succeeded");
    expect(runner.requests).toHaveLength(2);
    expect(runner.requests[0]?.resumeSessionId).toBe("prov_poisoned");
    expect(runner.requests[1]?.resumeSessionId).toBeUndefined();
    expect(store.getRun(run.id)?.providerSessionId).toBe("prov_fresh");
    let runtimeId: string | null = null;
    store.withSessionTransaction((tx) => {
      runtimeId = tx.getSessionProviderSessionId("sess_1");
    });
    expect(runtimeId).toBe("prov_fresh");
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
        executionKind: "agent",
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
        executionKind: "agent",
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
    const run = store.createRun({ workItemId: item.id, mode: item.mode, executionKind: "agent" });
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
});
