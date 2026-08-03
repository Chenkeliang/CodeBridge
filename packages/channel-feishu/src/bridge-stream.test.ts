import os from "node:os";
import { describe, expect, it } from "vitest";
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
  it("preserves repeated letters split across ACP deltas", async () => {
    await expect(renderThroughSdk(["Me", "epo"])).resolves.toBe("Meepo");
  });

  it("preserves repeated digits split across ACP deltas", async () => {
    await expect(
      renderThroughSdk(["692818", "820925", "5382", "277A"]),
    ).resolves.toBe("6928188209255382277A");
  });
});
