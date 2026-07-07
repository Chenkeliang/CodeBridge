import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import {
  fetchMessageContext,
  fetchQuotedMessage,
  formatTopicRootContext,
} from "./feishu-quoted-message.js";

export interface InboundContextMessage {
  threadId?: string;
  replyToMessageId?: string;
}

/**
 * 为入站消息组装话题/引用上下文：
 * - 话题群或回复串：注入话题根消息（告警、推送等）
 * - 直接回复某条消息：再注入被引用消息（若与根消息不同）
 */
export async function buildInboundPromptPrefix(
  channel: LarkChannel,
  msg: InboundContextMessage,
  topicId: string | undefined,
  selfAppId: string,
): Promise<string | undefined> {
  const blocks: string[] = [];
  const rootId = msg.threadId ?? topicId;

  if (rootId && rootId !== msg.replyToMessageId) {
    const root = await fetchMessageContext(channel, rootId, {
      selfAppId,
      format: formatTopicRootContext,
    });
    if (root) blocks.push(root);
  }

  if (msg.replyToMessageId) {
    const quoted = await fetchQuotedMessage(
      channel,
      msg.replyToMessageId,
      selfAppId,
    );
    if (quoted) blocks.push(quoted);
  }

  return blocks.length ? blocks.join("\n\n") : undefined;
}
