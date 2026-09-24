import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@codebridge/core";
import type { FeishuAlertReaction } from "@codebridge/channel-feishu";
import { FeishuAlertMonitor } from "./feishu-alert-monitor.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
async function fixture(duplicates = false, runbook = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alert-status-")); roots.push(root);
  let now = 1_000_000;
  const runbookPath = path.join(root, "SKILL.md");
  if (runbook) fs.writeFileSync(runbookPath, "# Runbook v1\nRead the alarm matrix before investigating.");
  const config: NonNullable<AppConfig["feishu"]["alertMonitor"]> = {
    pollIntervalMs: 60_000, lookbackMs: 600_000, dedupWindowMs: 1_800_000, maxConcurrent: 2, incidentRetentionMs: 604_800_000,
    statusReactions: { investigating: "OnIt", waiting: "OneSecond", resolved: "DONE", no_action: "CrossMark", blocked: "Sigh" },
    groups: [{ chatId: "oc_alert", ownerOpenId: "ou_owner", senderAppIds: ["cli_alarm"], ...(runbook ? { runbookPath } : {}) }],
  };
  const message = { messageId: "om_root", chatId: "oc_alert", senderId: "cli_alarm", senderType: "app", createdAt: 1_000_100, content: "failure" };
  const transport = {
    readAlertDone: vi.fn(async (): Promise<FeishuAlertReaction | undefined> => undefined),
    readAlertMessages: vi.fn(async () => ({ messages: duplicates ? [message, { ...message, messageId: "om_duplicate" }] : [message], hasMore: false })),
    investigateAlert: vi.fn(async () => {}), isAlertActive: vi.fn(async () => false),
    setAlertMessageReaction: vi.fn(async () => "reaction"), notifyAlertOwner: vi.fn(async () => {}), cancelAlertInvestigation: vi.fn(async () => {}),
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
    expect(f.transport.notifyAlertOwner).toHaveBeenCalledWith("oc_alert", "om_root", ["ou_owner"], "请确认补货计划");
    await f.monitor.setStatus("oc_alert", "om_root", "waiting", "请确认补货计划");
    expect(f.transport.notifyAlertOwner).toHaveBeenCalledTimes(1);
    await f.monitor.prepareReply({ messageId: "om_reply", chatId: "oc_alert", chatType: "group", senderId: "ou_owner", content: "继续查" }, "om_root");
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
    expect(f.transport.notifyAlertOwner).toHaveBeenCalledWith("oc_alert", "om_root", ["ou_owner"], expect.stringContaining("未提交可核验"));
    expect(f.transport.setAlertMessageReaction.mock.calls.some((call) => (call as unknown[])[1] === "DONE")).toBe(false);
  });
  it("loads the configured skill for every alert and owner follow-up", async () => {
    const f = await fixture(false, true);
    expect(f.transport.investigateAlert).toHaveBeenCalledWith(f.message, ["ou_owner"], expect.stringContaining("Runbook v1"));
    fs.writeFileSync(f.runbookPath, "# Runbook v2\nUpdated alarm matrix rules.");
    const reply = await f.monitor.prepareReply({ messageId: "om_reply", chatId: "oc_alert", chatType: "group", senderId: "ou_owner", content: "继续" }, "om_root");
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
    expect(await resumed.prepareReply({ messageId: "om_other", chatId: "oc_alert", chatType: "group", senderId: "ou_other", content: "批准" }, "om_root")).toMatchObject({ allowed: true, instructions: expect.stringContaining("不构成任何写操作授权") });
  });

  it("closes every duplicate card as owner-dismissed and ignores late Agent status reports", async () => {
    const f = await fixture(true);
    const response = await f.monitor.prepareReply({ messageId: "om_owner_close", chatId: "oc_alert", chatType: "group", senderId: "ou_owner", rootId: "om_duplicate", content: "无需处理" }, "omt_native");
    expect(response).toMatchObject({ allowed: true, handled: true, topicId: "om_root" });
    for (const id of ["om_root", "om_duplicate"]) expect(f.transport.setAlertMessageReaction).toHaveBeenCalledWith(id, "DONE", expect.any(Array));
    await f.monitor.setStatus("oc_alert", "om_root", "waiting", "late result");
    const state = JSON.parse(fs.readFileSync(f.options.statePath, "utf8"));
    expect(state.oc_alert.incidents.om_root.status).toBe("dismissed");
    expect(state.oc_alert.incidents.om_root.dismissal.messageId).toBe("om_owner_close");
    expect(f.transport.cancelAlertInvestigation).toHaveBeenCalledWith("oc_alert", "om_root");
    expect(f.transport.notifyAlertOwner).not.toHaveBeenCalled();
  });

  it("does not accept an Agent's claimed dismissal, but any group member may close explicitly", async () => {
    const f = await fixture();
    await expect(f.monitor.setStatus("oc_alert", "om_root", "dismissed", "owner said no action")).rejects.toThrow();
    for (const content of ["如果无需处理就结束", "不是无需处理，继续查", "他说无需处理"]) {
      const reply = await f.monitor.prepareReply({ messageId: "om_context", chatId: "oc_alert", chatType: "group", senderId: "ou_owner", content }, "om_root");
      expect(reply?.handled).not.toBe(true);
    }
    expect(await f.monitor.prepareReply({ messageId: "om_other", chatId: "oc_alert", chatType: "group", senderId: "ou_other", content: "无需处理" }, "om_root")).toMatchObject({ allowed: true, handled: true });
    const incident = JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).oc_alert.incidents.om_root;
    expect(incident.dismissal).toMatchObject({ ownerOpenId: "ou_other", messageId: "om_other" });
    expect(incident.summary).toContain("群成员确认无需处理");
  });

  it("gives queued cards an intermediate reaction even when the investigation limit is reached", async () => {
    const f = await fixture(); f.config.maxConcurrent = 1; f.transport.isAlertActive.mockResolvedValue(true);
    f.transport.readAlertMessages.mockResolvedValueOnce({ hasMore: false, messages: [
      { ...f.message, messageId: "om_queued_1", content: "new failure one" },
      { ...f.message, messageId: "om_queued_2", content: "new failure two" },
    ] });
    f.advance(); await f.monitor.tick();
    expect(f.transport.investigateAlert).toHaveBeenCalledTimes(1);
    for (const id of ["om_queued_1", "om_queued_2"]) expect(f.transport.setAlertMessageReaction).toHaveBeenCalledWith(id, "OnIt", expect.any(Array));
  });

  it("keeps future duplicates closed after restart while preserving distinct business entities", async () => {
    const f = await fixture();
    await f.monitor.prepareReply({ messageId: "om_close", chatId: "oc_alert", chatType: "group", senderId: "ou_owner", content: "不用处理" }, "om_root");
    for (let i = 0; i < 31; i++) f.advance();
    f.transport.readAlertMessages.mockResolvedValueOnce({ hasMore: false, messages: [
      { ...f.message, messageId: "om_late_duplicate", createdAt: f.options.now(), content: "failure\n告警时间: 2026-09-23 20:01:00" },
      { ...f.message, messageId: "om_other_order", createdAt: f.options.now(), content: "failure\n订单: NEW123" },
    ] });
    await new FeishuAlertMonitor(f.options).tick();
    expect(f.transport.setAlertMessageReaction).toHaveBeenCalledWith("om_late_duplicate", "DONE", expect.any(Array));
    expect(f.transport.investigateAlert).toHaveBeenCalledTimes(2);
  });

  it("marks unreadable cards individually as waiting instead of silently dropping or merging them", async () => {
    const f = await fixture();
    f.transport.readAlertMessages.mockResolvedValueOnce({ hasMore: false, messages: [
      { ...f.message, messageId: "om_blank_1", content: "" }, { ...f.message, messageId: "om_blank_2", content: "" },
    ] });
    f.advance(); await f.monitor.tick();
    for (const id of ["om_blank_1", "om_blank_2"]) expect(f.transport.setAlertMessageReaction).toHaveBeenCalledWith(id, "OneSecond", expect.any(Array));
    const state = JSON.parse(fs.readFileSync(f.options.statePath, "utf8"));
    expect(state.oc_alert.incidents.om_blank_1.status).toBe("waiting");
    expect(state.oc_alert.incidents.om_blank_2.status).toBe("waiting");
    expect(f.transport.investigateAlert).toHaveBeenCalledTimes(1);
  });

  it("does not reactivate an incident dismissed while the Agent submit was in flight", async () => {
    const f = await fixture(); f.transport.isAlertActive.mockResolvedValue(true);
    f.transport.readAlertMessages.mockResolvedValueOnce({ hasMore: false, messages: [{ ...f.message, messageId: "om_inflight", content: "new issue" }] });
    f.transport.investigateAlert.mockImplementationOnce(async () => {
      await f.monitor.prepareReply({ messageId: "om_close_inflight", chatId: "oc_alert", chatType: "group", senderId: "ou_owner", content: "无需处理" }, "om_inflight");
    });
    f.advance(); await f.monitor.tick();
    const incident = JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).oc_alert.incidents.om_inflight;
    expect(incident.status).toBe("dismissed"); expect(incident.active).toBe(false);
    expect(f.transport.cancelAlertInvestigation).toHaveBeenLastCalledWith("oc_alert", "om_inflight");
  });

  it("continues marking other duplicate cards when one card's reaction fails", async () => {
    const f = await fixture(true); f.transport.setAlertMessageReaction.mockRejectedValueOnce(new Error("card unavailable"));
    await expect(f.monitor.setStatus("oc_alert", "om_root", "no_action", "已确认是通知")).rejects.toThrow("card unavailable");
    expect(f.transport.setAlertMessageReaction).toHaveBeenCalledWith("om_duplicate", "CrossMark", expect.any(Array));
    const incident = JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).oc_alert.incidents.om_root;
    expect(incident.reactionApplied.om_duplicate).toBe("CrossMark");
  });

  it("closes by any human's native DONE on an original duplicate card, never by the bot, by removal or by another emoji", async () => {
    const f = await fixture(true);
    for (const reaction of [
      { operatorOpenId: "cli_bot", emojiType: "DONE", action: "added" as const },
      { operatorOpenId: "ou_owner", emojiType: "DONE", action: "removed" as const },
      { operatorOpenId: "ou_owner", emojiType: "THUMBSUP", action: "added" as const },
    ]) await f.monitor.prepareReaction({ messageId: "om_duplicate", ...reaction });
    expect(JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).oc_alert.incidents.om_root.dismissal).toBeUndefined();
    await f.monitor.prepareReaction({ messageId: "om_duplicate", operatorOpenId: "ou_other", emojiType: "DONE", action: "added", actionTime: f.options.now() });
    const incident = JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).oc_alert.incidents.om_root;
    expect(incident.dismissal).toMatchObject({ ownerOpenId: "ou_other", messageId: "om_duplicate", via: "reaction" });
    for (const id of ["om_root", "om_duplicate"]) expect(f.transport.setAlertMessageReaction).toHaveBeenCalledWith(id, "DONE", expect.any(Array));
    expect(f.transport.investigateAlert).toHaveBeenCalledTimes(1);
  });

  it("recovers a missed owner DONE while collection is paused and keeps old reactions from reclosing an explicitly reopened case", async () => {
    const f = await fixture(); f.config.enabled = false;
    const oldTime = f.options.now();
    f.transport.readAlertDone.mockResolvedValue({ messageId: "om_root", operatorOpenId: "ou_owner", emojiType: "DONE", action: "added", actionTime: oldTime });
    const restarted = new FeishuAlertMonitor(f.options); await restarted.tick();
    expect(JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).oc_alert.incidents.om_root.status).toBe("dismissed");
    f.advance(); await restarted.prepareReply({ messageId: "om_reopen", chatId: "oc_alert", chatType: "group", senderId: "ou_owner", content: "重新排查" }, "om_root");
    await restarted.prepareReaction({ messageId: "om_root", operatorOpenId: "ou_owner", emojiType: "DONE", action: "added", actionTime: oldTime });
    expect(JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).oc_alert.incidents.om_root.status).toBe("investigating");
    await restarted.prepareReaction({ messageId: "om_root", operatorOpenId: "ou_owner", emojiType: "DONE", action: "added", actionTime: f.options.now() + 1 });
    expect(JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).oc_alert.incidents.om_root.status).toBe("dismissed");
  });

  it("groups different objects only when every card matches the same verified pure-notification rule", async () => {
    const f = await fixture(false, true); f.transport.isAlertActive.mockResolvedValue(true);
    const rulesDir = path.join(path.dirname(f.runbookPath), "references"); fs.mkdirSync(rulesDir);
    const rule = { id: "notice-only", kind: "notification", verified: true, senderAppIds: ["cli_alarm"], title: "正常通知", bodyIncludes: ["原因：仅通知，无需业务操作"], summary: "已确认通知类，无需业务动作", evidence: "owner-confirmed matrix rule" };
    fs.writeFileSync(path.join(rulesDir, "notification-rules.json"), JSON.stringify({ rules: [rule] }));
    f.transport.readAlertMessages.mockResolvedValueOnce({ hasMore: false, messages: [
      { ...f.message, messageId: "om_notice_a", content: "正常通知\n订单: A\n原因：仅通知，无需业务操作" },
      { ...f.message, messageId: "om_notice_b", content: "正常通知\n订单: B\n原因：仅通知，无需业务操作" },
      { ...f.message, messageId: "om_fault_c", content: "正常通知\n订单: C\n原因：实际失败" },
    ] });
    f.advance(); await f.monitor.tick();
    const state = JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).oc_alert.incidents;
    expect(state.om_notice_a.sourceMessageIds).toEqual(["om_notice_a", "om_notice_b"]);
    expect(state.om_notice_a.status).toBe("no_action");
    expect(state.om_notice_a.notificationRule.id).toBe("notice-only");
    expect(state.om_fault_c.notificationRule).toBeUndefined();
    expect(f.transport.investigateAlert).toHaveBeenCalledTimes(2);
    for (const id of ["om_notice_a", "om_notice_b"]) expect(f.transport.setAlertMessageReaction).toHaveBeenCalledWith(id, "CrossMark", expect.any(Array));
  });

  it("leaves collection paused while pilot validation is in progress", async () => {
    const f = await fixture(); f.config.enabled = false; f.transport.readAlertMessages.mockClear();
    f.advance(); await f.monitor.tick(); expect(f.transport.readAlertMessages).not.toHaveBeenCalled();
  });
});
