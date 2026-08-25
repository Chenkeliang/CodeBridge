import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelDeliveryRow,
  ChannelSessionEvent,
  ChannelSessionIngress,
} from "@codebridge/core";
import {
  classifyFeishuCardWriteError,
  FeishuRunCard,
  FeishuSessionWatcher,
  type FeishuCardHost,
  type PendingTurn,
} from "./session-watcher.js";

function makeHost() {
  const contents: string[] = [];
  const stream = vi.fn(
    async (
      _chatId: string,
      input: {
        markdown(controller: {
          cardId: string;
          messageId: string;
          setContent(full: string): Promise<void>;
        }): Promise<void>;
      },
      _opts: unknown,
    ) => {
      void input
        .markdown({
          cardId: "cardkit-1",
          messageId: "card-1",
          setContent: async (content) => {
            contents.push(content);
          },
        })
        .catch(() => {});
    },
  );
  const host: FeishuCardHost = {
    channel: { stream } as never,
    sendMarkdown: vi.fn(async () => {}),
    resolveCardId: vi.fn(async () => "cardkit-resolved"),
    updateCard: vi.fn(async () => {}),
    registerPendingStream: () => {},
    clearPendingStream: () => {},
    log: () => {},
    isDisconnecting: () => false,
  };
  return { host, stream, contents };
}

function makeIngress() {
  return {
    events: vi.fn(async function* () {
      await new Promise(() => {});
    }),
    replayEvents: vi.fn(async (): Promise<ChannelSessionEvent[]> => []),
    claimDelivery: vi.fn(async () => true),
    ackDelivery: vi.fn(async () => true),
    completeDelivery: vi.fn(async () => true),
    listDeliveries: vi.fn(async () => []),
  };
}

type Ingress = ReturnType<typeof makeIngress>;

function watcher(ingress: Ingress, host: FeishuCardHost) {
  return new FeishuSessionWatcher(
    host,
    ingress as unknown as ChannelSessionIngress,
    "sess_1",
    "inst-1",
  );
}

function turn(turnId = "turn_1"): PendingTurn {
  return {
    turnId,
    chatId: "chat-1",
    sourceMessageId: "m1",
    showThinking: false,
  };
}

function delivery(
  status: NonNullable<ChannelDeliveryRow["runSnapshot"]>["status"],
): ChannelDeliveryRow {
  return {
    turnId: "turn_1",
    sessionId: "sess_1",
    channel: "feishu",
    conversationId: "chat-1|",
    replyToMessageId: "m1",
    showThinking: false,
    surfaceMessageId: "card-old",
    surfaceCardId: "cardkit-old",
    claimOwner: "feishu:old:run_1",
    claimExpiresAt: null,
    acceptedSequence: 0,
    runId: "run_1",
    runTerminalAt: status === "succeeded" ? new Date(5_000).toISOString() : null,
    status: "delivering",
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(5_000).toISOString(),
    runSnapshot: {
      status,
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(5_000).toISOString(),
      leaseExpiresAt: status === "running" ? new Date(60_000).toISOString() : null,
      terminalReason: null,
      sessionActiveRunId: status === "running" ? "run_1" : null,
      sessionQueueState: "ready",
    },
  };
}

function dispatchedEvent(sequence: number): ChannelSessionEvent {
  return {
    type: "TURN_DISPATCHED",
    sequence,
    runId: "run_1",
    executionKind: "agent",
    occurredAt: "2026-08-21T10:00:00.000Z",
    target: "turn_1",
    resultRef: null,
    payload: {},
  };
}

function flowEvent(
  sequence: number,
  type: string,
  target: string | null,
  payload: Record<string, unknown> = {},
  resultRef: string | null = null,
): ChannelSessionEvent {
  return {
    type,
    sequence,
    runId: "run_1",
    executionKind: "flow",
    occurredAt: `2026-08-21T10:00:${String(sequence).padStart(2, "0")}.000Z`,
    target,
    resultRef,
    payload,
  };
}

function terminalEvent(
  sequence: number,
  type:
    | "RUN_SUCCEEDED"
    | "RUN_FAILED"
    | "RUN_CANCELLED"
    | "RUN_INTERRUPTED" = "RUN_SUCCEEDED",
): ChannelSessionEvent {
  return {
    type,
    sequence,
    runId: "run_1",
    executionKind: "agent",
    occurredAt: "2026-08-21T10:01:00.000Z",
    target: null,
    resultRef: null,
    payload: {},
  };
}

function flowSaveRequestedEvent(
  sequence: number,
  runId = "run_1",
): ChannelSessionEvent {
  const requestId = runId === "run_1" ? "fsr_1" : `fsr_${runId}`;
  return {
    type: "FLOW_SAVE_REQUESTED",
    sequence,
    runId,
    executionKind: "agent",
    occurredAt: "2026-08-21T10:00:30.000Z",
    target: requestId,
    resultRef: null,
    payload: {
      request_id: requestId,
      request_run_id: runId,
      source_run_id: "run_previous",
    },
  };
}

