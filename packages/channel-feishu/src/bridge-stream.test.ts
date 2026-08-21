import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type AgentEvent, type ChannelSessionIngress } from "@codebridge/core";
import { FeishuBridge, type FeishuMessage } from "./bridge.js";
import {
  FEISHU_LIVE_STATUS_QUIET_MS,
  FEISHU_LIVE_STATUS_TICK_MS,
} from "./session-watcher.js";

type StreamController = {
  readonly messageId: string;
  append(chunk: string): Promise<void>;
  setContent(full: string): Promise<void>;
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
    send?(
      chatId: string,
      input: { markdown: string },
      options: { replyTo?: string },
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
  sessionIngress?: ChannelSessionIngress;
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
        messageId: "card-message-1",
        async append(chunk) {
          rendered = sdkMergeStreamingText(rendered, chunk);
        },
        async setContent(full) {
          rendered = full;
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

async function renderAgentRun(
  runAgent: () => AsyncGenerator<AgentEvent>,
): Promise<string> {
  const bridge = new FeishuBridge({
    config: defaultConfig(),
    dataDir: os.tmpdir(),
  }) as unknown as TestableBridge;
  let rendered = "";
  bridge.channel = {
    async stream(_chatId, input) {
      await input.markdown({
        messageId: "card-message-1",
        async append(chunk) {
          rendered = sdkMergeStreamingText(rendered, chunk);
        },
        async setContent(full) {
          rendered = full;
        },
      });
    },
  };
  bridge.orchestrator = {
    router: { getBinding: () => ({ showThinking: false }) },
    cancelActiveForChat: async () => false,
    runAgent,
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
  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists the streaming card until it is finalized", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-stream-"));
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir,
    }) as unknown as TestableBridge;
    const pendingPath = path.join(dataDir, "feishu-pending-streams.json");
    let pendingWhileStreaming: unknown;

    bridge.channel = {
      async stream(_chatId, input) {
        const capturePending = () => {
          pendingWhileStreaming = fs.existsSync(pendingPath)
            ? JSON.parse(fs.readFileSync(pendingPath, "utf8"))
            : undefined;
        };
        await input.markdown({
          messageId: "card-message-1",
          async append() {
            capturePending();
          },
          async setContent() {
            capturePending();
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
        yield { type: "text_delta", text: "完成" };
        yield { type: "done", exitCode: 0 };
      },
    };

    await bridge.streamAgentReply(
      {
        messageId: "source-message-1",
        chatId: "chat-1",
        chatType: "p2p",
        senderId: "user-1",
        content: "test",
      },
      "test",
    );

    expect(pendingWhileStreaming).toMatchObject({
      "card-message-1": {
        chatId: "chat-1",
        sourceMessageId: "source-message-1",
      },
    });
    expect(JSON.parse(fs.readFileSync(pendingPath, "utf8"))).toEqual({});
  });

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
    const rendered = await renderThroughSdk(["Me", "epo"]);
    expect(rendered).toContain("✅ **已完成**");
    expect(rendered).toContain("Meepo");
  });

  it("preserves repeated digits split across ACP deltas", async () => {
    const rendered = await renderThroughSdk([
      "692818",
      "820925",
      "5382",
      "277A",
    ]);
    expect(rendered).toContain("✅ **已完成**");
    expect(rendered).toContain("6928188209255382277A");
  });

  it("does not block ACP event consumption on a slow Feishu card write", async () => {
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir: os.tmpdir(),
    }) as unknown as TestableBridge;
    let reachedDone = false;
    let releaseWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });

    bridge.channel = {
      async stream(_chatId, input) {
        await input.markdown({
          messageId: "card-message-1",
          async append() {},
          async setContent() {
            await blockedWrite;
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
        yield { type: "text_delta", text: "最终结果" };
        reachedDone = true;
        yield { type: "done", exitCode: 0 };
      },
    };

    const running = bridge.streamAgentReply(
      {
        messageId: "message-1",
        chatId: "chat-1",
        chatType: "p2p",
        senderId: "user-1",
        content: "test",
      },
      "test",
    );

    await vi.waitFor(() => expect(reachedDone).toBe(true));
    releaseWrite();
    await running;
  });

  it("shows only the latest commentary checkpoint before the final answer", async () => {
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir: os.tmpdir(),
    }) as unknown as TestableBridge;
    let rendered = "";
    let releaseAgent!: () => void;
    let checkpointsEmitted!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    const emitted = new Promise<void>((resolve) => {
      checkpointsEmitted = resolve;
    });

    bridge.channel = {
      async stream(_chatId, input) {
        await input.markdown({
          messageId: "card-message-1",
          async append(chunk) {
            rendered = sdkMergeStreamingText(rendered, chunk);
          },
          async setContent(full) {
            rendered = full;
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
        yield {
          type: "text_delta",
          text: "P2 已完成",
          messageId: "checkpoint-1",
          phase: "commentary",
        };
        yield {
          type: "text_delta",
          text: "P3 正在推进",
          messageId: "checkpoint-2",
          phase: "commentary",
        };
        checkpointsEmitted();
        await release;
        yield {
          type: "text_delta",
          text: "全部完成",
          messageId: "final-1",
          phase: "final_answer",
        };
        yield { type: "done", exitCode: 0 };
      },
    };

    const running = bridge.streamAgentReply(
      {
        messageId: "message-1",
        chatId: "chat-1",
        chatType: "p2p",
        senderId: "user-1",
        content: "test",
      },
      "test",
    );
    await emitted;
    await vi.waitFor(() => expect(rendered).toContain("P3 正在推进"));
    expect(rendered).not.toContain("P2 已完成");

    releaseAgent();
    await running;
    expect(rendered).toContain("✅ **已完成**");
    expect(rendered).toContain("全部完成");
  });

  it("does not repeat or roll back cumulative commentary around tools", async () => {
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir: os.tmpdir(),
    }) as unknown as TestableBridge;
    let rendered = "";
    let releaseAgent!: () => void;
    let checkpointsEmitted!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    const emitted = new Promise<void>((resolve) => {
      checkpointsEmitted = resolve;
    });

    bridge.channel = {
      async stream(_chatId, input) {
        await input.markdown({
          messageId: "card-message-1",
          async append(chunk) {
            rendered = sdkMergeStreamingText(rendered, chunk);
          },
          async setContent(full) {
            rendered = full;
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
        yield {
          type: "text_delta",
          text: "你好",
          messageId: "checkpoint-1",
          phase: "commentary",
        };
        yield { type: "tool_start", toolCallId: "tool-1", name: "Read" };
        yield { type: "tool_end", toolCallId: "tool-1", name: "Read" };
        yield {
          type: "text_delta",
          text: "你好，我来帮你处理",
          messageId: "checkpoint-1",
          phase: "commentary",
        };
        yield {
          type: "text_delta",
          text: "你好",
          messageId: "checkpoint-2",
          phase: "commentary",
        };
        yield {
          type: "text_delta",
          text: "你好",
          messageId: "checkpoint-2",
          phase: "commentary",
        };
        checkpointsEmitted();
        await release;
        yield {
          type: "text_delta",
          text: "已处理完成",
          messageId: "final-1",
          phase: "final_answer",
        };
        yield { type: "done", exitCode: 0 };
      },
    };

    const running = bridge.streamAgentReply(
      {
        messageId: "message-1",
        chatId: "chat-1",
        chatType: "p2p",
        senderId: "user-1",
        content: "test",
      },
      "test",
    );
    await emitted;
    await vi.waitFor(() => expect(rendered).toContain("你好"));
    expect(rendered).toContain("你好，我来帮你处理");
    expect(rendered.match(/你好/g)).toHaveLength(1);

    releaseAgent();
    await running;
    expect(rendered).toContain("✅ **已完成**");
    expect(rendered).toContain("已处理完成");
  });

  it("sends a sparse progress message without counting it as Agent activity", async () => {
    vi.useFakeTimers();
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir: os.tmpdir(),
    }) as unknown as TestableBridge;
    const notices: string[] = [];
    let releaseAgent!: () => void;
    let checkpointEmitted!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    const emitted = new Promise<void>((resolve) => {
      checkpointEmitted = resolve;
    });

    bridge.channel = {
      async stream(_chatId, input) {
        await input.markdown({
          messageId: "card-message-1",
          async append() {},
          async setContent() {},
        });
      },
      async send(_chatId, input) {
        notices.push(input.markdown);
      },
    };
    bridge.orchestrator = {
      router: {
        getBinding: () => ({ showThinking: false }),
      },
      cancelActiveForChat: async () => false,
      runAgent: async function* () {
        yield {
          type: "text_delta",
          text: "P3 正在推进",
          messageId: "checkpoint-1",
          phase: "commentary",
        };
        checkpointEmitted();
        await release;
        yield { type: "text_delta", text: "完成", phase: "final_answer" };
        yield { type: "done", exitCode: 0 };
      },
    };

    const running = bridge.streamAgentReply(
      {
        messageId: "message-1",
        chatId: "chat-1",
        chatType: "p2p",
        senderId: "user-1",
        content: "test",
      },
      "test",
    );
    await emitted;
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("任务仍在运行");
    expect(notices[0]).toContain("P3 正在推进");

    releaseAgent();
    await running;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows compact live status with thinking off without leaking thoughts", async () => {
    vi.useFakeTimers();
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir: os.tmpdir(),
    }) as unknown as TestableBridge;
    let rendered = "";
    let releaseAgent!: () => void;
    let agentWaiting!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      agentWaiting = resolve;
    });

    bridge.channel = {
      async stream(_chatId, input) {
        await input.markdown({
          messageId: "card-message-1",
          async append(chunk) {
            rendered = sdkMergeStreamingText(rendered, chunk);
          },
          async setContent(full) {
            rendered = full;
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
        yield { type: "thought_delta", text: "内部思考内容不能展示" };
        yield { type: "tool_start", name: "Bash", toolCallId: "tool-1" };
        agentWaiting();
        await release;
        yield { type: "text_delta", text: "任务完成" };
        yield { type: "done", exitCode: 0 };
      },
    };

    const running = bridge.streamAgentReply(
      {
        messageId: "message-1",
        chatId: "chat-1",
        chatType: "p2p",
        senderId: "user-1",
        content: "test",
      },
      "test",
    );
    await waiting;

    expect(rendered).toContain("执行中");
    expect(rendered).toContain("工具执行：Bash");
    expect(rendered).not.toContain("内部思考内容不能展示");
    await vi.advanceTimersByTimeAsync(FEISHU_LIVE_STATUS_QUIET_MS);
    expect(rendered).toContain("任务连接保持");
    expect(rendered).not.toContain("内部思考内容不能展示");

    releaseAgent();
    await running;
    expect(rendered).toContain("✅ **已完成**");
    expect(rendered).toContain("任务完成");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [
      "non-zero exit",
      async function* (): AsyncGenerator<AgentEvent> {
        yield { type: "text_delta", text: "执行失败" };
        yield { type: "done", exitCode: 1 };
      },
      "❌ **已失败**",
    ],
    [
      "ordinary exception",
      async function* (): AsyncGenerator<AgentEvent> {
        throw new Error("bridge boom");
      },
      "❌ **已失败**",
    ],
    [
      "abort",
      async function* (): AsyncGenerator<AgentEvent> {
        const error = new Error("cancelled");
        error.name = "AbortError";
        throw error;
      },
      "⏹ **已停止**",
    ],
  ] as const)("keeps the terminal status for %s", async (_name, runAgent, title) => {
    const rendered = await renderAgentRun(runAgent);

    expect(rendered).toContain(title);
  });

  it("keeps the agent result when a periodic status refresh fails", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir: os.tmpdir(),
      onLog: (message) => logs.push(message),
    }) as unknown as TestableBridge;
    let rendered = "";
    let statusWrites = 0;
    let releaseAgent!: () => void;
    let agentWaiting!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      agentWaiting = resolve;
    });

    bridge.channel = {
      async stream(_chatId, input) {
        await input.markdown({
          messageId: "card-message-1",
          async append(chunk) {
            rendered = sdkMergeStreamingText(rendered, chunk);
          },
          async setContent(full) {
            statusWrites += 1;
            if (statusWrites === 2) throw new Error("temporary card error");
            rendered = full;
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
        agentWaiting();
        await release;
        yield { type: "text_delta", text: "最终结果仍然送达" };
        yield { type: "done", exitCode: 0 };
      },
    };

    const running = bridge.streamAgentReply(
      {
        messageId: "message-1",
        chatId: "chat-1",
        chatType: "p2p",
        senderId: "user-1",
        content: "test",
      },
      "test",
    );
    await waiting;
    await vi.advanceTimersByTimeAsync(FEISHU_LIVE_STATUS_TICK_MS);
    releaseAgent();
    await running;

    expect(rendered).toContain("✅ **已完成**");
    expect(rendered).toContain("最终结果仍然送达");
    expect(logs).toContain(
      "飞书任务状态刷新失败（不影响 Agent 运行）：temporary card error",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let an in-flight status refresh overwrite the final result", async () => {
    vi.useFakeTimers();
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir: os.tmpdir(),
    }) as unknown as TestableBridge;
    let rendered = "";
    let statusWrites = 0;
    let releaseAgent!: () => void;
    let agentWaiting!: () => void;
    let releaseStatusWrite!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      agentWaiting = resolve;
    });
    const delayedStatusWrite = new Promise<void>((resolve) => {
      releaseStatusWrite = resolve;
    });

    bridge.channel = {
      async stream(_chatId, input) {
        await input.markdown({
          messageId: "card-message-1",
          async append(chunk) {
            rendered = sdkMergeStreamingText(rendered, chunk);
          },
          async setContent(full) {
            statusWrites += 1;
            if (statusWrites === 2) await delayedStatusWrite;
            rendered = full;
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
        agentWaiting();
        await release;
        yield { type: "text_delta", text: "最终结果" };
        yield { type: "done", exitCode: 0 };
      },
    };

    let runSettled = false;
    const running = bridge.streamAgentReply(
      {
        messageId: "message-1",
        chatId: "chat-1",
        chatType: "p2p",
        senderId: "user-1",
        content: "test",
      },
      "test",
    ).then(() => {
      runSettled = true;
    });
    await waiting;
    await vi.advanceTimersByTimeAsync(FEISHU_LIVE_STATUS_TICK_MS);
    releaseAgent();
    await vi.advanceTimersByTimeAsync(0);

    expect(runSettled).toBe(false);
    releaseStatusWrite();
    await running;
    expect(rendered).toContain("✅ **已完成**");
    expect(rendered).toContain("最终结果");
    expect(vi.getTimerCount()).toBe(0);
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
