import { describe, expect, it } from "vitest";
import { parseSessionKey, serializeSessionKey } from "./types.js";
import {
  ConfigSchema,
  defaultConfig,
  resolveRequireMention,
} from "./config-schema.js";

describe("session key", () => {
  it("roundtrips", () => {
    const key = {
      chatId: "oc_abc",
      topicId: "om_thread",
      backendId: "cursor",
      cwd: "/Users/dev/project",
    };
    const raw = serializeSessionKey(key);
    expect(parseSessionKey(raw)).toEqual(key);
  });
});

describe("resolveRequireMention", () => {
  it("uses scenario override", () => {
    const policy = {
      requireMention: true,
      dmMode: "open" as const,
      respondToMentionAll: false,
      scenarios: [
        { name: "trusted", chats: ["oc_trust"], requireMention: false },
      ],
    };
    expect(resolveRequireMention(policy, "oc_trust")).toBe(false);
    expect(resolveRequireMention(policy, "oc_other")).toBe(true);
  });
});

describe("ACP-only backend configuration", () => {
  it("rejects the removed CLI transport", () => {
    expect(() =>
      ConfigSchema.parse({
        feishu: { appId: "app", appSecret: "secret" },
        runner: { token: "runner-token" },
        backends: {
          cursor: {
            type: "cursor-cli",
            transport: "cli",
          },
        },
      }),
    ).toThrow();
  });

  it("does not pin default models or effort to stale values", () => {
    const config = ConfigSchema.parse({
      ...defaultConfig(),
    });

    expect(config.backends.cursor?.model).toBeUndefined();
    expect(config.backends.claude?.model).toBeUndefined();
    expect(config.backends.claude?.effort).toBeUndefined();
  });
});
