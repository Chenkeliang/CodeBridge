import fs from "node:fs";
import path from "node:path";
import type { FeishuAlertMessage } from "@codebridge/channel-feishu";

export interface AlertNotificationRule {
  id: string;
  kind: "notification";
  verified: true;
  senderAppIds: string[];
  title: string;
  bodyIncludes: string[];
  summary: string;
  evidence: string;
}

/** Only a unique, explicitly verified notification rule may merge different business entities. */
export function matchAlertNotificationRule(runbookPath: string | undefined, message: FeishuAlertMessage): AlertNotificationRule | undefined {
  if (!runbookPath) return undefined;
  const file = path.join(path.dirname(runbookPath), "references", "notification-rules.json");
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (Buffer.byteLength(raw) > 64_000) throw new Error("Notification rules too large");
  const parsed = JSON.parse(raw) as { rules?: unknown };
  if (!Array.isArray(parsed.rules)) throw new Error("Invalid notification rules");
  const matches = parsed.rules.filter((value): value is AlertNotificationRule => {
    if (!value || typeof value !== "object") return false;
    const rule = value as Partial<AlertNotificationRule>;
    return rule.kind === "notification" && rule.verified === true
      && typeof rule.id === "string" && Boolean(rule.id.trim())
      && typeof rule.evidence === "string" && Boolean(rule.evidence.trim())
      && typeof rule.summary === "string" && Boolean(rule.summary.trim()) && rule.summary.length <= 2000
      && Array.isArray(rule.senderAppIds) && rule.senderAppIds.includes(message.senderId)
      && typeof rule.title === "string" && Boolean(rule.title.trim()) && message.content.split("\n")[0]?.trim() === rule.title
      && Array.isArray(rule.bodyIncludes) && rule.bodyIncludes.length > 0
      && rule.bodyIncludes.every((part) => typeof part === "string" && Boolean(part.trim()) && message.content.split("\n").some((line) => line.trim() === part.trim()));
  });
  return matches.length === 1 ? matches[0] : undefined;
}
