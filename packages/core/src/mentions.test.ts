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
      name: "示例成员",
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

    expect(guidance).toContain(`${requester.ref}：示例成员（当前发送者）`);
    expect(guidance).toContain("发布机器人（机器人）");
    expect(guidance).toContain("fcb mention <对象引用> \"<消息>\"");
    expect(guidance).toContain("仅在确实需要主动通知时使用");
  });

  it("heals a role stored as a name by an older version, on disk too", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-heal-"));
    const file = path.join(dir, "mentions.json");
    const old = new MentionRegistry(file);
    old.register({ chatId: "oc_alerts", topicId: "om_alert" }, { channel: "feishu", kind: "user", id: "ou_owner", name: "告警审批人" });
    old.register({ chatId: "oc_x" }, { channel: "feishu", kind: "user", id: "ou_other", name: "示例成员" });

    const healed = new MentionRegistry(file);
    expect(healed.forgetNames(["告警审批人"])).toBe(1);
    const dm = healed.register({ chatId: "oc_dm" }, { channel: "feishu", kind: "user", id: "ou_owner" });
    expect(formatMentionGuidance([dm], dm.ref)).not.toContain("告警审批人");
    expect(new MentionRegistry(file).list({ chatId: "oc_x" })[0]?.name).toBe("示例成员");
    expect(new MentionRegistry(file).list({ chatId: "oc_dm" })[0]?.name).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
