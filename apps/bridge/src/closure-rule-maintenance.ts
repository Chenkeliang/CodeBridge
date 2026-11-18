import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { FeishuAlertMessage, FeishuMessage } from "@codebridge/channel-feishu";
import { parseAlertClosureRules, selectAlertClosureRule, type AlertClosureRule } from "./alert-closure-rules.js";
import { fileRevision, replaceManagedFile } from "./management-files.js";

type Rule = Omit<AlertClosureRule, "verified"> & { verified: boolean };
type RuleDraft = Omit<Rule, "authorization"> & { authorization?: { messageId: string; contentSha256?: string } };
type Group = { chatId: string; runbookPath?: string; senderAppIds: string[]; approverOpenIds?: string[]; ownerOpenId?: string; enabled?: boolean };
const ruleId = /^[A-Za-z0-9_-]{1,100}$/u;
const messageId = /^om_[A-Za-z0-9_]+$/u;
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const textList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(s => typeof s === "string" && Boolean(s.trim()));

export class ClosureRuleCheckError extends Error {
  constructor(readonly code: string, message: string, readonly approvalLine?: string) { super(message); }
}
function check(ok: unknown, code: string, message: string): asserts ok {
  if (!ok) throw new ClosureRuleCheckError(code, message);
}

function validatedDraft(value: unknown): RuleDraft {
  const r = value as Partial<RuleDraft> | null;
  check(r && r.kind === "after_triage" && typeof r.id === "string" && ruleId.test(r.id)
    && typeof r.verified === "boolean" && textList(r.senderAppIds) && textList(r.bodyIncludes)
    && typeof r.title === "string" && Boolean(r.title.trim()) && typeof r.evidence === "string" && Boolean(r.evidence.trim())
    && (r.conditions === undefined || typeof r.conditions === "string" && Boolean(r.conditions.trim()) && r.conditions.length <= 8000)
    && (r.authorization === undefined || r.authorization && typeof r.authorization.messageId === "string" && messageId.test(r.authorization.messageId)),
  "invalid_rule", "持续结案规则字段无效，请检查规则 ID、发送方、标题、原因和原始授权消息");
  return r as RuleDraft;
}

function scope(r: RuleDraft): string {
  return JSON.stringify([r.title, [...new Set(r.senderAppIds)].sort(), [...new Set(r.bodyIncludes.map(s => s.trim()))].sort(), r.conditions ?? null]);
}

