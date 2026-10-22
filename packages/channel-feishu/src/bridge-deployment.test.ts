import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { defaultConfig } from "@codebridge/core";
import { FeishuBridge, type FeishuMessage } from "./bridge.js";
it("handles deployment before agent submission and gates new tasks during maintenance", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-deploy-"));
  try {
    const hook = vi.fn(async (message: FeishuMessage) => message.content === "发布状态" ? "正在发布" : undefined);
    const instance = new FeishuBridge({ config: defaultConfig(), dataDir: dir, onDeploymentMessage: hook, isMaintenance: () => true });
    const bridge = instance as unknown as {
      handleMessage(message: FeishuMessage): Promise<void>;
      submitAndStream(message: FeishuMessage, prompt: string, topic: undefined): Promise<void>;
      sendMarkdown: ReturnType<typeof vi.fn>;
      streamAgentReply: ReturnType<typeof vi.fn>;
    };
    bridge.sendMarkdown = vi.fn(async () => {}); bridge.streamAgentReply = vi.fn(async () => {});
    const message = { messageId: "om_1", chatId: "oc_1", senderId: "ou_1", chatType: "p2p" as const, content: "发布状态" };
    await bridge.handleMessage(message);
    expect(hook).toHaveBeenCalledWith(message);
    expect(bridge.sendMarkdown).toHaveBeenCalledWith("oc_1", "正在发布", "om_1");
    await bridge.submitAndStream({ ...message, content: "改代码" }, "改代码", undefined);
    expect(bridge.sendMarkdown.mock.calls.at(-1)?.[1]).toContain("请发布完成后重发");
    expect(bridge.streamAgentReply).not.toHaveBeenCalled();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
