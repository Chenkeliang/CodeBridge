import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FeishuAlertMonitor, ALERT_INVESTIGATION_INSTRUCTIONS } from "./feishu-alert-monitor.js";
import type { FeishuAlertMessage } from "@codebridge/channel-feishu";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alert-monitor-")); roots.push(root);
  let now = 1_000_000;
  const config = { pollIntervalMs: 30_000, lookbackMs: 600_000, dedupWindowMs: 1_800_000, maxConcurrent: 2, incidentRetentionMs: 604_800_000,
    groups: [{ chatId: "oc_alerts", ownerOpenId: "ou_owner", senderAppIds: ["cli_alarm"] }] };
  const transport = { readAlertMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
    investigateAlert: vi.fn().mockResolvedValue(undefined), isAlertActive: vi.fn().mockResolvedValue(false) };
  const log = vi.fn();
  const statePath = path.join(root, "state.json");
  const options = { statePath, config: () => config, transport, log, now: () => now };
  return { config, transport, log, options, statePath, monitor: new FeishuAlertMonitor(options),
    advance: (ms = 1000) => { now += ms; },
    message: (id = "om_alert", content = "合单异常\ndata: TT123\nerr: timeout"): FeishuAlertMessage => ({
      messageId: id, chatId: "oc_alerts", createdAt: now - 100, senderId: "cli_alarm", senderType: "app", content,
    }),
  };
}

