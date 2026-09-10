import { describe, expect, it, vi } from "vitest";
import { buildInboundPromptPrefix } from "./feishu-inbound-context.js";
import { extractMessageText } from "./feishu-quoted-message.js";
import { FeishuBridge } from "./bridge.js";
import { defaultConfig } from "@codebridge/core";
import os from "node:os";

function channel(text: string) {
  return { rawClient: { im: { v1: { message: { get: vi.fn().mockResolvedValue({
    code: 0, data: { items: [{ msg_type: "text", sender: { sender_type: "app", id: "self" },
      body: { content: JSON.stringify({ text }) } }] },
  }) } } } } };
}

describe("explicit Feishu quotations", () => {
  it.each(["image", "post", "interactive"])("forwards quoted %s images through active submission", async (type) => {
    const config = defaultConfig();
    config.feishu.appId = "self";
    const target = new FeishuBridge({ config, dataDir: os.tmpdir() }) as unknown as {
      channel: unknown;
      submitAndStream: ReturnType<typeof vi.fn>;
      dispatchToAgent: (msg: unknown, prompt: string) => Promise<void>;
    };
    const data = Buffer.from("89504e470d0a1a0a", "hex");
    const get = vi.fn().mockResolvedValue(data);
    const content = type === "image" ? { image_key: "img_key" }
      : { content: [[{ tag: "img", image_key: "img_key" }, { tag: "img", image_key: "img_key" }]] };
    target.channel = { rawClient: { im: { v1: {
      message: { get: vi.fn().mockResolvedValue({ code: 0, data: { items: [{
        msg_type: type, sender: { sender_type: "app", id: "self" },
        body: { content: JSON.stringify(content) },
      }] } }) }, messageResource: { get },
    } } } };
    target.submitAndStream = vi.fn().mockResolvedValue(undefined);
    await target.dispatchToAgent({ chatId: "chat", messageId: "new", senderId: "user",
      senderName: "User", replyToMessageId: "om_original" }, "图里是什么");
    const [message, prompt] = target.submitAndStream.mock.calls[0]!;
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].mimeType).toBe("image/png");
    expect(Buffer.from(message.attachments[0].dataBase64, "base64")).toEqual(data);
    expect(get).toHaveBeenCalledWith({ path: { message_id: "om_original", file_key: "img_key" }, params: { type: "image" } });
    expect(prompt).toContain("引用图片附件");
  });

  it("retains text when an image download fails", async () => {
    const ch = { rawClient: { im: { v1: {
      message: { get: vi.fn().mockResolvedValue({ data: { items: [{ msg_type: "post",
        body: { content: JSON.stringify({ content: [[{ tag: "text", text: "keep text" }, { tag: "img", image_key: "key" }]] }) },
      }] } }) }, messageResource: { get: vi.fn().mockRejectedValue(new Error("denied")) },
    } } } };
    const add = vi.fn();
    const prefix = await buildInboundPromptPrefix(ch as never, { replyToMessageId: "om" }, undefined, "self", undefined, add);
    expect(prefix).toContain("keep text");
    expect(prefix).toContain("图片 1 未读取成功");
    expect(add).not.toHaveBeenCalled();
  });
  it("passes complete long code to the active submission path as an attachment", async () => {
    const config = defaultConfig();
    config.feishu.appId = "self";
    const bridge = new FeishuBridge({ config, dataDir: os.tmpdir() });
    const target = bridge as unknown as {
      channel: unknown;
      submitAndStream: ReturnType<typeof vi.fn>;
      dispatchToAgent: (msg: unknown, prompt: string, topic?: string) => Promise<void>;
    };
    const text = "curl " + "x".repeat(3000) + " END_JSON";
    target.channel = channel(text);
    target.submitAndStream = vi.fn().mockResolvedValue(undefined);
    await target.dispatchToAgent({ chatId: "chat", messageId: "new", senderId: "user",
      senderName: "User", replyToMessageId: "om_reply" }, "修改这个");
    const [message, prompt] = target.submitAndStream.mock.calls[0]!;
    expect(prompt).toContain("quoted-om_reply.txt");
    expect(prompt).toContain("修改这个");
    expect(Buffer.from(message.attachments[0].dataBase64, "base64").toString()).toBe(text);
  });
  it("includes the bot's own reply with its message ID", async () => {
    const prefix = await buildInboundPromptPrefix(channel("curl body") as never,
      { replyToMessageId: "om_reply" }, undefined, "self");
    expect(prefix).toContain("curl body");
    expect(prefix).toContain("om_reply");
    expect(prefix).toContain("历史材料");
  });

  it("keeps the direct quote when the topic root fails", async () => {
    const ch = channel("quoted body");
    ch.rawClient.im.v1.message.get.mockRejectedValueOnce(new Error("unavailable"));
    const prefix = await buildInboundPromptPrefix(ch as never,
      { replyToMessageId: "om_reply" }, "om_root", "self");
    expect(prefix).toContain("quoted body");
    expect(prefix).toContain("未读取成功");
  });

  it("makes an API error visible", async () => {
    const ch = channel("unused");
    ch.rawClient.im.v1.message.get.mockResolvedValueOnce({ code: 999, data: { items: [] } });
    const prefix = await buildInboundPromptPrefix(ch as never,
      { replyToMessageId: "om_reply" }, undefined, "self");
    expect(prefix).toContain("未读取成功");
  });

  it("extracts a localized post and code block", () => {
    expect(extractMessageText("post", JSON.stringify({ zh_cn: {
      title: "Title", content: [[{ tag: "code_block", text: "curl complete" }]],
    } }))).toContain("curl complete");
  });
});
