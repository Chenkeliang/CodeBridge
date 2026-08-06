import { describe, expect, it } from "vitest";
import {
  MentionRegistry,
  formatMentionGuidance,
  type MentionTarget,
} from "./mentions.js";

const FEISHU_SCOPE = { chatId: "oc_1", topicId: "omt_1" };

describe("MentionRegistry", () => {
  it("keeps stable refs while restricting resolution to the conversation", () => {
    const registry = new MentionRegistry();
    const target: MentionTarget = {
      channel: "feishu",
      kind: "user",
      id: "ou_zhangsan",
      name: "张三",
    };

    const first = registry.register(FEISHU_SCOPE, target);
    const again = registry.register(FEISHU_SCOPE, target);

    expect(again.ref).toBe(first.ref);
    expect(registry.resolve(FEISHU_SCOPE, first.ref)).toEqual(first);
    expect(
      registry.resolve({ chatId: "oc_other" }, first.ref),
    ).toBeUndefined();
  });

  it("formats user and future bot targets as an explicit Agent command", () => {
    const registry = new MentionRegistry();
    const requester = registry.register(FEISHU_SCOPE, {
      channel: "feishu",
      kind: "user",
      id: "ou_requester",
      name: "陈科良",
    });
    registry.register(FEISHU_SCOPE, {
      channel: "feishu",
      kind: "bot",
      id: "ou_release_bot",
      name: "发布机器人",
    });

    const guidance = formatMentionGuidance(
      registry.list(FEISHU_SCOPE),
      requester.ref,
    );

    expect(guidance).toContain(`${requester.ref}：陈科良（当前发送者）`);
    expect(guidance).toContain("发布机器人（机器人）");
    expect(guidance).toContain("fcb mention <对象引用> \"<消息>\"");
    expect(guidance).toContain("仅在确实需要主动通知时使用");
  });
});