function blockingEvents(events: ChannelSessionEvent[]) {
  return vi.fn(async function* (
    _sessionId: string,
    opts: { afterSequence: number; signal: AbortSignal },
  ) {
    for (const event of events) yield event;
    await new Promise<void>((resolve) =>
      opts.signal?.addEventListener("abort", () => resolve()),
    );
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("FeishuSessionWatcher", () => {
  it("classifies only known invalid-card signals as permanent", () => {
    expect(classifyFeishuCardWriteError(new Error("11310 cardid invalid"))).toBe(
      "permanent",
    );
    expect(classifyFeishuCardWriteError(new Error("HTTP 503"))).toBe(
      "transient",
    );
  });

  it("restores persisted final output and completes without a terminal SSE event", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    ingress.replayEvents.mockResolvedValue([
      {
        type: "AGENT_EVENT",
        sequence: 7,
        runId: "run_1",
        executionKind: "agent",
        occurredAt: "2026-08-21T10:00:07.000Z",
        target: null,
        resultRef: null,
        payload: { event: { type: "text_delta", text: "persisted final answer" } },
      },
      {
        type: "STEP_STARTED",
        sequence: 8,
        runId: "run_1",
        executionKind: "agent",
        occurredAt: "2026-08-21T10:00:08.000Z",
        target: "run_1",
        resultRef: null,
        payload: {},
      },
      terminalEvent(9),
    ]);
    const w = watcher(ingress, host);

    await w.reconcileDelivery(delivery("succeeded"), turn(), "connected");

    const final = JSON.stringify(vi.mocked(host.updateCard).mock.calls.at(-1));
    expect(final).toContain("✅ **已完成**");
    expect(final).toContain("persisted final answer");
    expect(final).not.toContain("本次无输出");
    expect(final).not.toContain("0 / 1");
    expect(final).not.toContain("✓ run_1");
    expect(ingress.events).not.toHaveBeenCalled();
    expect(ingress.completeDelivery).toHaveBeenCalledWith(
      "turn_1",
      "feishu:old:run_1",
    );
    w.abort();
  });

  it("keeps a terminal delivery recoverable when persisted replay fails", async () => {
    const logs: string[] = [];
    const { host } = makeHost();
    host.log = (message) => logs.push(message);
    const ingress = makeIngress();
    ingress.replayEvents.mockRejectedValue(new Error("history unavailable"));
    const w = watcher(ingress, host);

    await w.reconcileDelivery(delivery("succeeded"), turn(), "connected");

    const final = JSON.stringify(vi.mocked(host.updateCard).mock.calls.at(-1));
    expect(final).toContain("结果恢复中");
    expect(final).not.toContain("本次无输出");
    expect(ingress.completeDelivery).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes("feishu_terminal_result_recovery_failed"))).toBe(true);
    w.abort();
  });

  it("shows genuine no-output only after persisted replay includes the matching terminal event", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    ingress.replayEvents.mockResolvedValue([terminalEvent(9)]);
    const w = watcher(ingress, host);

    await w.reconcileDelivery(delivery("succeeded"), turn(), "connected");

    const final = JSON.stringify(vi.mocked(host.updateCard).mock.calls.at(-1));
    expect(final).toContain("本次无输出");
    expect(final).not.toContain("结果恢复中");
    expect(ingress.completeDelivery).toHaveBeenCalledWith(
      "turn_1",
      "feishu:old:run_1",
    );
    w.abort();
  });

  it("keeps a terminal delivery recoverable when replay lacks the matching terminal event", async () => {
    const logs: string[] = [];
    const { host } = makeHost();
    host.log = (message) => logs.push(message);
    const ingress = makeIngress();
    ingress.replayEvents.mockResolvedValue([]);
    const w = watcher(ingress, host);

    await w.reconcileDelivery(delivery("succeeded"), turn(), "connected");

    const final = JSON.stringify(vi.mocked(host.updateCard).mock.calls.at(-1));
    expect(final).toContain("结果恢复中");
    expect(final).not.toContain("本次无输出");
    expect(ingress.completeDelivery).not.toHaveBeenCalled();
    expect(logs.some((line) =>
      line.includes("matching terminal event is missing")
    )).toBe(true);
    w.abort();
  });

  it("restores a structured Flow result from persisted events", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    ingress.replayEvents.mockResolvedValue([
      flowEvent(7, "STEP_STARTED", "deploy", {
        capability_id: "deploy.production",
      }),
      flowEvent(8, "STEP_SUCCEEDED", "deploy"),
      flowEvent(9, "RUN_SNAPSHOT", "run_1", {
        flow_id: "flow_deploy",
        flow_revision: "sha256:revision",
        outcome: "succeeded",
        steps: [{
          step_id: "deploy",
          capability_id: "deploy.production",
          verification_status: "passed",
        }],
      }),
      terminalEvent(10),
    ]);
    const w = watcher(ingress, host);

    await w.reconcileDelivery(delivery("succeeded"), turn(), "connected");

    const final = JSON.stringify(vi.mocked(host.updateCard).mock.calls.at(-1));
    expect(final).toContain("Flow 结果 · 成功");
    expect(final).toContain("flow_deploy");
    expect(ingress.completeDelivery).toHaveBeenCalledTimes(1);
    w.abort();
  });

  it("deduplicates an event observed by both live SSE and persisted replay", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    const repeated: ChannelSessionEvent = {
      type: "AGENT_EVENT",
      sequence: 7,
      runId: "run_1",
      executionKind: "agent",
      occurredAt: "2026-08-21T10:00:07.000Z",
      target: null,
      resultRef: null,
      payload: { event: { type: "text_delta", text: "exactly once" } },
    };
    ingress.events = blockingEvents([repeated]);
    ingress.replayEvents.mockResolvedValue([repeated, terminalEvent(9)]);
    const w = watcher(ingress, host);
    w.resumeCardForRun("run_1", "card-old", "turn_1", "feishu:old:run_1", false, "cardkit-old");
    w.start(0);
    await waitUntil(() => ingress.events.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await w.reconcileDelivery(delivery("succeeded"), turn(), "connected");

    const final = JSON.stringify(vi.mocked(host.updateCard).mock.calls.at(-1));
    expect(final.match(/exactly once/g)).toHaveLength(1);
    expect(ingress.completeDelivery).toHaveBeenCalledTimes(1);
    w.abort();
  });

  it("does not complete recovered delivery when the terminal card patch fails", async () => {
    const { host } = makeHost();
    host.updateCard = vi.fn(async () => {
      throw new Error("update boom");
    });
    const ingress = makeIngress();
    ingress.replayEvents.mockResolvedValue([terminalEvent(9)]);
    const w = watcher(ingress, host);

    await expect(
      w.reconcileDelivery(delivery("succeeded"), turn(), "connected"),
    ).rejects.toThrow("update boom");

    expect(ingress.completeDelivery).not.toHaveBeenCalled();
    w.abort();
  });

  it("never lets a stale live snapshot reverse a terminal card", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    ingress.replayEvents.mockRejectedValue(new Error("history unavailable"));
    const w = watcher(ingress, host);

    await w.reconcileDelivery(delivery("succeeded"), turn(), "connected");
    await w.reconcileDelivery(delivery("running"), turn(), "connected");

    expect(JSON.stringify(vi.mocked(host.updateCard).mock.calls.at(-1))).toContain(
      "✅ **已完成**",
    );
    expect(ingress.completeDelivery).not.toHaveBeenCalled();
    w.abort();
  });

  it("shows an inconsistent warning when a live Run is not the Session active Run", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    const row = delivery("running");
    row.runSnapshot!.sessionActiveRunId = "run_other";
    const w = watcher(ingress, host);

    await w.reconcileDelivery(row, turn(), "connected");

    expect(JSON.stringify(vi.mocked(host.updateCard).mock.calls.at(-1))).toContain(
      "状态核验暂不可用",
    );
    w.abort();
  });

  it("suppresses a permanently invalid card after one structured warning", async () => {
    const logs: string[] = [];
    const { host } = makeHost();
    host.log = (message) => logs.push(message);
    host.updateCard = vi.fn(async () => {
      throw new Error("11310 cardid invalid");
    });
    const ingress = makeIngress();
    ingress.events = blockingEvents([terminalEvent(9)]);
    const w = watcher(ingress, host);
    const row = delivery("running");

    await w.reconcileDelivery(row, turn(), "connected");
    w.start(0);
    await waitUntil(() => ingress.events.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const attempts = vi.mocked(host.updateCard).mock.calls.length;

    await w.reconcileDelivery(row, turn(), "connected");

    expect(vi.mocked(host.updateCard)).toHaveBeenCalledTimes(attempts);
    expect(logs.filter((line) => line.includes("feishu_card_permanently_invalid"))).toHaveLength(1);
    expect(ingress.completeDelivery).not.toHaveBeenCalled();
    w.abort();
  });


  it("reconnects with the old cursor and replays after a failed transition", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    let attempts = 0;
    ingress.claimDelivery = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("claim boom");
      return true;
    });
    ingress.events = blockingEvents([dispatchedEvent(5)]);

    const w = watcher(ingress, host);
    w.registerPendingTurn("turn_1", turn());
    w.start(0);

    await waitUntil(() => attempts >= 2);

    const calls = ingress.events.mock.calls as unknown as Array<
      [string, { afterSequence: number }]
    >;
    expect(calls[0]?.[1]).toMatchObject({ afterSequence: 0 });
    expect(calls[1]?.[1]).toMatchObject({ afterSequence: 0 });
    expect(attempts).toBeGreaterThanOrEqual(2);
    w.abort();
  });

  it("recovers a pending turn via TURN_DISPATCHED", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    ingress.events = blockingEvents([dispatchedEvent(5)]);

    const w = watcher(ingress, host);
    w.registerPendingTurn("turn_1", turn());
    w.start(0);

    await waitUntil(() => ingress.claimDelivery.mock.calls.length >= 1);

    expect(ingress.claimDelivery).toHaveBeenCalledWith(
      "turn_1",
      expect.stringMatching(/^feishu:inst-1:run_1$/),
    );
    expect(ingress.ackDelivery).toHaveBeenCalledWith(
      "turn_1",
      expect.stringMatching(/^feishu:inst-1:run_1$/),
      "card-1",
      "cardkit-1",
    );
    w.abort();
  });

  it("recovers a dispatched delivery by opening its card", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    const w = watcher(ingress, host);
    await w.openCardForRun("run_1", turn());

    expect(ingress.claimDelivery).toHaveBeenCalledWith(
      "turn_1",
      expect.stringMatching(/^feishu:inst-1:run_1$/),
    );
    expect(ingress.ackDelivery).toHaveBeenCalledWith(
      "turn_1",
      expect.stringMatching(/^feishu:inst-1:run_1$/),
      "card-1",
      "cardkit-1",
    );
    w.abort();
  });

  it("recovers a delivering delivery by replaying and updating the original card", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    ingress.events = blockingEvents([
      {
        type: "AGENT_EVENT",
        sequence: 7,
        runId: "run_1",
        executionKind: "agent",
        occurredAt: "2026-08-21T10:00:07.000Z",
        target: null,
        resultRef: null,
        payload: { event: { type: "text_delta", text: "final answer" } },
      },
      terminalEvent(9),
    ]);

    const w = watcher(ingress, host);
    w.resumeCardForRun("run_1", "card-old", "turn_1", "feishu:old:run_1", false, "cardkit-old");
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);

    expect(host.updateCard).toHaveBeenCalledWith(
      "cardkit-old",
      expect.objectContaining({
        body: {
          elements: [{
            tag: "markdown",
            content: expect.stringContaining("✅ **已完成**"),
          }],
        },
      }),
    );
    expect(JSON.stringify(vi.mocked(host.updateCard).mock.calls.at(-1))).toContain(
      "final answer",
    );
    expect(ingress.completeDelivery).toHaveBeenCalledWith(
      "turn_1",
      "feishu:old:run_1",
    );
    expect(ingress.claimDelivery).not.toHaveBeenCalled();
    w.abort();
  });

  it("resolves and persists a legacy CardKit id before updating the card", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    const row = delivery("succeeded");
    row.surfaceCardId = null;
    const w = watcher(ingress, host);

    await w.reconcileDelivery(row, turn(), "connected");

    expect(host.resolveCardId).toHaveBeenCalledWith("card-old");
    expect(ingress.ackDelivery).toHaveBeenCalledWith(
      "turn_1",
      "feishu:old:run_1",
      "card-old",
      "cardkit-resolved",
    );
    expect(host.updateCard).toHaveBeenCalledWith(
      "cardkit-resolved",
      expect.any(Object),
    );
    w.abort();
  });

  it("keeps a legacy delivery recoverable when CardKit id resolution fails", async () => {
    const { host } = makeHost();
    host.resolveCardId = vi.fn(async () => {
      throw new Error("missing cardkit:card:read");
    });
    const ingress = makeIngress();
    const row = delivery("succeeded");
    row.surfaceCardId = null;
    const w = watcher(ingress, host);

    await w.reconcileDelivery(row, turn(), "connected");

    expect(host.updateCard).not.toHaveBeenCalled();
    expect(ingress.completeDelivery).not.toHaveBeenCalled();
    w.abort();
  });

  it("returns structured Flow progress, approval, artifacts, and snapshot on one recovered card", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    const step = flowEvent(7, "STEP_STARTED", "deploy", {
      capability_id: "deploy.production",
    });
    const artifact = flowEvent(11, "ARTIFACT_CREATED", "artifact_1", {
      artifact_id: "artifact_1",
      step_id: "deploy",
      name: "deploy.output.json",
      mime_type: "application/json",
    }, "artifact://artifact_1");
    ingress.events = blockingEvents([
      step,
      step,
      flowEvent(8, "APPROVAL_REQUESTED", "deploy.production", {
        approval_id: "approval_1",
        step_id: "deploy",
      }),
      flowEvent(9, "APPROVAL_GRANTED", "deploy.production", {
        approval_id: "approval_1",
        step_id: "deploy",
      }),
      flowEvent(10, "STEP_SUCCEEDED", "deploy"),
      artifact,
      artifact,
      flowEvent(12, "FLOW_BATCH_DRAFTED", "batch_draft_1", {
        draft_id: "batch_draft_1", flow_id: "flow_deploy",
        definition_revision: "sha256:revision", status: "ready", total: 3, blocking: 0,
      }),
      flowEvent(13, "RUN_SNAPSHOT", "run_1", {
        flow_id: "flow_deploy",
        flow_revision: "sha256:revision",
        outcome: "succeeded",
        steps: [{
          step_id: "deploy",
          capability_id: "deploy.production",
          output_ref: "artifact://artifact_1",
          verification_status: "passed",
        }],
      }),
      terminalEvent(14),
    ]);

    const w = watcher(ingress, host);
    w.resumeCardForRun("run_1", "card-old", "turn_1", "feishu:old:run_1", false, "cardkit-old");
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);

    const updates = vi.mocked(host.updateCard).mock.calls
      .map((call) => JSON.stringify(call[1]));
    expect(updates.some((content) =>
      content.includes("/flow approve") && content.includes("Web Workbench")
    )).toBe(true);
    const final = updates.at(-1)!;
    expect(final).toContain("Flow 结果 · 成功");
    expect(final).toContain("Flow 批量草稿 · ready");
    expect(final).toContain("flow_deploy");
    expect(final).toContain("deploy.output.json");
    expect(final.match(/deploy.output.json/g)).toHaveLength(1);
    expect(ingress.completeDelivery).toHaveBeenCalledTimes(1);
    w.abort();
  });

  it("keeps one Flow save request notice on the same card through replay and Run completion", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    const requested = flowSaveRequestedEvent(7);
    let releasePostTerminal!: () => void;
    let markPostTerminalProcessed!: () => void;
    const postTerminalGate = new Promise<void>((resolve) => {
      releasePostTerminal = resolve;
    });
    const postTerminalProcessed = new Promise<void>((resolve) => {
      markPostTerminalProcessed = resolve;
    });
    ingress.events = vi.fn(async function* (
      _sessionId: string,
      opts: { signal: AbortSignal },
    ) {
      yield requested;
      yield requested;
      yield terminalEvent(8);
      await postTerminalGate;
      yield {
        ...requested,
        type: "FLOW_SAVE_DISMISSED",
        sequence: 9,
      };
      yield {
        ...requested,
        type: "FLOW_CANDIDATE_CREATED",
        sequence: 10,
      };
      markPostTerminalProcessed();
      await new Promise<void>((resolve) =>
        opts.signal.addEventListener("abort", () => resolve()),
      );
    });

    const w = watcher(ingress, host);
    w.resumeCardForRun(
      "run_1",
      "card-old",
      "turn_1",
      "feishu:old:run_1",
      false,
      "cardkit-old",
    );
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);
    const writesAtTerminal = vi.mocked(host.updateCard).mock.calls.length;
    releasePostTerminal();
    await postTerminalProcessed;

    const final = JSON.stringify(vi.mocked(host.updateCard).mock.calls.at(-1));
    expect(final).toContain("✅ **已完成**");
    expect(final.match(/已记录“存为 Flow”请求。请前往 Web 确认；尚未创建 Candidate。/g))
      .toHaveLength(1);
    expect(vi.mocked(host.updateCard).mock.calls.every(([cardId]) =>
      cardId === "cardkit-old"
    )).toBe(true);
    expect(host.sendMarkdown).not.toHaveBeenCalled();
    expect(host.updateCard).toHaveBeenCalledTimes(writesAtTerminal);
    expect(ingress.events).toHaveBeenCalledTimes(1);
    expect(ingress.completeDelivery).toHaveBeenCalledTimes(1);
    w.abort();
  });

  it("ignores a foreign Run save request before projecting the matching Run", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    let releaseForeign!: () => void;
    let markForeignProcessed!: () => void;
    let markMatchingProcessed!: () => void;
    const foreignGate = new Promise<void>((resolve) => {
      releaseForeign = resolve;
    });
    const foreignProcessed = new Promise<void>((resolve) => {
      markForeignProcessed = resolve;
    });
    const matchingProcessed = new Promise<void>((resolve) => {
      markMatchingProcessed = resolve;
    });
    ingress.events = vi.fn(async function* (
      _sessionId: string,
      opts: { signal: AbortSignal },
    ) {
      yield flowSaveRequestedEvent(7, "run_2");
      markForeignProcessed();
      await foreignGate;
      yield flowSaveRequestedEvent(8, "run_1");
      markMatchingProcessed();
      await new Promise<void>((resolve) =>
        opts.signal.addEventListener("abort", () => resolve()),
      );
    });

    const w = watcher(ingress, host);
    w.resumeCardForRun(
      "run_1",
      "card-old",
      "turn_1",
      "feishu:old:run_1",
      false,
      "cardkit-old",
    );
    w.start(0);

    await foreignProcessed;
    const writesAfterForeign = vi.mocked(host.updateCard).mock.calls.length;
    expect(JSON.stringify(vi.mocked(host.updateCard).mock.calls.at(-1)))
      .not.toContain("已记录“存为 Flow”请求");
    expect(host.sendMarkdown).not.toHaveBeenCalled();

    releaseForeign();
    await matchingProcessed;

    expect(vi.mocked(host.updateCard).mock.calls.length)
      .toBeGreaterThan(writesAfterForeign);
    expect(JSON.stringify(vi.mocked(host.updateCard).mock.calls.at(-1)))
      .toContain("已记录“存为 Flow”请求。请前往 Web 确认；尚未创建 Candidate。");
    expect(host.sendMarkdown).not.toHaveBeenCalled();
    w.abort();
  });

  it.each([
    ["RUN_SUCCEEDED", "✅ **已完成**"],
    ["RUN_FAILED", "❌ **已失败**"],
    ["RUN_CANCELLED", "⏹ **已停止**"],
    ["RUN_INTERRUPTED", "⚠️ **已中断**"],
  ] as const)("keeps the %s status on a recovered terminal card", async (type, title) => {
    const { host } = makeHost();
    const ingress = makeIngress();
    ingress.events = blockingEvents([terminalEvent(9, type)]);

    const w = watcher(ingress, host);
    w.resumeCardForRun("run_1", "card-old", "turn_1", "feishu:old:run_1", false, "cardkit-old");
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);

    expect(JSON.stringify(vi.mocked(host.updateCard).mock.calls.at(-1))).toContain(title);
    w.abort();
  });

  it("does not advance the cursor when completeDelivery returns false", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    let completes = 0;
    ingress.completeDelivery = vi.fn(async () => {
      completes += 1;
      return completes > 1;
    });
    ingress.events = blockingEvents([terminalEvent(9)]);

    const w = watcher(ingress, host);
    w.resumeCardForRun("run_1", "card-old", "turn_1", "feishu:old:run_1", false, "cardkit-old");
    w.start(0);

    await waitUntil(() => completes >= 2);

    const calls = ingress.events.mock.calls as unknown as Array<
      [string, { afterSequence: number }]
    >;
    expect(calls[0]?.[1]).toMatchObject({ afterSequence: 0 });
    expect(calls[1]?.[1]).toMatchObject({ afterSequence: 0 });
    w.abort();
  });

  it("does not advance the cursor when ack fails and aborts the card", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    let acks = 0;
    ingress.ackDelivery = vi.fn(async () => {
      acks += 1;
      return false;
    });
    ingress.events = blockingEvents([dispatchedEvent(5)]);

    const w = watcher(ingress, host);
    w.registerPendingTurn("turn_1", turn());
    w.start(0);

    await waitUntil(() => acks >= 2);

    const calls = ingress.events.mock.calls as unknown as Array<
      [string, { afterSequence: number }]
    >;
    expect(calls[0]?.[1]).toMatchObject({ afterSequence: 0 });
    expect(calls[1]?.[1]).toMatchObject({ afterSequence: 0 });
    expect(ingress.completeDelivery).not.toHaveBeenCalled();
    w.abort();
  });

  it("replays the terminal and skips complete when updateCard keeps failing", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    let updates = 0;
    host.updateCard = vi.fn(async () => {
      updates += 1;
      throw new Error("update boom");
    });
    ingress.events = blockingEvents([
      {
        type: "AGENT_EVENT",
        sequence: 7,
        runId: "run_1",
        executionKind: "agent",
        occurredAt: "2026-08-21T10:00:07.000Z",
        target: null,
        resultRef: null,
        payload: { event: { type: "text_delta", text: "final" } },
      },
      terminalEvent(9),
    ]);

    const w = watcher(ingress, host);
    w.resumeCardForRun("run_1", "card-old", "turn_1", "feishu:old:run_1", false, "cardkit-old");
    w.start(0);

    await waitUntil(() => ingress.events.mock.calls.length >= 2);

    const calls = ingress.events.mock.calls as unknown as Array<
      [string, { afterSequence: number }]
    >;
    // AGENT_EVENT(7) 成功推进到 7；terminal(9) 失败后按 7 重连，而非 0
    expect(calls[0]?.[1]).toMatchObject({ afterSequence: 0 });
    expect(calls[1]?.[1]).toMatchObject({ afterSequence: 7 });
    expect(ingress.completeDelivery).not.toHaveBeenCalled();
    w.abort();
  });

  it("excludes commentary from the recovered final answer", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    ingress.events = blockingEvents([
      {
        type: "AGENT_EVENT",
        sequence: 7,
        runId: "run_1",
        executionKind: "agent",
        occurredAt: "2026-08-21T10:00:07.000Z",
        target: null,
        resultRef: null,
        payload: {
          event: { type: "text_delta", phase: "commentary", text: "thinking…" },
        },
      },
      {
        type: "AGENT_EVENT",
        sequence: 8,
        runId: "run_1",
        executionKind: "agent",
        occurredAt: "2026-08-21T10:00:08.000Z",
        target: null,
        resultRef: null,
        payload: { event: { type: "text_delta", text: "final answer" } },
      },
      terminalEvent(9),
    ]);

    const w = watcher(ingress, host);
    w.resumeCardForRun("run_1", "card-old", "turn_1", "feishu:old:run_1", false, "cardkit-old");
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);

    expect(host.updateCard).toHaveBeenCalledWith(
      "cardkit-old",
      expect.objectContaining({
        body: {
          elements: [{
            tag: "markdown",
            content: expect.stringContaining("final answer"),
          }],
        },
      }),
    );
    expect(JSON.stringify(vi.mocked(host.updateCard).mock.calls.at(-1))).not.toContain(
      "thinking…",
    );
    w.abort();
  });

  it("does not reconnect after abort and starts one subscription", async () => {
    const { host } = makeHost();
    const ingress = makeIngress();
    ingress.events = blockingEvents([dispatchedEvent(5)]);

    const w = watcher(ingress, host);
    w.registerPendingTurn("turn_1", turn());
    w.start(0);
    w.start(0); // 幂等：不产生第二个订阅

    await waitUntil(() => ingress.claimDelivery.mock.calls.length >= 1);
    w.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(ingress.events).toHaveBeenCalledTimes(1);
  });
});

