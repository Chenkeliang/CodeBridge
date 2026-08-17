import { describe, expect, it, vi } from "vitest";
import type {
  ChannelSessionEvent,
  ChannelSessionIngress,
} from "@codebridge/core";
import {
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
    target: "turn_1",
    payload: {},
  };
}

function terminalEvent(sequence: number): ChannelSessionEvent {
  return {
    type: "RUN_SUCCEEDED",
    sequence,
    runId: "run_1",
    target: null,
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
        target: null,
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
        body: { elements: [{ tag: "markdown", content: "final answer" }] },
      }),
    );
    expect(ingress.completeDelivery).toHaveBeenCalledWith(
      "turn_1",
      "feishu:old:run_1",
    );
    expect(ingress.claimDelivery).not.toHaveBeenCalled();
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
        target: null,
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
        target: null,
        payload: {
          event: { type: "text_delta", phase: "commentary", text: "thinking…" },
        },
      },
      {
        type: "AGENT_EVENT",
        sequence: 8,
        runId: "run_1",
        target: null,
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
        body: { elements: [{ tag: "markdown", content: "final answer" }] },
      }),
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
