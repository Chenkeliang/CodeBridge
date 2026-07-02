import { describe, expect, it } from "vitest";
import { parseSessionKey, serializeSessionKey } from "./types.js";
import { resolveRequireMention } from "./config-schema.js";

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
