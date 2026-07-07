import { describe, expect, it } from "vitest";
import {
  shouldAcceptGroupMessage,
  topicActiveForMessage,
} from "./feishu-mention-gate.js";
import type { FeishuMessage } from "./bridge.js";

const baseMsg = (): FeishuMessage => ({
  messageId: "om_1",
  chatId: "oc_g",
  chatType: "group",
  senderId: "u1",
  content: "hi",
});

describe("shouldAcceptGroupMessage", () => {
  it("allows when @ bot", () => {
    expect(
      shouldAcceptGroupMessage({
        chatId: "oc_g",
        mentionedBot: true,
        requireMention: true,
        topicActive: false,
      }),
    ).toBe(true);
  });

  it("allows topic follow-up without @ when topic active", () => {
    expect(
      shouldAcceptGroupMessage({
        chatId: "oc_g",
        mentionedBot: false,
        topicId: "om_root",
        requireMention: true,
        topicActive: true,
      }),
    ).toBe(true);
  });

  it("blocks plain group message without @", () => {
    expect(
      shouldAcceptGroupMessage({
        chatId: "oc_g",
        mentionedBot: false,
        requireMention: true,
        topicActive: false,
      }),
    ).toBe(false);
  });
});

describe("topicActiveForMessage", () => {
  it("active when session exists", () => {
    expect(
      topicActiveForMessage(
        baseMsg(),
        "om_root",
        true,
        new Set(),
      ),
    ).toBe(true);
  });

  it("active when bot already participated in topic", () => {
    expect(
      topicActiveForMessage(
        baseMsg(),
        "om_root",
        false,
        new Set(["om_root"]),
      ),
    ).toBe(true);
  });
});
