import { describe, expect, it } from "vitest";
import {
  BOT_MENU_EVENT_KEYS,
  formatFullCommandHelp,
  formatWelcomeMessage,
} from "./command-help.js";

describe("command-help", () => {
  it("includes core slash commands", () => {
    const text = formatFullCommandHelp();
    expect(text).toContain("/resume");
    expect(text).toContain("/backend");
  });

  it("maps bot menu keys to slash text", () => {
    expect(BOT_MENU_EVENT_KEYS.fcb_status).toBe("/status");
    expect(BOT_MENU_EVENT_KEYS.fcb_resume).toBe("/resume");
  });

  it("renders welcome with bot name", () => {
    expect(formatWelcomeMessage("测试机器人")).toContain("测试机器人");
  });
});
