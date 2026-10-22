import { describe, expect, it, vi } from "vitest";
import { buildInboundPromptPrefix } from "./feishu-inbound-context.js";

describe("buildInboundPromptPrefix", () => {
  it("injects topic root and quoted reply", async () => {
    const channel = {
      rawClient: {
        im: {
          v1: {
            message: {
              get: vi
                .fn()
                .mockResolvedValueOnce({
                  data: {
                    items: [
                      {
                        msg_type: "post",
                        body: {
                          content: JSON.stringify({
                            title: "发货单下发异常",
                            content: [[{ tag: "text", text: "err: AddOrder fail" }]],
                          }),
                        },
                        sender: { sender_name: "灯塔机器人", sender_type: "app", id: "app_a" },
                      },
                    ],
                  },
                })
                .mockResolvedValueOnce({
                  data: {
                    items: [
                      {
                        msg_type: "text",
                        body: {
                          content: JSON.stringify({ text: "补充说明" }),
                        },
                        sender: { sender_name: "示例成员" },
                      },
                    ],
                  },
                }),
            },
          },
        },
      },
    };

    const prefix = await buildInboundPromptPrefix(
      channel as never,
      {
        threadId: "om_root",
        replyToMessageId: "om_reply",
      },
      "om_root",
      "app_bot",
    );

    expect(prefix).toContain("【话题根消息｜发送者：灯塔机器人】");
    expect(prefix).toContain("err: AddOrder fail");
    expect(prefix).toContain("【用户引用的消息｜发送者：示例成员】");
    expect(prefix).toContain("补充说明");
  });

  it("skips duplicate fetch when reply targets topic root", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        items: [
          {
            msg_type: "text",
            body: { content: JSON.stringify({ text: "root only" }) },
            sender: { sender_name: "bot" },
          },
        ],
      },
    });
    const channel = {
      rawClient: { im: { v1: { message: { get } } } },
    };

    const prefix = await buildInboundPromptPrefix(
      channel as never,
      { threadId: "om_root", replyToMessageId: "om_root" },
      "om_root",
      "app_bot",
    );

    expect(get).toHaveBeenCalledTimes(1);
    expect(prefix).toContain("root only");
    expect(prefix).toContain("【用户引用的消息");
  });
});
