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
  /** Trusted SKILL conditions; require explicit Agent selection after per-case verification. */
  conditions?: string;
  authorization: { messageId: string; contentSha256: string };
}

export const ALERT_CLOSURE_RULES_FILENAME = "closure-rules.json";

/** Resolve rules beside the real entry and refuse a second rules file beside an alias. */
export function resolveAlertClosureRulesFile(runbookPath: string): string {
  const realDirectory = path.dirname(fs.realpathSync(runbookPath));
  const references = path.join(realDirectory, "references");
  const target = path.join(references, ALERT_CLOSURE_RULES_FILENAME);
  const alias = path.join(path.dirname(path.resolve(runbookPath)), "references", ALERT_CLOSURE_RULES_FILENAME);
  const aliasEntry = fs.lstatSync(alias, { throwIfNoEntry: false });
  if (aliasEntry && path.join(fs.realpathSync(path.dirname(alias)), ALERT_CLOSURE_RULES_FILENAME) !== target) {
    throw new Error("SKILL 软链接位置存在另一份持续结案规则，请先核对规则文件位置");
  }
  const directory = fs.lstatSync(references, { throwIfNoEntry: false });
  if (directory && !directory.isDirectory()) throw new Error("持续结案规则的 references 须为当前 Skill 内的普通目录");
  const entry = fs.lstatSync(target, { throwIfNoEntry: false });
  if (entry && !entry.isFile()) throw new Error("持续结案规则须为当前 Skill 内的普通文件");
  return target;
}

export function parseAlertClosureRules(raw: string): unknown[] {
  if (Buffer.byteLength(raw) > 64_000) throw new Error("Closure rules too large");
  const parsed = JSON.parse(raw) as { version?: unknown; rules?: unknown };
  if (parsed.version !== 1 || !Array.isArray(parsed.rules)) throw new Error("Invalid closure rules");
  return parsed.rules;
}

export function selectAlertClosureRule(rules: unknown[], message: FeishuAlertMessage, selectedRuleId?: string): { rule: AlertClosureRule; revision: string } | undefined {
  if (message.senderType !== "app") return undefined;
  const matches = rules.filter((value): value is AlertClosureRule => {
    if (!value || typeof value !== "object") return false;
    const rule = value as Partial<AlertClosureRule>;
    if (rule.conditions !== undefined && (typeof rule.conditions !== "string" || !rule.conditions.trim()
      || rule.conditions.length > 8000)) return false;
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
  const eligible = selectedRuleId === undefined
    ? matches.filter(rule => rule.conditions === undefined)
    : matches.filter(rule => rule.id === selectedRuleId);
  if (eligible.length > 1) throw new Error("同一告警命中多条结案规则，未选择授权");
  const rule = eligible[0];
  if (rule && rule.conditions === undefined && matches.some(match => match.conditions !== undefined)) {
    throw new Error("精确规则与条件规则同时匹配，须按业务条件显式选择条件规则");
  }
  return rule ? { rule, revision: createHash("sha256").update(JSON.stringify(rule)).digest("hex") } : undefined;
}

/** Unlike notifications, these rules never batch different orders or skip investigation. */
export function matchAlertClosureRule(runbookPath: string | undefined, message: FeishuAlertMessage, selectedRuleId?: string): { rule: AlertClosureRule; revision: string } | undefined {
  if (!runbookPath || message.senderType !== "app") return undefined;
  let raw: string;
  try { raw = fs.readFileSync(resolveAlertClosureRulesFile(runbookPath), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return selectAlertClosureRule(parseAlertClosureRules(raw), message, selectedRuleId);
}
