import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig, type AgentEvent } from "@codebridge/core";
import { FeishuBridge, type FeishuMessage } from "./bridge.js";

type StreamController = {
  append(chunk: string): Promise<void>;
};

type StreamInput = {
  markdown(controller: StreamController): Promise<void>;
};

type TestableBridge = {
  channel: {
    stream(
      chatId: string,
      input: StreamInput,
      options: { replyTo: string },
    ): Promise<void>;
  };
  orchestrator: {
    router: {
      getBinding(chatId: string, topicId?: string): { showThinking: boolean };
    };
    cancelActiveForChat(chatId: string, topicId?: string): Promise<boolean>;
    runAgent(
      chatId: string,
      topicId: string | undefined,
      prompt: string,
    ): AsyncGenerator<AgentEvent>;
  };
  streamAgentReply(
    message: FeishuMessage,
    prompt: string,
    topicId?: string,
  ): Promise<void>;
  dispatchToAgent(
    message: FeishuMessage,
    prompt: string,
    topicId?: string,
  ): Promise<void>;
};

type MentionTestableBridge = {
  channel?: {
    send(
      chatId: string,
      input: { markdown: string },
      options: unknown,
    ): Promise<void>;
  };
  handleMessage(message: FeishuMessage): Promise<void>;
  dispatchInboundMessage(message: unknown): Promise<void>;
  streamAgentReply(
    message: FeishuMessage,
    prompt: string,
    topicId?: string,
  ): Promise<void>;
  sendOutboundMention(
    chatId: string,
    ref: string,
    text: string,
    topicId?: string,
  ): Promise<void>;
};

function sdkMergeStreamingText(previous: string, next: string): string {
  if (!previous) return next;
  if (!next) return previous;
  if (next.startsWith(previous)) return next;
  if (previous.startsWith(next)) return previous;
  const maxOverlap = Math.min(previous.length, next.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (previous.endsWith(next.slice(0, length))) {
      return previous + next.slice(length);
    }
  }
  return previous + next;
}

async function renderThroughSdk(chunks: string[]): Promise<string> {
  const bridge = new FeishuBridge({
    config: defaultConfig(),
    dataDir: os.tmpdir(),
  }) as unknown as TestableBridge;
  let rendered = "";

  bridge.channel = {
    async stream(_chatId, input) {
      await input.markdown({
        async append(chunk) {
          rendered = sdkMergeStreamingText(rendered, chunk);
        },
      });
    },
  };
  bridge.orchestrator = {
    router: {
      getBinding: () => ({ showThinking: false }),
    },
    cancelActiveForChat: async () => false,
    runAgent: async function* () {
      for (const text of chunks) {
        yield { type: "text_delta", text };
      }
      yield { type: "done", exitCode: 0 };
    },
  };

  await bridge.streamAgentReply(
    {
      messageId: "message-1",
      chatId: "chat-1",
      chatType: "p2p",
      senderId: "user-1",
      content: "test",
    },
    "test",
  );
  return rendered;
}

describe("FeishuBridge streaming", () => {
  it("adds sparse official text-tag guidance to Feishu agent prompts", async () => {
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir: os.tmpdir(),
    }) as unknown as TestableBridge;
    let receivedPrompt = "";

    bridge.streamAgentReply = async (_message, prompt) => {
      receivedPrompt = prompt;
    };

    await bridge.dispatchToAgent(
      {
        messageId: "message-1",
        chatId: "chat-1",
        chatType: "p2p",
        senderId: "user-1",
        content: "总结改动",
      },
      "总结改动",
    );

    expect(receivedPrompt).toMatch(/^总结改动\n\n/);
    expect(receivedPrompt).toContain(
      "<text_tag color='blue'>文本</text_tag>",
    );
    expect(receivedPrompt).toContain("每次最多 3 个");
    expect(receivedPrompt).toContain("不必强行加色");
  });

  it("preserves repeated letters split across ACP deltas", async () => {
    await expect(renderThroughSdk(["Me", "epo"])).resolves.toBe("Meepo");
  });

  it("preserves repeated digits split across ACP deltas", async () => {
    await expect(
      renderThroughSdk(["692818", "820925", "5382", "277A"]),
    ).resolves.toBe("6928188209255382277A");
  });
});

describe("FeishuBridge mentions", () => {
  it("preserves structured inbound mention identities", async () => {
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir: os.tmpdir(),
    }) as unknown as MentionTestableBridge;
    let received: FeishuMessage | undefined;
    bridge.handleMessage = async (message) => {
      received = message;
    };

    await bridge.dispatchInboundMessage({
      messageId: "message-1",
      chatId: "chat-1",
      chatType: "group",
      senderId: "ou_requester",
      senderName: "陈科良",
      content: "请完成后通知 @张三",
      mentionedBot: true,
      mentions: [
        { openId: "ou_zhangsan", name: "张三", isBot: false },
      ],
    });

    expect(received).toMatchObject({
      senderName: "陈科良",
      mentions: [{ openId: "ou_zhangsan", name: "张三", isBot: false }],
    });
  });

  it("guides the Agent and sends a real scoped Feishu mention", async () => {
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir: os.tmpdir(),
    }) as unknown as MentionTestableBridge;
    let receivedPrompt = "";
    bridge.streamAgentReply = async (_message, prompt) => {
      receivedPrompt = prompt;
    };

    await bridge.handleMessage({
      messageId: "message-1",
      chatId: "chat-1",
      chatType: "group",
      senderId: "ou_requester",
      senderName: "陈科良",
      content: "请完成后通知 @张三",
      mentionedBot: true,
      mentions: [
        { openId: "ou_bridge", name: "小库", isBot: true },
        { openId: "ou_zhangsan", name: "张三", isBot: false },
      ],
    });

    expect(receivedPrompt).toContain("fcb mention <对象引用>");
    expect(receivedPrompt).toContain("陈科良（当前发送者）");
    expect(receivedPrompt).toContain("张三");
    expect(receivedPrompt).not.toContain("小库（机器人）");
    const ref = receivedPrompt.match(/- (u\d+)：张三/)?.[1];
    expect(ref).toBeDefined();

    const send = vi.fn().mockResolvedValue(undefined);
    bridge.channel = { send };
    await bridge.sendOutboundMention("chat-1", ref!, "发布已经完成");

    expect(send).toHaveBeenCalledWith(
      "chat-1",
      { markdown: "发布已经完成" },
      {
        mentions: [
          { key: ref, openId: "ou_zhangsan", name: "张三", isBot: false },
        ],
      },
    );
  });
});
