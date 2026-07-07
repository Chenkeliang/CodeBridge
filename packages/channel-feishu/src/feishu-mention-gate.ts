import type { FeishuMessage } from "./bridge.js";

export interface GroupMentionGateInput {
  chatId: string;
  mentionedBot?: boolean;
  topicId?: string;
  requireMention: boolean;
  /** 本话题是否已有 Agent session 或 bot 已回复过 */
  topicActive: boolean;
}

/** 群消息是否应触发 Agent（@ 要求由 Bridge 判断，SDK 层需关闭 requireMention） */
export function shouldAcceptGroupMessage(input: GroupMentionGateInput): boolean {
  if (!input.requireMention) return true;
  if (input.mentionedBot) return true;
  if (input.topicId && input.topicActive) return true;
  return false;
}

export function topicActiveForMessage(
  msg: FeishuMessage,
  topicId: string | undefined,
  hasSession: boolean,
  participatedTopics: ReadonlySet<string>,
): boolean {
  if (!topicId) return false;
  if (hasSession) return true;
  if (participatedTopics.has(topicId)) return true;
  if (msg.threadId === topicId && msg.mentionedBot) return true;
  return false;
}
