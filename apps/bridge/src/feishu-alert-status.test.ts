import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@codebridge/core";
import { FeishuAlertMonitor } from "./feishu-alert-monitor.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
async function fixture(duplicates = false, runbook = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alert-status-")); roots.push(root);
  let now = 1_000_000;
  const runbookPath = path.join(root, "SKILL.md");
  if (runbook) fs.writeFileSync(runbookPath, "# Runbook v1\nRead the alarm matrix before investigating.");
  const config: NonNullable<AppConfig["feishu"]["alertMonitor"]> = {
    pollIntervalMs: 60_000, lookbackMs: 600_000, dedupWindowMs: 1_800_000, maxConcurrent: 2,
    statusReactions: { investigating: "OnIt", waiting: "OneSecond", resolved: "DONE", no_action: "CrossMark", blocked: "Sigh" },
    groups: [{ chatId: "oc_alert", ownerOpenId: "ou_owner", senderAppIds: ["cli_alarm"], ...(runbook ? { runbookPath } : {}) }],
  };
  const message = { messageId: "om_root", chatId: "oc_alert", senderId: "cli_alarm", senderType: "app", createdAt: 1_000_100, content: "failure" };
  const transport = {
    readAlertMessages: vi.fn(async () => ({ messages: duplicates ? [message, { ...message, messageId: "om_duplicate" }] : [message], hasMore: false })),
    investigateAlert: vi.fn(async () => {}), isAlertActive: vi.fn(async () => false),
    setAlertMessageReaction: vi.fn(async () => "reaction"), notifyAlertOwner: vi.fn(async () => {}),
  };
  const options = { config: () => config, statePath: path.join(root, "state.json"), transport, now: () => now, log: vi.fn() };
  const monitor = new FeishuAlertMonitor(options);
  await monitor.tick(); now += 1000; await monitor.tick();
  return { monitor, options, transport, config, runbookPath, message, advance: () => { now += 60_000; } };
}

describe("alert status and runbook", () => {
  it("projects duplicates on their original cards and notifies the owner once per actionable state", async () => {
    const f = await fixture(true);
    expect(f.transport.setAlertMessageReaction).toHaveBeenCalledTimes(2);
    await f.monitor.setStatus("oc_alert", "om_root", "waiting", "请确认补货计划");
    expect(f.transport.setAlertMessageReaction).toHaveBeenCalledWith("om_root", "OneSecond", expect.any(Array));
    expect(f.transport.setAlertMessageReaction).toHaveBeenCalledWith("om_duplicate", "OneSecond", expect.any(Array));
    expect(f.transport.notifyAlertOwner).toHaveBeenCalledWith("oc_alert", "om_root", "ou_owner", "请确认补货计划");
    await f.monitor.setStatus("oc_alert", "om_root", "waiting", "请确认补货计划");
    expect(f.transport.notifyAlertOwner).toHaveBeenCalledTimes(1);
    f.monitor.prepareReply({ messageId: "om_reply", chatId: "oc_alert", chatType: "group", senderId: "ou_owner", content: "继续查" }, "om_root");
    await f.monitor.setStatus("oc_alert", "om_root", "waiting", "请确认补货计划");
    expect(f.transport.notifyAlertOwner).toHaveBeenCalledTimes(2);
  });
  it("still notifies on reaction failure and retries the projection after restart without duplicating the notice", async () => {
    const f = await fixture(); f.transport.setAlertMessageReaction.mockRejectedValueOnce(new Error("permission denied"));
    await expect(f.monitor.setStatus("oc_alert", "om_root", "waiting", "请提供补货计划")).rejects.toThrow("permission denied");
    expect(f.transport.notifyAlertOwner).toHaveBeenCalledTimes(1);
    f.advance(); await new FeishuAlertMonitor(f.options).tick();
    expect(f.transport.setAlertMessageReaction).toHaveBeenLastCalledWith("om_root", "OneSecond", expect.any(Array));
    expect(f.transport.notifyAlertOwner).toHaveBeenCalledTimes(1);
  });
  it("does not turn an ended Agent run into a business success automatically", async () => {
    const f = await fixture(); f.advance(); await f.monitor.tick();
    expect(f.transport.setAlertMessageReaction).toHaveBeenLastCalledWith("om_root", "Sigh", expect.any(Array));
    expect(f.transport.notifyAlertOwner).toHaveBeenCalledWith("oc_alert", "om_root", "ou_owner", expect.stringContaining("未提交可核验"));
    expect(f.transport.setAlertMessageReaction.mock.calls.some((call) => (call as unknown[])[1] === "DONE")).toBe(false);
  });
  it("loads the configured skill for every alert and owner follow-up", async () => {
    const f = await fixture(false, true);
    expect(f.transport.investigateAlert).toHaveBeenCalledWith(f.message, "ou_owner", expect.stringContaining("Runbook v1"));
    fs.writeFileSync(f.runbookPath, "# Runbook v2\nUpdated alarm matrix rules.");
    const reply = f.monitor.prepareReply({ messageId: "om_reply", chatId: "oc_alert", chatType: "group", senderId: "ou_owner", content: "继续" }, "om_root");
    expect(reply?.instructions).toContain("Runbook v2");
  });
  it("rejects cross-conversation or invalid states", async () => {
    const f = await fixture();
    await expect(f.monitor.setStatus("oc_other", "om_root", "resolved", "checked")).rejects.toThrow("not found");
    await expect(f.monitor.setStatus("oc_alert", "om_root", "success", "checked")).rejects.toThrow("Invalid");
    await expect(f.monitor.setStatus("oc_alert", "om_root", "resolved", " ")).rejects.toThrow("Invalid");
  });
  it("preserves pilot incidents for owner replies while starting continuous collection at activation time", async () => {
    const f = await fixture();
    const state = JSON.parse(fs.readFileSync(f.options.statePath, "utf8"));
    state.oc_alert.collectionStarted = false;
    fs.writeFileSync(f.options.statePath, JSON.stringify(state));
    f.advance(); f.transport.readAlertMessages.mockClear();
    const resumed = new FeishuAlertMonitor(f.options); await resumed.tick();
    expect(f.transport.readAlertMessages).not.toHaveBeenCalled();
    const saved = JSON.parse(fs.readFileSync(f.options.statePath, "utf8"));
    expect(saved.oc_alert.activatedAt).toBe(1_061_000);
    expect(saved.oc_alert.incidents.om_root).toBeDefined();
    expect(resumed.prepareReply({ messageId: "om_other", chatId: "oc_alert", chatType: "group", senderId: "ou_other", content: "批准" }, "om_root")?.allowed).toBe(false);
  });

  it("leaves collection paused while pilot validation is in progress", async () => {
    const f = await fixture(); f.config.enabled = false; f.transport.readAlertMessages.mockClear();
    f.advance(); await f.monitor.tick(); expect(f.transport.readAlertMessages).not.toHaveBeenCalled();
  });
});
