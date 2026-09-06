import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type ChannelSessionIngress } from "@codebridge/core";
import { FeishuBridge, type FeishuMessage } from "./bridge.js";

const lifecycleHandlers = new Map<string, () => void>();

async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 2_000) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type TestableBridge = {
  channel: {
    stream(
      chatId: string,
      input: {
        markdown(controller: {
          cardId: string;
          messageId: string;
          append(chunk: string): Promise<void>;
          setContent(full: string): Promise<void>;
        }): Promise<void>;
      },
    ): Promise<void>;
    disconnect(): Promise<void>;
  };
  orchestrator: {
    router: {
      getBinding(chatId: string, topicId?: string): { showThinking: boolean };
      buildSlot(chatId: string, topicId?: string): { agentId: string; workspaceKey: string; generation: number };
    };
    cancelActiveForChat(chatId: string, topicId?: string): Promise<boolean>;
    runAgent(): AsyncGenerator<never>;
  };
  sessionIngress?: ChannelSessionIngress;
  streamAgentReply(message: FeishuMessage, prompt: string, topicId?: string): Promise<void>;
  disconnect(): Promise<void>;
};

function message(id: string): FeishuMessage {
  return {
    messageId: id,
    chatId: "chat-1",
    chatType: "p2p",
    senderId: "user-1",
    content: "hello",
  };
}

