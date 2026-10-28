import type { AppConfig, FollowupRequest, FollowupObservation, AgentTaskFollowup, AgentTaskTarget } from "@codebridge/core";
import type { SqliteEventStore } from "@codebridge/work-items";
import type { SessionCatalogStore } from "@codebridge/session-catalog";

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("跟进参数必须是对象");
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("跟进文本为空或过长");
  return value.trim();
};
export function followupNames(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20 || value.some((v) => typeof v !== "string" || !v.trim() || v.length > 100 || /[\x00-\x1f<>@]/u.test(v))) throw new Error("通知对象须为本群姓名，不能指定ID或其他目标");
  return [...new Set(value.map((v: string) => v.trim()))].sort();
}
export function readFollowupRequest(value: unknown): FollowupRequest {
  const v = object(value);
  if (Object.keys(v).some((k) => !["name", "prompt", "skills", "intervalMinutes", "timeoutMinutes", "notifyNames", "allowedNotifyNames"].includes(k))) throw new Error("跟进来源、模型和权限由后端绑定，不接受额外字段");
  const intervalMinutes = v.intervalMinutes ?? 1, timeoutMinutes = v.timeoutMinutes ?? 30;
  if (!Number.isSafeInteger(intervalMinutes) || !Number.isSafeInteger(timeoutMinutes) || Number(intervalMinutes) < 1 || Number(timeoutMinutes) < Number(intervalMinutes) || Number(timeoutMinutes) > 525600) throw new Error("跟进间隔与期限须为正整数分钟，期限不小于间隔且不超过365天");
  const skills = v.skills ?? [];
  if (!Array.isArray(skills) || skills.length > 20 || skills.some((s) => typeof s !== "string" || !s.trim() || s.length > 200)) throw new Error("所选Skill无效");
  return { name: text(v.name, 100), prompt: text(v.prompt, 64000), skills: [...new Set(skills)], intervalMinutes: Number(intervalMinutes), timeoutMinutes: Number(timeoutMinutes),
    ...(v.notifyNames !== undefined ? { notifyNames: followupNames(v.notifyNames)! } : {}), ...(v.allowedNotifyNames !== undefined ? { allowedNotifyNames: followupNames(v.allowedNotifyNames)! } : {}) };
}
export function readFollowupObservation(value: unknown): FollowupObservation {
  const v = object(value);
  if (Object.keys(v).some((k) => !["status", "summary", "key", "notifyNames", "caseStatus"].includes(k)) || !["waiting", "progress", "completed", "blocked"].includes(String(v.status))) throw new Error("跟进观察状态无效");
  const key = v.key === undefined ? undefined : text(v.key, 100);
  if (v.status === "progress" && !key) throw new Error("阶段进展须提供稳定key；没有变化请用waiting");
  if (v.caseStatus !== undefined && !["resolved", "no_action", "waiting", "blocked"].includes(String(v.caseStatus))) throw new Error("案件状态无效");
  return { status: v.status as FollowupObservation["status"], summary: text(v.summary, 2000), ...(key ? { key } : {}),
    ...(v.notifyNames !== undefined ? { notifyNames: followupNames(v.notifyNames)! } : {}), ...(v.caseStatus ? { caseStatus: v.caseStatus as FollowupObservation["caseStatus"] } : {}) };
}
export function followupSource(items: SqliteEventStore, catalog: SessionCatalogStore, config: AppConfig, runId: string) {
  const run = items.getRun(runId), turn = run?.turnId ? items.getTurn(run.turnId) : undefined;
  const session = run?.sessionId ? catalog.getSession(run.sessionId) : undefined;
  const actor = turn?.message.actorRef;
  const deliveries = items.listDeliveries("feishu").filter((d) => d.runId === runId && d.turnId === run?.turnId);
  if (!run || !session || actor?.channel !== "feishu" || deliveries.length !== 1) throw new Error("跟进必须来自可核实的飞书Run、真实发起人和唯一投递来源");
  const delivery = deliveries[0]!, [chatId, topicId, extra] = delivery.conversationId.split("|");
  if (!chatId?.startsWith("oc_") || extra !== undefined || !delivery.replyToMessageId) throw new Error("飞书跟进来源无效");
  const group = config.feishu.alertMonitor?.groups.find((g) => g.chatId === chatId && g.senderAppIds.includes(actor.id));
  const human = actor.id.startsWith("ou_");
  const managers = human ? [actor.id] : group?.approverOpenIds?.length ? group.approverOpenIds : group?.ownerOpenId ? [group.ownerOpenId] : [];
  if (!managers.length) throw new Error("来源不是已识别的用户或已授权的告警机器人");
  const origin: AgentTaskFollowup["origin"] = { runId, sourceMessageId: delivery.replyToMessageId, creatorId: actor.id, managerIds: [...new Set(managers)], isGroup: Boolean(delivery.replyContext) || Boolean(group) };
  const target: AgentTaskTarget = { channel: "feishu", chatId, ...(topicId ? { topicId } : {}) };
  return { run, session, origin, target, defaultRecipientIds: human ? [actor.id] : group?.responsibleOpenIds ?? managers };
}
