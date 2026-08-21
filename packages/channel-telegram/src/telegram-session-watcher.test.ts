import { describe, expect, it, vi } from "vitest";
import type {
  ChannelSessionEvent,
  ChannelSessionIngress,
} from "@codebridge/core";
import {
  TelegramSessionWatcher,
  type PendingTurn,
} from "./telegram-session-watcher.js";

function makeApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 8 }),
    editMessage: vi.fn().mockResolvedValue({ message_id: 8 }),
  };
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
type Api = ReturnType<typeof makeApi>;

function watcher(ingress: Ingress, api: Api) {
  return new TelegramSessionWatcher(
    api,
    ingress as unknown as ChannelSessionIngress,
    "sess_1",
    "inst-1",
    () => {},
  );
}

function turn(turnId = "turn_1"): PendingTurn {
  return {
    turnId,
    chatId: "telegram:42",
    topicId: undefined,
    showThinking: false,
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

function agentEvent(
  sequence: number,
  event: Record<string, unknown>,
): ChannelSessionEvent {
  return {
    type: "AGENT_EVENT",
    sequence,
    runId: "run_1",
    target: null,
    payload: { event },
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

describe("TelegramSessionWatcher", () => {
  it("renders a dispatched run and completes the delivery", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    ingress.events = blockingEvents([
      agentEvent(2, {
        type: "text_delta",
        phase: "commentary",
        messageId: "checkpoint-1",
        text: "正在处理",
      }),
      agentEvent(3, { type: "tool_start", toolCallId: "t1", name: "Read" }),
      agentEvent(4, { type: "text_delta", text: "answer" }),
      terminalEvent(5),
    ]);

    const w = watcher(ingress, api);
    await w.openRun("run_1", turn());
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);

    expect(api.sendMessage).toHaveBeenCalledWith(
      "telegram:42",
      "⏳ Agent 正在处理…",
      undefined,
    );
    expect(api.editMessage).toHaveBeenCalledWith(
      "telegram:42",
      8,
      "answer",
    );
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.editMessage).toHaveBeenCalledTimes(1);
    expect(ingress.completeDelivery).toHaveBeenCalledWith(
      "turn_1",
      expect.stringMatching(/^telegram:inst-1:run_1$/),
    );
    w.abort();
  });

  it("replays the terminal when the final edit and fallback both fail", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    let edits = 0;
    let sends = 0;
    api.editMessage = vi.fn(async () => {
      edits += 1;
      throw new Error("edit boom");
    });
    api.sendMessage = vi.fn(async () => {
      sends += 1;
      if (sends > 1) throw new Error("send boom");
      return { message_id: 8 };
    });
    ingress.events = blockingEvents([
      agentEvent(4, { type: "text_delta", text: "answer" }),
      terminalEvent(5),
    ]);

    const w = watcher(ingress, api);
    await w.openRun("run_1", turn());
    w.start(0);

    await waitUntil(() => edits >= 2);

    expect(ingress.completeDelivery).not.toHaveBeenCalled();
    w.abort();
  });

  it("notifies on a permission request", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    ingress.events = blockingEvents([
      agentEvent(4, { type: "permission_request", title: "写入文件" }),
      terminalEvent(5),
    ]);

    const w = watcher(ingress, api);
    await w.openRun("run_1", turn());
    w.start(0);

    await waitUntil(
      () =>
        api.sendMessage.mock.calls.some((call) =>
          String(call[1]).includes("Agent 请求权限"),
        ),
    );

    expect(
      api.sendMessage.mock.calls.some((call) =>
        String(call[1]).includes("写入文件"),
      ),
    ).toBe(true);
    w.abort();
  });

  it("recovers a delivering run by editing its existing message", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    ingress.events = blockingEvents([
      agentEvent(4, { type: "text_delta", text: "final" }),
      terminalEvent(5),
    ]);

    const w = watcher(ingress, api);
    w.resumeRun("run_1", "8", "turn_1", "telegram:old:run_1", false, "telegram:42", undefined);
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);

    expect(api.editMessage).toHaveBeenCalledWith("telegram:42", 8, "final");
    expect(ingress.claimDelivery).not.toHaveBeenCalled();
    w.abort();
  });

  it("does not advance the cursor when complete returns false", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    let completes = 0;
    ingress.completeDelivery = vi.fn(async () => {
      completes += 1;
      return completes > 1;
    });
    ingress.events = blockingEvents([terminalEvent(5)]);

    const w = watcher(ingress, api);
    w.resumeRun("run_1", "8", "turn_1", "telegram:old:run_1", false, "telegram:42", undefined);
    w.start(0);

    await waitUntil(() => completes >= 2);

    const calls = ingress.events.mock.calls as unknown as Array<
      [string, { afterSequence: number }]
    >;
    expect(calls[0]?.[1]).toMatchObject({ afterSequence: 0 });
    expect(calls[1]?.[1]).toMatchObject({ afterSequence: 0 });
    w.abort();
  });

  it("replays when the permission notification fails to send", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    let sends = 0;
    api.sendMessage = vi.fn(async () => {
      sends += 1;
      if (sends > 1) throw new Error("send boom");
      return { message_id: 8 };
    });
    ingress.events = blockingEvents([
      agentEvent(4, { type: "permission_request", title: "写入文件" }),
      terminalEvent(5),
    ]);

    const w = watcher(ingress, api);
    await w.openRun("run_1", turn());
    w.start(0);

    await waitUntil(() => sends >= 3);

    expect(ingress.completeDelivery).not.toHaveBeenCalled();
    w.abort();
  });

  it("recovers a pending turn via TURN_DISPATCHED", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    ingress.events = blockingEvents([
      {
        type: "TURN_DISPATCHED",
        sequence: 5,
        runId: "run_1",
        target: "turn_1",
        payload: {},
      },
    ]);

    const w = watcher(ingress, api);
    w.registerPendingTurn("turn_1", turn());
    w.start(0);

    await waitUntil(() => ingress.claimDelivery.mock.calls.length >= 1);

    expect(ingress.claimDelivery).toHaveBeenCalledWith(
      "turn_1",
      expect.stringMatching(/^telegram:inst-1:run_1$/),
    );
    w.abort();
  });

  it("recovers a dispatched delivery by opening its renderer", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    const w = watcher(ingress, api);

    await w.openRun("run_1", turn());

    expect(api.sendMessage).toHaveBeenCalledWith(
      "telegram:42",
      "⏳ Agent 正在处理…",
      undefined,
    );
    expect(ingress.ackDelivery).toHaveBeenCalledWith(
      "turn_1",
      expect.stringMatching(/^telegram:inst-1:run_1$/),
      "8",
    );
    w.abort();
  });

  it("falls back to the topic thread on a delivering run", async () => {
    const api = makeApi();
    const ingress = makeIngress();
    api.editMessage = vi.fn(async () => {
      throw new Error("edit boom");
    });
    ingress.events = blockingEvents([
      agentEvent(4, { type: "text_delta", text: "final" }),
      terminalEvent(5),
    ]);

    const w = watcher(ingress, api);
    w.resumeRun(
      "run_1",
      "8",
      "turn_1",
      "telegram:old:run_1",
      false,
      "telegram:42",
      "12345",
    );
    w.start(0);

    await waitUntil(() => ingress.completeDelivery.mock.calls.length >= 1);

    expect(api.sendMessage).toHaveBeenCalledWith(
      "telegram:42",
      "final",
      "12345",
    );
    w.abort();
  });
});