describe("FeishuBridge stream lifecycle", () => {
  beforeEach(() => lifecycleHandlers.clear());

  it("reconciles immediately after the Feishu WebSocket reconnects", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lifecycle-"));
    const listDeliveries = vi.fn(async () => []);
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir,
      sessionIngress: {
        listDeliveries,
      } as unknown as ChannelSessionIngress,
    }) as unknown as {
      channel: {
        botIdentity: { name: string };
        on(event: string, handler: () => void): void;
        connect(): Promise<void>;
        disconnect(): Promise<void>;
      };
      connect(): Promise<void>;
      disconnect(): Promise<void>;
    };
    bridge.channel = undefined as never;

    const sdk = await import("@larksuiteoapi/node-sdk");
    const fakeChannel = {
      botIdentity: { name: "test" },
      dispatcher: { register: vi.fn() },
      on: (event: string, handler: () => void) => lifecycleHandlers.set(event, handler),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      updatePolicy: vi.fn(),
    };
    const createLarkChannel = vi
      .spyOn(sdk, "createLarkChannel")
      .mockReturnValueOnce(fakeChannel as never);

    await bridge.connect();
    expect(createLarkChannel).toHaveBeenCalledWith(
      expect.objectContaining({ includeRawEvent: true }),
    );
    expect(listDeliveries).toHaveBeenCalledTimes(1);

    lifecycleHandlers.get("reconnected")?.();
    await waitUntil(() => listDeliveries.mock.calls.length === 2);
    expect(listDeliveries).toHaveBeenCalledTimes(2);
    await bridge.disconnect();
  });

  it("recovers legacy interactive card text from the raw inbound event", async () => {
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir: os.tmpdir(),
    }) as unknown as {
      dispatchInboundMessage(msg: {
        messageId: string;
        chatId: string;
        chatType: "p2p";
        senderId: string;
        content: string;
        rawContentType: string;
        raw: unknown;
      }): Promise<void>;
      handleMessage(msg: FeishuMessage): Promise<void>;
    };
    const handleMessage = vi.fn(async () => {});
    bridge.handleMessage = handleMessage;

    const rawContent = JSON.stringify({
      title: "【协议签约】续费定时任务-扣款失败",
      elements: [
        [
          { tag: "text", text: "error_code:" },
          { tag: "text", text: "\n2000305" },
        ],
        [
          { tag: "text", text: "order_id:" },
          { tag: "text", text: "\nBJN695XYKLF9MPKX5L" },
        ],
      ],
    });

    await bridge.dispatchInboundMessage({
      messageId: "om_legacy_card",
      chatId: "chat-1",
      chatType: "p2p",
      senderId: "user-1",
      content: "[interactive card]",
      rawContentType: "interactive",
      raw: { message: { content: rawContent } },
    });

    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("【协议签约】续费定时任务-扣款失败"),
      }),
    );
    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("BJN695XYKLF9MPKX5L"),
      }),
    );
    expect(handleMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: "[interactive card]" }),
    );
  });

  it.each([
    ["malformed JSON", { message: { content: "{" } }],
    ["whitespace", { message: { content: "   " } }],
    ["empty object", { message: { content: "{}" } }],
    ["missing raw event", undefined],
  ])("keeps the interactive placeholder for %s", async (_case, raw) => {
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir: os.tmpdir(),
    }) as unknown as {
      dispatchInboundMessage(msg: {
        messageId: string;
        chatId: string;
        chatType: "p2p";
        senderId: string;
        content: string;
        rawContentType: string;
        raw: unknown;
      }): Promise<void>;
      handleMessage(msg: FeishuMessage): Promise<void>;
    };
    const handleMessage = vi.fn(async () => {});
    bridge.handleMessage = handleMessage;

    await bridge.dispatchInboundMessage({
      messageId: "om_invalid_card",
      chatId: "chat-1",
      chatType: "p2p",
      senderId: "user-1",
      content: "[interactive card]",
      rawContentType: "interactive",
      raw,
    });

    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "[interactive card]" }),
    );
  });

  it("preserves content already normalized by the SDK", async () => {
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir: os.tmpdir(),
    }) as unknown as {
      dispatchInboundMessage(msg: {
        messageId: string;
        chatId: string;
        chatType: "p2p";
        senderId: string;
        content: string;
        rawContentType: string;
        raw: unknown;
      }): Promise<void>;
      handleMessage(msg: FeishuMessage): Promise<void>;
    };
    const handleMessage = vi.fn(async () => {});
    bridge.handleMessage = handleMessage;

    await bridge.dispatchInboundMessage({
      messageId: "om_modern_card",
      chatId: "chat-1",
      chatType: "p2p",
      senderId: "user-1",
      content: "Card title\nCard content",
      rawContentType: "interactive",
      raw: { message: { content: "{}" } },
    });

    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Card title\nCard content" }),
    );
  });

  it("streams two runs without aborting each other", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lifecycle-"));
    const bridge = new FeishuBridge({ config: defaultConfig(), dataDir }) as unknown as TestableBridge & {
      streamAgentReply(
        m: FeishuMessage,
        p: string,
        t: string | undefined,
        s?: string,
        r?: string | null,
        a?: number,
      ): Promise<void>;
    };
    const rendered: string[] = [];
    bridge.sessionIngress = {
      events: async function* () {
        yield { type: "AGENT_EVENT", sequence: 1, runId: "run_1", target: null, payload: { event: { type: "text_delta", text: "reply" } } };
        yield { type: "RUN_SUCCEEDED", sequence: 2, runId: "run_1", target: null, payload: {} };
        await new Promise(() => {});
      },
    } as unknown as ChannelSessionIngress;
    bridge.channel = {
      async stream(_chatId, input) {
        let out = "";
        await input.markdown({
          cardId: "cardkit-1",
          messageId: "card-1",
          async append(chunk: string) { out += chunk; },
          async setContent(full: string) { out = full; },
        });
        rendered.push(out);
      },
      async disconnect() {},
    };

    await bridge.streamAgentReply(message("m1"), "one", undefined, "sess_1", "run_1", 0);
    await bridge.streamAgentReply(message("m2"), "two", undefined, "sess_1", "run_1", 0);

    expect(rendered).toHaveLength(2);
  });

  it("aborts an in-flight stream on disconnect", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lifecycle-"));
    const bridge = new FeishuBridge({ config: defaultConfig(), dataDir }) as unknown as TestableBridge & {
      streamAgentReply(
        m: FeishuMessage,
        p: string,
        t: string | undefined,
        s?: string,
        r?: string | null,
        a?: number,
      ): Promise<void>;
    };
    let capturedSignal: AbortSignal | undefined;
    bridge.sessionIngress = {
      events: async function* (
        _sessionId: string,
        opts: { afterSequence: number; signal: AbortSignal },
      ) {
        capturedSignal = opts.signal;
        yield { type: "AGENT_EVENT", sequence: 1, runId: "run_1", target: null, payload: { event: { type: "text_delta", text: "hi" } } };
        await new Promise<void>((resolve) =>
          opts.signal?.addEventListener("abort", () => resolve()),
        );
      },
    } as unknown as ChannelSessionIngress;
    bridge.channel = {
      async stream(_chatId, input) {
        await input.markdown({
          cardId: "cardkit-1",
          messageId: "card-1",
          async append() {},
          async setContent() {},
        });
      },
      async disconnect() {},
    };

    const streamPromise = bridge.streamAgentReply(message("m1"), "hi", undefined, "sess_1", "run_1", 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await bridge.disconnect();

    expect(capturedSignal?.aborted).toBe(true);
    await streamPromise;
  });

  it("stops only the current slot's active run through the command context", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lifecycle-"));
    const bridge = new FeishuBridge({ config: defaultConfig(), dataDir }) as unknown as TestableBridge & {
      handleMessage(m: FeishuMessage): Promise<void>;
    };
    const getSlotCommandContext = vi.fn().mockResolvedValue({
      sessionId: "sess_pi",
      activeRunId: "run_pi",
    });
    const cancelRun = vi.fn().mockResolvedValue(true);
    bridge.sessionIngress = {
      getSlotCommandContext,
      cancelRun,
      resetSlot: async () => true,
      resolvePermission: async () => true,
      submit: async () => ({
        sessionId: "sess_pi",
        turnId: "turn_1",
        runId: "run_pi",
        acceptance: "dispatched",
        queueState: "ready",
        eventSequence: 0,
      }),
      events: async function* () {},
      listDeliveries: async () => [],
      claimDelivery: async () => true,
      ackDelivery: async () => true,
      completeDelivery: async () => true,
    } as unknown as ChannelSessionIngress;
    bridge.orchestrator = {
      router: {
        getBinding: () => ({ showThinking: false, backendId: "pi", cwd: "/tmp/p" }) as never,
        buildSlot: () => ({ agentId: "pi", workspaceKey: "/tmp/p", generation: 0 }) as never,
      },
      listSessions: async () => [],
      bindSession: () => {},
      closeSession: async () => ({ ok: true }),
      deleteSession: async () => ({ ok: true }),
      listConfigOptions: async () => [],
      hasActiveRun: () => false,
      activeRunElapsedMs: () => undefined,
      activeRunStatus: () => undefined,
      steerActiveForChat: async () => ({ ok: false }),
      resolveActivePermission: async () => false,
      cancelActiveForChat: async () => false,
      authorizeDirectory: async () => ({ ok: true }),
      runAgent: async function* () {},
    } as never;
    bridge.channel = {
      async stream() {},
      async send() {},
      async disconnect() {},
    } as never;

    await bridge.handleMessage({
      messageId: "m1",
      chatId: "chat",
      chatType: "p2p",
      senderId: "user",
      content: "/stop",
    });

    expect(getSlotCommandContext).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "feishu",
        agentId: "pi",
        workspaceKey: "/tmp/p",
        generation: 0,
      }),
    );
    expect(cancelRun).toHaveBeenCalledWith("sess_pi", "run_pi");
  });

  it("uses the Feishu message id as the queue-resume command id", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lifecycle-"));
    const bridge = new FeishuBridge({ config: defaultConfig(), dataDir }) as unknown as TestableBridge & {
      handleMessage(m: FeishuMessage): Promise<void>;
    };
    const resumeQueue = vi.fn().mockResolvedValue({ queueState: "ready" });
    bridge.sessionIngress = {
      getSlotCommandContext: vi.fn().mockResolvedValue({
        sessionId: "sess_pi",
        activeRunId: null,
        providerSessionId: null,
      }),
      resumeQueue,
    } as unknown as ChannelSessionIngress;
    bridge.orchestrator = {
      router: {
        getBinding: () => ({ showThinking: false, backendId: "pi", cwd: "/tmp/p" }) as never,
        buildSlot: () => ({ agentId: "pi", workspaceKey: "/tmp/p", generation: 0 }) as never,
      },
      listSessions: async () => [],
      bindSession: () => {},
      closeSession: async () => ({ ok: true }),
      deleteSession: async () => ({ ok: true }),
      listConfigOptions: async () => [],
      hasActiveRun: () => false,
      activeRunElapsedMs: () => undefined,
      activeRunStatus: () => undefined,
      steerActiveForChat: async () => ({ ok: false }),
      resolveActivePermission: async () => false,
      cancelActiveForChat: async () => false,
      authorizeDirectory: async () => ({ ok: true }),
      runAgent: async function* () {},
    } as never;
    bridge.channel = {
      async stream() {},
      async send() {},
      async disconnect() {},
    } as never;

    await bridge.handleMessage({
      messageId: "message-A",
      chatId: "chat",
      chatType: "p2p",
      senderId: "user",
      content: "/c",
    });

    expect(resumeQueue).toHaveBeenCalledWith(
      "sess_pi",
      "feishu:message-A",
    );
  });

  it("streams a dispatched run through submit + events", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lifecycle-"));
    const bridge = new FeishuBridge({ config: defaultConfig(), dataDir }) as unknown as TestableBridge & {
      streamAgentReply(
        m: FeishuMessage,
        p: string,
        t: string | undefined,
        s?: string,
        r?: string | null,
        a?: number,
      ): Promise<void>;
    };
    let rendered = "";
    bridge.sessionIngress = {
      submit: async () => ({
        sessionId: "sess_1",
        turnId: "turn_1",
        runId: "run_1",
        acceptance: "dispatched",
        queueState: "ready",
        eventSequence: 3,
      }),
      events: async function* () {
        yield { type: "AGENT_EVENT", sequence: 4, runId: "run_1", target: null, payload: { event: { type: "text_delta", text: "hi" } } };
        yield { type: "RUN_SUCCEEDED", sequence: 5, runId: "run_1", target: null, payload: {} };
      },
    } as unknown as ChannelSessionIngress;
    bridge.channel = {
      async stream(_chatId, input) {
        await input.markdown({
          cardId: "cardkit-1", messageId: "card-1",
          async append(chunk: string) { rendered += chunk; },
          async setContent(full: string) { rendered = full; },
        });
      },
      async disconnect() {},
    };

    await bridge.streamAgentReply(message("m1"), "hi", undefined, "sess_1", "run_1", 3);
    expect(rendered).toContain("hi");
  });

  it("submits once and routes only the dispatched run through the watcher", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lifecycle-"));
    const bridge = new FeishuBridge({ config: defaultConfig(), dataDir }) as unknown as TestableBridge & {
      submitAndStream(m: FeishuMessage, p: string, t?: string): Promise<void>;
    };
    let rendered = "";
    const submit = vi.fn().mockResolvedValue({
      sessionId: "sess_1",
      turnId: "turn_1",
      runId: "run_1",
      acceptance: "dispatched",
      queueState: "ready",
      eventSequence: 3,
    });
    const events = vi.fn(async function* () {
      yield { type: "TURN_DISPATCHED", sequence: 3, runId: "run_1", target: "turn_1", payload: {} };
      yield { type: "AGENT_EVENT", sequence: 4, runId: "run_1", target: null, payload: { event: { type: "text_delta", text: "own" } } };
      yield { type: "AGENT_EVENT", sequence: 5, runId: "run_2", target: null, payload: { event: { type: "text_delta", text: "other" } } };
      yield { type: "RUN_SUCCEEDED", sequence: 6, runId: "run_1", target: null, payload: {} };
      await new Promise(() => {}); // 模拟 live SSE 保持打开
    });
    const claim = vi.fn().mockResolvedValue(true);
    const ack = vi.fn().mockResolvedValue(true);
    const complete = vi.fn().mockResolvedValue(true);
    bridge.sessionIngress = {
      submit,
      events,
      claimDelivery: claim,
      ackDelivery: ack,
      completeDelivery: complete,
      listDeliveries: async () => [],
    } as unknown as ChannelSessionIngress;
    bridge.channel = {
      rawClient: {
        cardkit: {v1: {card: {
          create: async () => ({code: 0, data: {card_id: "cardkit-1"}}),
          idConvert: async () => ({code: 0, data: {card_id: "cardkit-1"}}),
          update: async (request: {data: {card: {data: string}}}) => {
            rendered = JSON.parse(request.data.card.data).body.elements[0].content;
            return {code: 0};
          },
        }}},
        im: {v1: {message: {reply: async () => ({code: 0, data: {message_id: "card-1"}})}}},
      },
      async disconnect() {},
    } as unknown as TestableBridge["channel"];
    bridge.orchestrator = {
      router: {
        getBinding: () => ({ showThinking: false, backendId: "pi", cwd: "/tmp/p" }) as never,
        buildSlot: () => ({ agentId: "pi", workspaceKey: "/tmp/p", generation: 0 }) as never,
      },
      cancelActiveForChat: async () => false,
      runAgent: async function* () {},
    };

    await bridge.submitAndStream(message("m1"), "hi");
    await waitUntil(() => complete.mock.calls.length === 1);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      actorRef: { channel: "feishu", id: "user-1" },
      replyToMessageId: "m1",
      showThinking: false,
    }));
    expect(events).toHaveBeenCalledWith(
      "sess_1",
      expect.objectContaining({ afterSequence: 3 }),
    );
    expect(claim).toHaveBeenCalledWith(
      "turn_1",
      expect.stringMatching(/^feishu:.+:run_1$/),
    );
    expect(ack).toHaveBeenCalledWith(
      "turn_1",
      expect.stringMatching(/^feishu:.+:run_1$/),
      "card-1",
      "cardkit-1",
    );
    expect(complete).toHaveBeenCalledWith(
      "turn_1",
      expect.stringMatching(/^feishu:.+:run_1$/),
    );
    expect(rendered).toContain("own");
    expect(rendered).not.toContain("other");
  });
});