/** Called by local management. The maintainer compares business meaning with the original approval. */
export async function maintainClosureRule(input: {
  group: Group;
  currentGroup: () => Group | undefined;
  dataDir: string;
  sample: FeishuAlertMessage;
  sampleRoots: string[];
  id: string;
  draft?: unknown;
  save: boolean;
  readApproval: (id: string) => Promise<FeishuMessage | undefined>;
}) {
  const { group, sample, id } = input;
  check(ruleId.test(id), "invalid_rule_id", "规则 ID 格式无效");
  check(group.runbookPath && group.enabled !== false, "group_unavailable", "本群告警监控或 SKILL 入口未配置");
  check(sample.chatId === group.chatId && sample.senderType === "app" && group.senderAppIds.includes(sample.senderId),
    "sample_mismatch", "样本不属于本群配置的告警来源");
  const directory = path.join(path.dirname(fs.realpathSync(group.runbookPath)), "references");
  check(fs.realpathSync(directory) === directory && fs.statSync(directory).isDirectory(),
    "invalid_rule_directory", "规则 references 须位于当前群的实际 SKILL 目录内");
  const file = path.join(directory, "closure-rules.json");
  const entry = fs.lstatSync(file, { throwIfNoEntry: false });
  check(!entry || entry.isFile(), "invalid_rule_file", "持续结案规则必须是本群内的普通文件");
  const raw = entry ? fs.readFileSync(file) : undefined;
  const revision = raw ? digest(raw) : fileRevision(file);
  const rules = (raw ? parseAlertClosureRules(raw.toString("utf8")) : []).map(value => {
    const rule = validatedDraft(value);
    check(typeof rule.authorization?.contentSha256 === "string" && /^[a-f0-9]{64}$/u.test(rule.authorization.contentSha256),
      "invalid_saved_authorization", "现有持续结案规则缺少原始授权摘要");
    return rule as Rule;
  });
  check(new Set(rules.map(r => r.id)).size === rules.length, "duplicate_rule_id", "本群有重复的持续结案规则 ID");
  const old = rules.find(r => r.id === id);
  check(input.draft !== undefined || old, "rule_not_registered", "本群尚未登记该规则 ID，请核对登记记录和名称");
  const draft = input.draft === undefined ? old! : validatedDraft(input.draft);
  check(draft.id === id, "rule_id_mismatch", "草稿与请求中的规则 ID 不一致");
  check(draft.verified, "rule_disabled", "该规则处于停用状态");
  check(draft.senderAppIds.every(sender => group.senderAppIds.includes(sender)), "sender_mismatch", "规则包含本群未配置的发送方");
  const scopeChanged = old !== undefined && scope(old) !== scope(draft);
  const authorId = draft.authorization?.messageId ?? (!scopeChanged && old?.verified ? old.authorization.messageId : undefined);
  const bindNewApproval = !old || scopeChanged || old.authorization.messageId !== authorId;
  const approvalLine = `批准持续结案 ${id} ${digest(JSON.stringify([group.chatId, id, scope(draft)]))}`;
  check(!scopeChanged || old?.authorization.messageId !== authorId,
    "new_authorization_required", "适用范围已变化，需要新的明确授权");
  check(old?.verified !== false || old.authorization.messageId !== authorId,
    "new_authorization_required", "停用规则需要明确重新批准才能启用");
  const preflightRule = { ...draft, authorization: { messageId: authorId ?? "om_preview", contentSha256: "0".repeat(64) } };
  const proposed = [...rules.filter(r => r.id !== id), preflightRule];
  let selected;
  try {
    selected = selectAlertClosureRule(proposed, sample, draft.conditions === undefined ? undefined : id);
    if (draft.conditions !== undefined && selectAlertClosureRule(proposed, sample)) {
      throw new ClosureRuleCheckError("overlapping_exact_rule", "另有启用的精确规则可匹配此样本，请先核对重叠范围");
    }
  } catch (error) {
    if (error instanceof ClosureRuleCheckError) throw error;
    throw new ClosureRuleCheckError("ambiguous_sample", "样本同时命中多条持续结案规则，请先消除重叠");
  }
  check(selected?.rule.id === id, "sample_mismatch", "样本未命中此规则，请核对发送方、标题和原始原因行");
  if (!authorId) {
    if (input.save) throw new ClosureRuleCheckError("authorization_required", "保存前须填入原话题批准消息 ID", approvalLine);
    return { ruleId: id, checked: true, saved: false, changed: false, authorizationPending: true, approvalLine };
  }
  const expectedHash = old?.authorization.messageId === authorId ? old.authorization.contentSha256 : draft.authorization?.contentSha256;
  const approval = await input.readApproval(authorId);
  const approvers = group.approverOpenIds?.length ? group.approverOpenIds : [group.ownerOpenId];
  check(approval?.messageId === authorId && approval.chatId === group.chatId
    && approvers.includes(approval.senderId) && approval.content.trim() && (approval.raw as { deleted?: boolean })?.deleted !== true,
  "authorization_unavailable", "原始授权消息或当前审批人未通过核验");
  const hash = digest(approval.content);
  check(!expectedHash || expectedHash === hash, "authorization_changed", "原始授权内容已变化，请核对新的明确授权");
  const date = Number((approval.raw as { create_time?: unknown })?.create_time);
  check(Number.isFinite(date) && date > 0, "authorization_time_unknown", "无法核验原始授权时间");
  if (bindNewApproval) {
    const root = (approval.raw as { root_id?: string })?.root_id;
    check(root && input.sampleRoots.includes(root), "authorization_thread_mismatch", "新增规则或变更范围时，请使用原批准所在告警作为样本");
    if (approval.content.trim() !== approvalLine) {
      throw new ClosureRuleCheckError("authorization_scope_unbound", "这条消息未绑定当前规则草稿。请在告警原话题展示范围，由审批人回复一次对应批准文本", approvalLine);
    }
  }
  const candidate: Rule = { id, kind: "after_triage", verified: true, title: draft.title, senderAppIds: [...draft.senderAppIds],
    bodyIncludes: [...draft.bodyIncludes], ...(draft.conditions === undefined ? {} : { conditions: draft.conditions }),
    evidence: draft.evidence, authorization: { messageId: authorId, contentSha256: hash } };
  const next = [...rules.filter(r => r.id !== id), candidate];
  check(JSON.stringify(input.currentGroup()) === JSON.stringify(group), "group_changed", "本群设置已改变，请重新预检");
  check(fileRevision(file) === revision, "rules_changed", "持续结案规则已被修改，请重新预检");
  const unchanged = old !== undefined && scope(old) === scope(candidate) && old.verified === candidate.verified
    && old.evidence === candidate.evidence && old.authorization.messageId === authorId && old.authorization.contentSha256 === hash;
  if (input.save && !unchanged) {
    const content = JSON.stringify({ version: 1, rules: next }, null, 2) + "\n";
    parseAlertClosureRules(content);
    if (entry) {
      replaceManagedFile(file, content, revision, input.dataDir);
    } else {
      const temporary = path.join(directory, `.closure-rules.${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
        fs.linkSync(temporary, file); // Exclusive creation preserves another maintainer's concurrent registration.
      } finally { fs.rmSync(temporary, { force: true }); }
    }
  }
  return { ruleId: id, checked: true, saved: input.save, changed: input.save && !unchanged,
    sampleAfterAuthorization: sample.createdAt >= date, requiresRuleId: candidate.conditions !== undefined,
    matrixReference: `[${id}](closure-rules.json)` };
}
