import type { LarkChannel } from "@larksuiteoapi/node-sdk";

/** 引用内容注入 prompt 的长度上限，防止长消息撑爆上下文 */
export const QUOTE_MAX_CHARS = 2000;

interface QuotedMention {
  key: string;
  name: string;
}

/**
 * 从飞书消息体提取纯文本。text/post 按结构解析并还原 @ 提及；
 * 其他类型（卡片等）递归收集 text 字段，尽力而为。
 */
export function extractMessageText(
  msgType: string | undefined,
  rawContent: string,
  mentions?: QuotedMention[],
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return rawContent;
  }

  let text: string;
  if (msgType === "text") {
    text = String((parsed as { text?: unknown }).text ?? "");
  } else if (msgType === "post") {
    text = extractPostText(parsed);
  } else if (msgType === "image") {
    return "[图片]";
  } else {
    const collected = collectTextFields(parsed);
    text = collected || `[${msgType ?? "未知类型"} 消息]`;
  }

  for (const m of mentions ?? []) {
    text = text.split(m.key).join(`@${m.name}`);
  }
  return text.trim();
}

/** post 消息：{title, content: [[{tag, text|href|user_name}]]} 逐行拼接 */
function extractPostText(parsed: unknown): string {
  const post = parsed as {
    title?: string;
    content?: Array<Array<{ tag?: string; text?: string; user_name?: string }>>;
  };
  const lines: string[] = [];
  if (post.title) lines.push(post.title);
  for (const line of post.content ?? []) {
    const parts = line.map((el) =>
      el.tag === "at" ? `@${el.user_name ?? ""}` : (el.text ?? ""),
    );
    lines.push(parts.join(""));
  }
  return lines.join("\n");
}

/** 兜底：递归收集对象里的 text/content 字符串字段（卡片消息等） */
function collectTextFields(value: unknown, depth = 0): string {
  if (depth > 8) return "";
  if (typeof value === "string") return "";
  if (Array.isArray(value)) {
    return value
      .map((v) => collectTextFields(v, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object" && value !== null) {
    const out: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if ((k === "text" || k === "content") && typeof v === "string") {
        out.push(v);
      } else {
        const nested = collectTextFields(v, depth + 1);
        if (nested) out.push(nested);
      }
    }
    return out.join("\n");
  }
  return "";
}

export function formatQuotedContext(
  text: string,
  senderName?: string,
): string {
  const truncated =
    text.length > QUOTE_MAX_CHARS
      ? `${text.slice(0, QUOTE_MAX_CHARS)}\n…（引用内容已截断）`
      : text;
  const header = senderName
    ? `【用户引用的消息｜发送者：${senderName}】`
    : "【用户引用的消息】";
  return `${header}\n${truncated}\n【引用消息结束】`;
}

export function formatTopicRootContext(
  text: string,
  senderName?: string,
): string {
  const truncated =
    text.length > QUOTE_MAX_CHARS
      ? `${text.slice(0, QUOTE_MAX_CHARS)}\n…（话题根消息已截断）`
      : text;
  const header = senderName
    ? `【话题根消息｜发送者：${senderName}】`
    : "【话题根消息】";
  return `${header}\n${truncated}\n【话题根消息结束】`;
}

/**
 * 拉取指定消息并格式化为 prompt 上下文块。
 * skipSelfApp：跳过本 bot 自己发的消息（会话里已有）
 */
export async function fetchMessageContext(
  channel: LarkChannel,
  messageId: string,
  options: {
    selfAppId?: string;
    skipSelfApp?: boolean;
    format: (text: string, senderName?: string) => string;
  },
): Promise<string | undefined> {
  const res = await channel.rawClient.im.v1.message.get({
    path: { message_id: messageId },
  });
  const item = res.data?.items?.[0];
  if (!item?.body?.content) return undefined;
  if (
    options.skipSelfApp !== false &&
    options.selfAppId &&
    item.sender?.sender_type === "app" &&
    item.sender.id === options.selfAppId
  ) {
    return undefined;
  }
  const text = extractMessageText(
    item.msg_type,
    item.body.content,
    item.mentions?.map((m) => ({ key: m.key, name: m.name })),
  );
  if (!text) return undefined;
  return options.format(text, item.sender?.sender_name);
}

export async function fetchQuotedMessage(
  channel: LarkChannel,
  messageId: string,
  selfAppId?: string,
): Promise<string | undefined> {
  return fetchMessageContext(channel, messageId, {
    selfAppId,
    format: formatQuotedContext,
  });
}
