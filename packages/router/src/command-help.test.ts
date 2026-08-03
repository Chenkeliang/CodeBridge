import { describe, expect, it } from "vitest";
import {
  BOT_MENU_EVENT_KEYS,
  formatCompactCommandHelp,
  formatFullCommandHelp,
  formatWelcomeMessage,
} from "./command-help.js";

describe("command-help", () => {
  it("renders a compact mobile menu with only frequent commands", () => {
    const text = formatCompactCommandHelp();
    expect(text).toContain("/status");
    expect(text).toContain("/resume last");
    expect(text).toContain("/help full");
    expect(text).not.toContain("/session delete");
    expect(text).not.toContain("/clone");
  });

  it("groups the full help and shows the actual command syntax", () => {
    const text = formatFullCommandHelp();
    expect(text).toContain("**常用**");
    expect(text).toContain("**任务控制**");
    expect(text).toContain("**会话管理**");
    expect(text).toContain("**Agent 与模型**");
    expect(text).toContain("**目录与工作区**");
    expect(text).toContain("**文件与 Git**");
    expect(text).toContain("/session close <sessionId>");
    expect(text).toContain("/session delete <sessionId>");
    expect(text).toContain("/model [list|名称|default]");
    expect(text).toContain("/effort [list|级别|default]");
    expect(text).toContain("/permission [list|模式|default]");
    expect(text).toContain("/config [id value|default]");
    expect(text).toContain("/transport");
    expect(text).toContain("/root add|remove|rm <绝对路径>");
    expect(text).toContain("/clone <git-url> [目录名]");
    expect(text).toContain("/send <文件路径>");
  });

  it("renders Telegram help as plain text", () => {
    const compact = formatCompactCommandHelp("plain");
    const full = formatFullCommandHelp("plain");
    expect(`${compact}\n${full}`).not.toMatch(/[`*]/);
    expect(compact).toContain("码桥快捷菜单");
    expect(full).toContain("Agent 与模型");
  });

  it("maps bot menu keys to slash text", () => {
    expect(BOT_MENU_EVENT_KEYS.fcb_status).toBe("/status");
    expect(BOT_MENU_EVENT_KEYS.fcb_resume).toBe("/resume");
    expect(BOT_MENU_EVENT_KEYS.fcb_resume_last).toBe("/resume last");
    expect(BOT_MENU_EVENT_KEYS.fcb_backend_codex).toBe("/backend codex");
    expect(BOT_MENU_EVENT_KEYS.fcb_model).toBe("/model");
    expect(BOT_MENU_EVENT_KEYS.fcb_permission).toBe("/permission");
  });

  it("renders welcome with bot name", () => {
    expect(formatWelcomeMessage("测试机器人")).toContain("测试机器人");
  });
});