describe("FeishuRunCard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps one Flow save request footer on the live card through terminal rendering", async () => {
    const contents: string[] = [];
    const sendMarkdown = vi.fn(async () => {});
    const host: FeishuCardHost = {
      channel: {
        stream: async (
          _chatId: string,
          input: {
            markdown(controller: {
              cardId: string;
              messageId: string;
              setContent(full: string): Promise<void>;
            }): Promise<void>;
          },
        ) => {
          void input.markdown({
            cardId: "cardkit-1",
            messageId: "card-1",
            setContent: async (full) => {
              contents.push(full);
            },
          }).catch(() => {});
        },
      } as never,
      sendMarkdown,
      updateCard: async () => {},
      registerPendingStream: () => {},
      clearPendingStream: () => {},
      log: () => {},
      isDisconnecting: () => false,
    };
    const card = new FeishuRunCard(host, "chat", "src", "run_1", false);
    await card.open();
    await card.onFlowSaveRequested();
    await card.onFlowSaveRequested();
    await card.finalize("succeeded");

    expect(contents.at(-1)).toContain("✅ **已完成**");
    expect(contents.at(-1)?.match(
      /已记录“存为 Flow”请求。请前往 Web 确认；尚未创建 Candidate。/g,
    )).toHaveLength(1);
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it("keeps a ten-minute run and its terminal result on the original card", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
    const contents: string[] = [];
    const sendMarkdown = vi.fn(async () => {});
    const host: FeishuCardHost = {
      channel: {
        stream: async (
          _chatId: string,
          input: {
            markdown(controller: {
              cardId: string;
              messageId: string;
              setContent(full: string): Promise<void>;
            }): Promise<void>;
          },
        ) => {
          void input.markdown({
            cardId: "cardkit-1",
            messageId: "card-1",
            setContent: async (full) => {
              contents.push(full);
            },
          }).catch(() => {});
        },
      } as never,
      sendMarkdown,
      updateCard: async () => {},
      registerPendingStream: () => {},
      clearPendingStream: () => {},
      log: () => {},
      isDisconnecting: () => false,
    };
    const card = new FeishuRunCard(host, "chat", "src", "run_1", false);
    await card.open();
    await card.onAgentEvent({
      type: "text_delta",
      phase: "commentary",
      messageId: "checkpoint-1",
      text: "P3 正在推进",
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await card.reconcileRun({
      status: "running",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:10:00.000Z",
      leaseExpiresAt: "2026-08-25T00:11:00.000Z",
      terminalReason: null,
      sessionActiveRunId: "run_1",
      sessionQueueState: "ready",
    }, "connected");

    expect(sendMarkdown).not.toHaveBeenCalled();
    expect(contents.at(-1)).toContain("已运行 10 分 0 秒");

    await card.onAgentEvent({
      type: "text_delta",
      phase: "final_answer",
      messageId: "final-1",
      text: "最终结果",
    });
    await card.finalize("succeeded");

    expect(contents.at(-1)).toContain("✅ **已完成**");
    expect(contents.at(-1)).toContain("最终结果");
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it("does not create a detached notice when terminal completion races the old boundary", async () => {
    vi.useFakeTimers();
    const sendMarkdown = vi.fn(async () => {});
    let rendered = "";
    const host: FeishuCardHost = {
      channel: {
        stream: async (
          _chatId: string,
          input: {
            markdown(controller: {
              cardId: string;
              messageId: string;
              setContent(full: string): Promise<void>;
            }): Promise<void>;
          },
        ) => {
          void input.markdown({
            cardId: "cardkit-1",
            messageId: "card-1",
            setContent: async (full) => {
              rendered = full;
            },
          }).catch(() => {});
        },
      } as never,
      sendMarkdown,
      updateCard: async () => {},
      registerPendingStream: () => {},
      clearPendingStream: () => {},
      log: () => {},
      isDisconnecting: () => false,
    };
    const card = new FeishuRunCard(host, "chat", "src", "run_1", false);
    await card.open();
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);

    await card.finalize("succeeded");
    await vi.advanceTimersByTimeAsync(1);

    expect(rendered).toContain("✅ **已完成**");
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it("does not repeat or roll back commentary around tool calls", async () => {
    const contents: string[] = [];
    const host: FeishuCardHost = {
      channel: {
        stream: async (
          _chatId: string,
          input: {
            markdown(controller: {
              messageId: string;
              setContent(full: string): Promise<void>;
            }): Promise<void>;
          },
        ) => {
          void input.markdown({
            messageId: "card-1",
            setContent: async (full) => {
              contents.push(full);
            },
          }).catch(() => {});
        },
      } as never,
      sendMarkdown: async () => {},
      updateCard: async () => {},
      registerPendingStream: () => {},
      clearPendingStream: () => {},
      log: () => {},
      isDisconnecting: () => false,
    };
    const card = new FeishuRunCard(host, "chat", "src", "run_1", false);
    await card.open();
    await card.onAgentEvent({
      type: "text_delta",
      phase: "commentary",
      messageId: "m1",
      text: "你好",
    });
    await card.onAgentEvent({
      type: "tool_start",
      toolCallId: "tool-1",
      name: "Read",
    });
    await card.onAgentEvent({
      type: "tool_end",
      toolCallId: "tool-1",
      name: "Read",
    });
    await card.onAgentEvent({
      type: "text_delta",
      phase: "commentary",
      messageId: "m1",
      text: "你好，我来帮你处理",
    });
    await card.onAgentEvent({
      type: "text_delta",
      phase: "commentary",
      messageId: "m2",
      text: "你好",
    });
    await card.onAgentEvent({
      type: "text_delta",
      phase: "commentary",
      messageId: "m2",
      text: "你好",
    });

    await waitUntil(() => contents.at(-1)?.includes("你好，我来帮你处理") === true);
    const live = contents.at(-1)!;
    expect(live).toContain("🟢 **执行中**");
    expect(live.match(/你好/g)).toHaveLength(1);

    await card.onAgentEvent({
      type: "text_delta",
      phase: "final_answer",
      messageId: "final-1",
      text: "已处理完成",
    });
    await card.finalize("succeeded");

    expect(contents.at(-1)).toContain("✅ **已完成**");
    expect(contents.at(-1)).toContain("已处理完成");
  });

  it("refreshes live status when thinking is hidden but tools are running", async () => {
    const contents: string[] = [];
    const host: FeishuCardHost = {
      channel: {
        stream: async (
          _chatId: string,
          input: {
            markdown(controller: {
              messageId: string;
              setContent(full: string): Promise<void>;
            }): Promise<void>;
          },
        ) => {
          void input.markdown({
            messageId: "card-1",
            setContent: async (full) => {
              contents.push(full);
            },
          }).catch(() => {});
        },
      } as never,
      sendMarkdown: async () => {},
      updateCard: async () => {},
      registerPendingStream: () => {},
      clearPendingStream: () => {},
      log: () => {},
      isDisconnecting: () => false,
    };
    const card = new FeishuRunCard(host, "chat", "src", "run_1", false);
    await card.open();
    await card.onAgentEvent({
      type: "tool_start",
      name: "Bash",
      toolCallId: "tool-1",
    });
    expect(contents.at(-1)).toContain("工具执行：Bash");
    expect(contents.at(-1)).toContain("执行中");
    expect(contents.join("")).not.toContain("- `Bash`");
    card.abort();
  });
});