describe("FeishuAlertMonitor", () => {
  it("starts at activation time, without replaying old alerts", async () => {
    const f = fixture(); await f.monitor.tick();
    expect(f.transport.readAlertMessages).not.toHaveBeenCalled();
    f.advance(); f.transport.readAlertMessages.mockResolvedValue({ messages: [{ ...f.message(), createdAt: 999_999 }], hasMore: false });
    await f.monitor.tick(); expect(f.transport.investigateAlert).not.toHaveBeenCalled();
  });

  it("accepts only configured bot root messages, and merges identical alerts", async () => {
    const f = fixture(); await f.monitor.tick(); f.advance();
    f.transport.readAlertMessages.mockResolvedValue({ hasMore: false, messages: [f.message(), f.message("om_duplicate"),
      { ...f.message("om_human"), senderType: "user" }, { ...f.message("om_other"), senderId: "cli_other" },
      { ...f.message("om_reply"), rootId: "om_existing" }] });
    await f.monitor.tick();
    expect(f.transport.investigateAlert).toHaveBeenCalledTimes(1);
    expect(f.transport.investigateAlert).toHaveBeenCalledWith(f.message(), ["ou_owner"], ALERT_INVESTIGATION_INSTRUCTIONS);
    expect(ALERT_INVESTIGATION_INSTRUCTIONS).toContain("只授权只读排查");
    expect(ALERT_INVESTIGATION_INSTRUCTIONS).toContain("fcb alert status waiting");
  });

  it("does not resubmit a message after restart or overlap", async () => {
    const f = fixture(); await f.monitor.tick(); f.advance(); const message = f.message();
    f.transport.readAlertMessages.mockResolvedValue({ hasMore: false, messages: [message] });
    await f.monitor.tick(); f.advance(); await new FeishuAlertMonitor(f.options).tick();
    expect(f.transport.investigateAlert).toHaveBeenCalledTimes(1);
  });

  it("keeps the root and approvers across restart; anyone may chat but only approvers carry write authority", async () => {
    const f = fixture(); await f.monitor.tick(); f.advance();
    f.transport.readAlertMessages.mockResolvedValue({ hasMore: false, messages: [f.message()] }); await f.monitor.tick();
    expect(f.transport.investigateAlert).toHaveBeenCalledWith(expect.anything(), ["ou_owner"], expect.any(String));
    const monitor = new FeishuAlertMonitor(f.options);
    const reply = { messageId: "om_answer", chatId: "oc_alerts", chatType: "group" as const, senderId: "ou_other", content: "这单昨天也报过，是仓库盘点" };
    const member = await monitor.prepareReply(reply, "om_alert");
    expect(member?.allowed).toBe(true); expect(member?.instructions).toContain("群成员（非审批人）"); expect(member?.instructions).toContain("不构成任何写操作授权");
    const accepted = await monitor.prepareReply({ ...reply, messageId: "om_owner", senderId: "ou_owner" }, "om_alert");
    expect(accepted?.allowed).toBe(true); expect(accepted?.instructions).toContain("审批人（已核实身份）"); expect(accepted?.instructions).toContain("本次明确授权");
    expect(new FeishuAlertMonitor(f.options).isAlertMessage("oc_alerts", "om_answer")).toBe(true);
    expect(await monitor.prepareReply({ ...reply, chatId: "oc_other" }, "om_alert")).toBeUndefined();
  });

  it("uses approverOpenIds when configured", async () => {
    const f = fixture();
    f.config.groups[0] = { chatId: "oc_alerts", senderAppIds: ["cli_alarm"], approverOpenIds: ["ou_a", "ou_b"] } as unknown as typeof f.config.groups[0];
    await f.monitor.tick(); f.advance();
    f.transport.readAlertMessages.mockResolvedValue({ hasMore: false, messages: [f.message()] }); await f.monitor.tick();
    expect(f.transport.investigateAlert).toHaveBeenCalledWith(expect.anything(), ["ou_a", "ou_b"], expect.any(String));
    const monitor = new FeishuAlertMonitor(f.options);
    expect((await monitor.prepareReply({ messageId: "om_b", chatId: "oc_alerts", chatType: "group", senderId: "ou_b", content: "重试一次" }, "om_alert"))?.instructions).toContain("审批人（已核实身份）");
  });

  it("forgets terminal incidents after the retention window so their threads become ordinary again", async () => {
    const f = fixture(); await f.monitor.tick(); f.advance();
    f.transport.readAlertMessages.mockResolvedValue({ hasMore: false, messages: [f.message()] }); await f.monitor.tick();
    await f.monitor.prepareReply({ messageId: "om_close", chatId: "oc_alerts", chatType: "group", senderId: "ou_other", content: "无需处理" }, "om_alert");
    expect(f.monitor.isAlertMessage("oc_alerts", "om_alert")).toBe(true);
    f.transport.readAlertMessages.mockResolvedValue({ hasMore: false, messages: [] });
    f.advance(604_800_000 - 10_000); await f.monitor.tick();
    expect(f.monitor.isAlertMessage("oc_alerts", "om_alert")).toBe(true);
    f.advance(20_000); await f.monitor.tick();
    expect(f.monitor.isAlertMessage("oc_alerts", "om_alert")).toBe(false);
    expect(await f.monitor.prepareReply({ messageId: "om_late", chatId: "oc_alerts", chatType: "group", senderId: "ou_other", content: "还在吗" }, "om_alert")).toBeUndefined();
  });

  it("retries a failed submit with the original message and persisted pending incident", async () => {
    const f = fixture(); await f.monitor.tick(); f.advance(); const message = f.message();
    f.transport.readAlertMessages.mockResolvedValue({ hasMore: false, messages: [message] });
    f.transport.investigateAlert.mockRejectedValueOnce(new Error("connection lost"));
    await f.monitor.tick(); f.transport.readAlertMessages.mockResolvedValue({ hasMore: false, messages: [] });
    f.advance(); await new FeishuAlertMonitor(f.options).tick();
    expect(f.transport.investigateAlert).toHaveBeenCalledTimes(2);
    expect(f.transport.investigateAlert.mock.calls[0]).toEqual(f.transport.investigateAlert.mock.calls[1]);
  });

  it("does not advance history on a failed list request", async () => {
    const f = fixture(); await f.monitor.tick(); f.advance();
    const before = JSON.parse(fs.readFileSync(f.statePath, "utf8")).oc_alerts.cursor;
    f.transport.readAlertMessages.mockRejectedValueOnce(new Error("rate limited")); await f.monitor.tick();
    expect(JSON.parse(fs.readFileSync(f.statePath, "utf8")).oc_alerts.cursor).toBe(before);
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining("保留进度"));
  });

  it("drains pagination with a stable time window", async () => {
    const f = fixture(); await f.monitor.tick(); f.advance();
    f.transport.readAlertMessages.mockResolvedValueOnce({ hasMore: true, pageToken: "next", messages: [f.message()] })
      .mockResolvedValueOnce({ hasMore: false, messages: [f.message("om_second", "another failure")] });
    await f.monitor.tick();
    expect(f.transport.readAlertMessages.mock.calls[0]?.slice(0, 3)).toEqual(f.transport.readAlertMessages.mock.calls[1]?.slice(0, 3));
    expect(f.transport.readAlertMessages.mock.calls[1]?.[3]).toBe("next");
    expect(f.transport.investigateAlert).toHaveBeenCalledTimes(2);
  });

  it("continues a bounded scan after restart even when all messages have the same timestamp", async () => {
    const f = fixture(); await f.monitor.tick(); f.advance(); const when = f.message().createdAt;
    f.transport.readAlertMessages.mockImplementation(async (_chat, _start, _end, token) => {
      const n = Number(token ?? 0);
      return { messages: [{ ...f.message(`om_${n}`, `failure ${n}`), createdAt: when }], hasMore: n < 6, pageToken: String(n + 1) };
    });
    await f.monitor.tick(); f.advance(); await new FeishuAlertMonitor(f.options).tick();
    const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
    expect(Object.keys(state.oc_alerts.incidents)).toHaveLength(7);
  });

  it("accepts a delayed message within the overlapping second without replaying the previous one", async () => {
    const f = fixture(); await f.monitor.tick(); f.advance(); await f.monitor.tick();
    const delayed = { ...f.message("om_delayed"), createdAt: 1_000_900 };
    f.advance(); f.transport.readAlertMessages.mockResolvedValue({ messages: [delayed], hasMore: false });
    await f.monitor.tick(); expect(f.transport.investigateAlert).toHaveBeenCalledTimes(1);
  });

  it("backfills an alert that becomes visible five minutes late without rerunning an already-seen alert", async () => {
    const f = fixture(); await f.monitor.tick(); f.advance(60_000);
    const first = { ...f.message("om_first", "first failure"), createdAt: 1_001_000 };
    const late = { ...f.message("om_late", "late failure"), createdAt: 1_002_000 };
    let showLate = false;
    f.transport.readAlertMessages.mockImplementation(async (_chat, start, end) => ({
      hasMore: false,
      messages: (showLate ? [first, late] : [first]).filter((message) => message.createdAt >= start * 1000 && message.createdAt <= end * 1000),
    }));
    await f.monitor.tick();
    f.advance(5 * 60_000); showLate = true; await f.monitor.tick();
    expect(f.transport.investigateAlert).toHaveBeenCalledTimes(2);
    expect(f.transport.investigateAlert).toHaveBeenLastCalledWith(late, ["ou_owner"], ALERT_INVESTIGATION_INSTRUCTIONS);
    f.advance(60_000); await new FeishuAlertMonitor(f.options).tick();
    expect(f.transport.investigateAlert).toHaveBeenCalledTimes(2);
  });

  it("catches up a two-hour outage from the saved checkpoint instead of limiting reads to the last ten minutes", async () => {
    const f = fixture(); await f.monitor.tick(); f.advance(60_000); await f.monitor.tick();
    const offlineAlert = { ...f.message("om_offline"), createdAt: 1_100_000 };
    f.advance(2 * 60 * 60_000);
    f.transport.readAlertMessages.mockImplementation(async (_chat, start, end) => ({
      hasMore: false, messages: offlineAlert.createdAt >= start * 1000 && offlineAlert.createdAt <= end * 1000 ? [offlineAlert] : [],
    }));
    await new FeishuAlertMonitor(f.options).tick();
    expect(f.transport.investigateAlert).toHaveBeenCalledWith(offlineAlert, ["ou_owner"], ALERT_INVESTIGATION_INSTRUCTIONS);
  });

  it("limits active investigations and dispatches pending work once a slot is free", async () => {
    const f = fixture(); f.config.maxConcurrent = 1; await f.monitor.tick(); f.advance();
    f.transport.readAlertMessages.mockResolvedValueOnce({ messages: [f.message(), f.message("om_second", "another error")], hasMore: false });
    await f.monitor.tick(); expect(f.transport.investigateAlert).toHaveBeenCalledTimes(1);
    f.transport.isAlertActive.mockResolvedValue(true); f.advance(); await f.monitor.tick();
    expect(f.transport.investigateAlert).toHaveBeenCalledTimes(1);
    f.transport.isAlertActive.mockResolvedValue(false); f.advance(); await f.monitor.tick();
    expect(f.transport.investigateAlert).toHaveBeenCalledTimes(2);
  });

  it("coalesces overlapping ticks", async () => {
    const f = fixture(); await f.monitor.tick(); f.advance();
    let release!: () => void;
    f.transport.readAlertMessages.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ messages: [f.message()], hasMore: false });
    }));
    const first = f.monitor.tick(); const second = f.monitor.tick(); release();
    await Promise.all([first, second]); expect(f.transport.investigateAlert).toHaveBeenCalledTimes(1);
  });

  it("keeps duplicate-card replies under the same owner and canonical incident", async () => {
    const f = fixture(); await f.monitor.tick(); f.advance();
    f.transport.readAlertMessages.mockResolvedValue({ messages: [f.message(), f.message("om_duplicate")], hasMore: false });
    await f.monitor.tick();
    const reply = { messageId: "om_answer", chatId: "oc_alerts", chatType: "group" as const,
      senderId: "ou_other", content: "/approve", rootId: "om_duplicate", threadId: "omt_native" };
    expect(await f.monitor.prepareReply(reply, "omt_native")).toMatchObject({ allowed: true, topicId: "om_alert", instructions: expect.stringContaining("群成员（非审批人）") });
    expect((await f.monitor.prepareReply({ ...reply, senderId: "ou_owner" }, "omt_native"))?.topicId).toBe("om_alert");
  });

  it("honors disable while a history request is in flight", async () => {
    const f = fixture(); let enabled = true;
    const monitor = new FeishuAlertMonitor({ ...f.options, config: () => enabled ? f.config : undefined });
    await monitor.tick(); f.advance();
    f.transport.readAlertMessages.mockImplementationOnce(async () => {
      enabled = false; return { messages: [f.message()], hasMore: false };
    });
    await monitor.tick(); expect(f.transport.investigateAlert).not.toHaveBeenCalled();
  });

  it("is inert when unconfigured or in maintenance", async () => {
    const f = fixture();
    await new FeishuAlertMonitor({ ...f.options, config: () => undefined }).tick();
    await new FeishuAlertMonitor({ ...f.options, isMaintenance: () => true }).tick();
    expect(f.transport.readAlertMessages).not.toHaveBeenCalled();
  });
});
