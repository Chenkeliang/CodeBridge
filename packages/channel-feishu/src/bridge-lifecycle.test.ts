import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, type ChannelSessionIngress } from "@codebridge/core";
import { FeishuBridge, type FeishuMessage } from "./bridge.js";

type TestableBridge = {
  channel: {
    stream(
      chatId: string,
      input: {
        markdown(controller: {
          messageId: string;
          append(chunk: string): Promise<void>;
          setContent(full: string): Promise<void>;
        }): Promise<void>;
      },
    ): Promise<void>;
    disconnect(): Promise<void>;
  };
  orchestrator: {
    router: { getBinding(chatId: string, topicId?: string): { showThinking: boolean } };
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
  it("does not abort a previous card when a second message streams", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lifecycle-"));
    const bridge = new FeishuBridge({ config: defaultConfig(), dataDir }) as unknown as TestableBridge;
    const signals: AbortSignal[] = [];
    bridge.sessionIngress = (async function* (incoming: Parameters<ChannelSessionIngress>[0]) {
      signals.push(incoming.signal!);
      yield { type: "text_delta", text: "reply" };
      yield { type: "done", exitCode: 0 };
    }) as unknown as ChannelSessionIngress;
    bridge.channel = {
      async stream(_chatId, input) {
        await input.markdown({
          messageId: "card-1",
          async append() {},
          async setContent() {},
        });
      },
      async disconnect() {},
    };

    await bridge.streamAgentReply(message("m1"), "one");
    await bridge.streamAgentReply(message("m2"), "two");

    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(false);
  });

  it("aborts an in-flight stream on disconnect", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lifecycle-"));
    const bridge = new FeishuBridge({ config: defaultConfig(), dataDir }) as unknown as TestableBridge;
    let capturedSignal: AbortSignal | undefined;
    bridge.sessionIngress = (async function* (incoming: Parameters<ChannelSessionIngress>[0]) {
      capturedSignal = incoming.signal;
      yield { type: "text_delta", text: "hi" };
      await new Promise<void>((resolve) => {
        incoming.signal?.addEventListener("abort", () => resolve());
      });
      yield { type: "done", exitCode: 130 };
    }) as unknown as ChannelSessionIngress;
    bridge.channel = {
      async stream(_chatId, input) {
        await input.markdown({
          messageId: "card-1",
          async append() {},
          async setContent() {},
        });
      },
      async disconnect() {},
    };

    const streamPromise = bridge.streamAgentReply(message("m1"), "hi");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await bridge.disconnect();

    expect(capturedSignal?.aborted).toBe(true);
    await streamPromise;
  });
});
