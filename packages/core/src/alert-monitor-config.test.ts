import { describe, expect, it } from "vitest";
import { ConfigSchema, defaultConfig } from "./config-schema.js";

describe("alert monitor configuration", () => {
  it("leaves existing installations disabled", () => {
    expect(defaultConfig().feishu.alertMonitor).toBeUndefined();
  });
  it("supplies bounded defaults for an explicitly selected group, source and owner", () => {
    const config = defaultConfig();
    const parsed = ConfigSchema.parse({ ...config, feishu: { ...config.feishu, alertMonitor: {
      groups: [{ chatId: "oc_group", senderAppIds: ["cli_bot"], ownerOpenId: "ou_owner" }],
    } } });
    expect(parsed.feishu.alertMonitor).toMatchObject({ pollIntervalMs: 30_000, lookbackMs: 600_000, dedupWindowMs: 1_800_000, maxConcurrent: 2 });
  });
  it("rejects missing notification ownership and duplicate groups", () => {
    const config = defaultConfig();
    const group = { chatId: "oc_group", senderAppIds: ["cli_bot"], ownerOpenId: "ou_owner" };
    for (const groups of [[{ ...group, ownerOpenId: "" }], [{ ...group, senderAppIds: [] }], [group, group]]) {
      expect(ConfigSchema.safeParse({ ...config, feishu: { ...config.feishu, alertMonitor: { groups } } }).success).toBe(false);
    }
  });
});
