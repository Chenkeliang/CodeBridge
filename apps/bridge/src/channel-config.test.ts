import { describe, expect, it } from "vitest";
import { defaultConfig } from "@codebridge/core";
import { hasFeishuCredentials, hasTelegramCredentials } from "./channel-config.js";

describe("channel credential selection", () => {
  it("allows Telegram-only configuration without Feishu placeholders", () => {
    const config = defaultConfig();
    config.telegram = { botToken: "123:token", pollingTimeoutSec: 25 };
    expect(hasFeishuCredentials(config)).toBe(false);
    expect(hasTelegramCredentials(config)).toBe(true);
  });
});
