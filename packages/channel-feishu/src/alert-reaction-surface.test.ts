import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { defaultConfig, type ChannelSessionIngress } from "@codebridge/core";
import { FeishuBridge } from "./bridge.js";

it("routes the active SDK reaction listener with the original card and real owner identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alert-reaction-surface-"));
  const config = defaultConfig();
  config.feishu.alertMonitor = { pollIntervalMs: 60_000, lookbackMs: 600_000, dedupWindowMs: 1_800_000, maxConcurrent: 1,
    statusReactions: { investigating: "OnIt", waiting: "OneSecond", resolved: "DONE", no_action: "CrossMark", blocked: "Sigh" },
    groups: [{ chatId: "oc_alert", senderAppIds: ["cli_alarm"], ownerOpenId: "ou_owner" }] };
  const handlers = new Map<string, (event: unknown) => void>();
  const sdk = await import("@larksuiteoapi/node-sdk");
  const channel = { botIdentity: { name: "test" }, dispatcher: { register: vi.fn() },
    on: (event: string, handler: (event: unknown) => void) => handlers.set(event, handler),
    connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), updatePolicy: vi.fn() };
  const spy = vi.spyOn(sdk, "createLarkChannel").mockReturnValue(channel as never);
  const onAlertReaction = vi.fn(async () => {});
  const bridge = new FeishuBridge({ config, dataDir: root,
    sessionIngress: { listDeliveries: async () => [] } as unknown as ChannelSessionIngress,
    onAlertReaction,
  });
  try {
    await bridge.connect();
    expect(handlers.has("reaction")).toBe(true);
    handlers.get("reaction")!({ messageId: "om_b", operator: { openId: "ou_owner" }, emojiType: "DONE", action: "added", actionTime: 12345 });
    await vi.waitFor(() => expect(onAlertReaction).toHaveBeenCalledWith({ messageId: "om_b", operatorOpenId: "ou_owner", emojiType: "DONE", action: "added", actionTime: 12345 }));
  } finally {
    await bridge.disconnect(); spy.mockRestore(); fs.rmSync(root, { recursive: true, force: true });
  }
});
