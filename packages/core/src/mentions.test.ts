import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MentionRegistry,
  formatMentionGuidance,
  type MentionTarget,
} from "./mentions.js";

const FEISHU_SCOPE = { chatId: "oc_1", topicId: "omt_1" };

describe("MentionRegistry", () => {
  it("restores refs and conversation scopes after a restart without reusing IDs", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-mentions-"));
    try {
      const file = path.join(directory, "mentions.json");
      const original = new MentionRegistry(file);
      const user = original.register(FEISHU_SCOPE, { channel: "feishu", kind: "user", id: "ou_first" });
      const bot = original.register({ chatId: "oc_2" }, { channel: "feishu", kind: "bot", id: "ou_bot" });
      original.register({ chatId: "oc_3" }, { channel: "feishu", kind: "user", id: "ou_first" });
      const restarted = new MentionRegistry(file);
      expect(restarted.resolve(FEISHU_SCOPE, user.ref)?.id).toBe("ou_first");
      expect(restarted.resolve({ chatId: "oc_3" }, user.ref)?.id).toBe("ou_first");
      expect(restarted.resolve({ chatId: "oc_2" }, user.ref)).toBeUndefined();
      expect(restarted.resolve({ chatId: "oc_1" }, user.ref)).toBeUndefined();
      expect(restarted.resolve({ chatId: "oc_2" }, bot.ref)?.id).toBe("ou_bot");
      expect(restarted.register(FEISHU_SCOPE, { channel: "feishu", kind: "user", id: "ou_second" }).ref).toBe("u2");
      expect(restarted.register(FEISHU_SCOPE, { channel: "feishu", kind: "bot", id: "ou_other_bot" }).ref).toBe("b2");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

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
