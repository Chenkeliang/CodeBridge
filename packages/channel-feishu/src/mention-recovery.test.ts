import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@codebridge/core";
import { FeishuBridge, type FeishuMessage } from "./bridge.js";

type InboundHarness = {
  handleMessage(message: FeishuMessage): Promise<void>;
  submitAndStream: ReturnType<typeof vi.fn>;
};

describe("Feishu persisted mention recovery", () => {
  it("registers from inbound dispatch, recreates Bridge, and sends without a new inbound message", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-feishu-mention-"));
    try {
      const original = new FeishuBridge({ config: defaultConfig(), dataDir });
      const inbound = original as unknown as InboundHarness;
      inbound.submitAndStream = vi.fn(async () => {});
      await inbound.handleMessage({ messageId: "om_initial", chatId: "oc_report", chatType: "group",
        senderId: "ou_report_owner", senderName: "报告接收人", content: "test", mentionedBot: true,
        threadId: "omt_report" });

      const restarted = new FeishuBridge({ config: defaultConfig(), dataDir });
      const send = vi.fn(async () => {});
      (restarted as unknown as { channel: { send: typeof send } }).channel = { send };
      await restarted.sendOutboundMention("oc_report", "u1", "14:30 report", "omt_report");
      expect(send).toHaveBeenCalledWith("oc_report", { markdown: "14:30 report" },
        expect.objectContaining({ replyTo: "om_initial", replyInThread: true,
          mentions: [{ key: "u1", openId: "ou_report_owner", name: "报告接收人", isBot: false }] }));
      await expect(restarted.sendOutboundMention("oc_other", "u1", "report", "omt_report"))
        .rejects.toThrow("当前对话不存在可通知对象");
      await expect(restarted.sendOutboundMention("oc_report", "u1", "report", "omt_other"))
        .rejects.toThrow("当前对话不存在可通知对象");
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
