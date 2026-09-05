import { describe, expect, it } from "vitest";
import {
  QUOTE_MAX_CHARS,
  extractMessageText,
  formatQuotedContext,
  formatTopicRootContext,
} from "./feishu-quoted-message.js";

describe("extractMessageText", () => {
  it("text 消息还原 @ 提及", () => {
    const content = JSON.stringify({
      text: "@_user_1 这是什么商品，查下原因",
    });
    expect(
      extractMessageText("text", content, [
        { key: "@_user_1", name: "灯塔机器人" },
      ]),
    ).toBe("@灯塔机器人 这是什么商品，查下原因");
  });

  it("post 消息拼接标题与多行内容", () => {
    const content = JSON.stringify({
      title: "发货单下发异常",
      content: [
        [
          { tag: "text", text: "data: E2026" },
          { tag: "a", text: "详情", href: "https://x" },
        ],
        [{ tag: "at", user_name: "陈科良" }],
      ],
    });
    expect(extractMessageText("post", content)).toBe(
      "发货单下发异常\ndata: E2026详情\n@陈科良",
    );
  });

  it("卡片等未知类型递归收集 text 字段", () => {
    const content = JSON.stringify({
      elements: [[{ tag: "div", text: { content: "err: AddOrder fail" } }]],
    });
    const out = extractMessageText("interactive", content);
    expect(out).toContain("err: AddOrder fail");
  });

  it("旧版互动卡片保留顶层标题与 text 元素", () => {
    const content = JSON.stringify({
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

    expect(extractMessageText("interactive", content)).toBe(
      "【协议签约】续费定时任务-扣款失败\nerror_code:\n\n2000305\norder_id:\n\nBJN695XYKLF9MPKX5L",
    );
  });

  it("无可提取文字时回退到类型占位", () => {
    expect(extractMessageText("audio", JSON.stringify({ file_key: "k" }))).toBe(
      "[audio 消息]",
    );
    expect(extractMessageText("image", JSON.stringify({ image_key: "k" }))).toBe(
      "[图片]",
    );
  });

  it("非 JSON 内容原样返回", () => {
    expect(extractMessageText("text", "plain")).toBe("plain");
  });
});

describe("formatQuotedContext", () => {
  it("带发送者名并包裹标记", () => {
    const out = formatQuotedContext("hello", "灯塔机器人");
    expect(out).toBe(
      "【用户引用的消息｜发送者：灯塔机器人】\nhello\n【引用消息结束】",
    );
  });

  it("超长内容截断", () => {
    const out = formatQuotedContext("x".repeat(QUOTE_MAX_CHARS + 100));
    expect(out).toContain("…（引用内容已截断）");
    expect(out.length).toBeLessThan(QUOTE_MAX_CHARS + 100);
  });
});

describe("formatTopicRootContext", () => {
  it("包裹话题根消息标记", () => {
    const out = formatTopicRootContext("alert body", "灯塔机器人");
    expect(out).toContain("【话题根消息｜发送者：灯塔机器人】");
    expect(out).toContain("【话题根消息结束】");
  });
});
