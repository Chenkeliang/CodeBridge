import { describe, expect, it, vi } from "vitest";
import type {
  ChannelSessionEvent,
  ChannelSessionIngress,
} from "@codebridge/core";
import {
  FeishuRunCard,
  FeishuSessionWatcher,
  type FeishuCardHost,
  type PendingTurn,
} from "./session-watcher.js";

function makeHost() {
  const stream = vi.fn(
    async (
      _chatId: string,
      input: {
        markdown(controller: {
          messageId: string;
          setContent(full: string): Promise<void>;
        }): Promise<void>;
      },
      _opts: unknown,
    ) => {
      void input
        .markdown({ messageId: "card-1", setContent: async () => {} })
        .catch(() => {});
    },
  );
  const host: FeishuCardHost = {
    channel: { stream } as never,
    sendMarkdown: async () => {},
    updateCard: vi.fn(async () => {}),
    registerPendingStream: () => {},
    clearPendingStream: () => {},
    log: () => {},
    isDisconnecting: () => false,
  };
  return { host, stream };
}

function makeIngress() {
  return {
    events: vi.fn(async function* () {
      await new Promise(() => {});
    }),
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

function dispatchedEvent(sequence: number): ChannelSessionEvent {
  return {
    type: "TURN_DISPATCHED",
    sequence,
    runId: "run_1",
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
    occurredAt: "2026-08-21T10:01:00.000Z",
    target: null,
    resultRef: null,
    payload: {},
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
        occurredAt: "2026-08-21T10:00:07.000Z",
        target: null,
        resultRef: null,
        payload: { event: { type: "text_delta", text: "final answer" } },
      },
      terminalEvent(9),
    ]);

    const w = watcher(ingress, host);
    w.resumeCardForRun("run_1", "card-old", "turn_1", "feishu:old:run_1", false);
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);

    expect(host.updateCard).toHaveBeenCalledWith(
      "card-old",
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
      flowEvent(12, "RUN_SNAPSHOT", "run_1", {
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
      terminalEvent(13),
    ]);

    const w = watcher(ingress, host);
    w.resumeCardForRun("run_1", "card-old", "turn_1", "feishu:old:run_1", false);
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);

    const updates = vi.mocked(host.updateCard).mock.calls
      .map((call) => JSON.stringify(call[1]));
    expect(updates.some((content) => content.includes("请在 Web 打开当前 Session 完成审批"))).toBe(true);
    const final = updates.at(-1)!;
    expect(final).toContain("Flow 结果 · 成功");
    expect(final).toContain("flow_deploy");
    expect(final).toContain("deploy.output.json");
    expect(final.match(/deploy.output.json/g)).toHaveLength(1);
    expect(ingress.completeDelivery).toHaveBeenCalledTimes(1);
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
    w.resumeCardForRun("run_1", "card-old", "turn_1", "feishu:old:run_1", false);
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
    w.resumeCardForRun("run_1", "card-old", "turn_1", "feishu:old:run_1", false);
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
        occurredAt: "2026-08-21T10:00:07.000Z",
        target: null,
        resultRef: null,
        payload: { event: { type: "text_delta", text: "final" } },
      },
      terminalEvent(9),
    ]);

    const w = watcher(ingress, host);
    w.resumeCardForRun("run_1", "card-old", "turn_1", "feishu:old:run_1", false);
    w.start(0);

    await waitUntil(() => updates >= 2);

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
        occurredAt: "2026-08-21T10:00:08.000Z",
        target: null,
        resultRef: null,
        payload: { event: { type: "text_delta", text: "final answer" } },
      },
      terminalEvent(9),
    ]);

    const w = watcher(ingress, host);
    w.resumeCardForRun("run_1", "card-old", "turn_1", "feishu:old:run_1", false);
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);

    expect(host.updateCard).toHaveBeenCalledWith(
      "card-old",
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
