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
  it("rejects missing approvers and duplicate groups, and accepts approverOpenIds without an owner", () => {
    const config = defaultConfig();
    const group = { chatId: "oc_group", senderAppIds: ["cli_bot"], ownerOpenId: "ou_owner" };
    for (const groups of [[{ ...group, ownerOpenId: "" }], [{ ...group, ownerOpenId: undefined }], [{ ...group, ownerOpenId: undefined, approverOpenIds: [] }], [{ ...group, senderAppIds: [] }], [group, group]]) {
      expect(ConfigSchema.safeParse({ ...config, feishu: { ...config.feishu, alertMonitor: { groups } } }).success).toBe(false);
    }
    const parsed = ConfigSchema.parse({ ...config, feishu: { ...config.feishu, alertMonitor: {
      groups: [{ chatId: "oc_group", senderAppIds: ["cli_bot"], approverOpenIds: ["ou_a", "ou_b"] }],
    } } });
    expect(parsed.feishu.alertMonitor).toMatchObject({ incidentRetentionMs: 7 * 86_400_000, groups: [{ approverOpenIds: ["ou_a", "ou_b"] }] });
  });
});
