import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { matchAlertNotificationRule } from "./alert-notification-rules.js";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const rule = { id: "notice", kind: "notification", verified: true, senderAppIds: ["cli_alarm"], title: "通知", bodyIncludes: ["原因：正常分支"], summary: "无需操作", evidence: "verified runbook" };
const message = { messageId: "om_one", chatId: "oc_group", senderId: "cli_alarm", senderType: "app", createdAt: 1, content: "通知\n订单: A\n原因：正常分支" };
function run(rules: unknown[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notification-rule-")); dirs.push(dir);
  fs.mkdirSync(path.join(dir, "references"));
  fs.writeFileSync(path.join(dir, "references", "notification-rules.json"), JSON.stringify({ rules }));
  return (content = message.content, senderId = message.senderId) => matchAlertNotificationRule(path.join(dir, "SKILL.md"), { ...message, content, senderId });
}
it("requires verified notification classification and evidence, never merely a shared title", () => {
  for (const r of [{ ...rule, verified: false }, { ...rule, kind: "fault" }, { ...rule, evidence: "" }, { ...rule, bodyIncludes: [] }]) expect(run([r])()).toBeUndefined();
  expect(run([rule])()).toEqual(rule);
  expect(run([rule])("通知\n订单:B\n原因：实际失败")).toBeUndefined();
  expect(run([rule])(message.content, "cli_other")).toBeUndefined();
});
it("does not accept quoted or negated reason substrings and does not choose among overlapping rules", () => {
  expect(run([rule])("通知\n实际不是原因：正常分支")).toBeUndefined();
  expect(run([rule, { ...rule, id: "overlap" }])()).toBeUndefined();
});
