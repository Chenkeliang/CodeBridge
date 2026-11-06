import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FeishuAlertMessage } from "@codebridge/channel-feishu";

export interface AlertClosureRule {
  id: string;
  kind: "after_triage";
  verified: true;
  senderAppIds: string[];
  title: string;
  bodyIncludes: string[];
  evidence: string;
  authorization: { messageId: string; contentSha256: string };
}

/** Unlike notifications, these rules never batch different orders or skip investigation. */
export function matchAlertClosureRule(runbookPath: string | undefined, message: FeishuAlertMessage): { rule: AlertClosureRule; revision: string } | undefined {
  if (!runbookPath || message.senderType !== "app") return undefined;
  const file = path.join(path.dirname(runbookPath), "references", "closure-rules.json");
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (Buffer.byteLength(raw) > 64_000) throw new Error("Closure rules too large");
  const parsed = JSON.parse(raw) as { version?: unknown; rules?: unknown };
  if (parsed.version !== 1 || !Array.isArray(parsed.rules)) throw new Error("Invalid closure rules");
  const matches = parsed.rules.filter((value): value is AlertClosureRule => {
    if (!value || typeof value !== "object") return false;
    const rule = value as Partial<AlertClosureRule>;
    return rule.kind === "after_triage" && rule.verified === true
      && typeof rule.id === "string" && Boolean(rule.id.trim())
      && typeof rule.evidence === "string" && Boolean(rule.evidence.trim())
      && Array.isArray(rule.senderAppIds) && rule.senderAppIds.length > 0
      && rule.senderAppIds.every(id => typeof id === "string" && Boolean(id.trim())) && rule.senderAppIds.includes(message.senderId)
      && typeof rule.title === "string" && Boolean(rule.title.trim()) && message.content.split("\n")[0]?.trim() === rule.title
      && Array.isArray(rule.bodyIncludes) && rule.bodyIncludes.length > 0
      && rule.bodyIncludes.every(part => typeof part === "string" && Boolean(part.trim()) && message.content.split("\n").some(line => line.trim() === part.trim()))
      && typeof rule.authorization?.messageId === "string" && /^om_[A-Za-z0-9_]+$/u.test(rule.authorization.messageId)
      && typeof rule.authorization.contentSha256 === "string" && /^[a-f0-9]{64}$/u.test(rule.authorization.contentSha256);
  });
  if (matches.length > 1) throw new Error("同一告警命中多条结案规则，未选择授权");
  const rule = matches[0];
  return rule ? { rule, revision: createHash("sha256").update(JSON.stringify(rule)).digest("hex") } : undefined;
}
