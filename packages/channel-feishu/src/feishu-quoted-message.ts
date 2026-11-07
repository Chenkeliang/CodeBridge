import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { RunAttachment } from "@codebridge/core";
import { downloadInboundAttachments, downloadMessageResource, sniffImageMime } from "./feishu-inbound-media.js";

function quotedImageKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if ((key === "image_key" || key === "img_key") && typeof child === "string" && child) keys.add(child);
      else if (child && typeof child === "object") quotedImageKeys(child, keys);
    }
  }
  return keys;
}

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
  if (parsed && typeof parsed === "object" && !("content" in parsed)) {
    const localized = Object.values(parsed).find((value) =>
      value && typeof value === "object" && "content" in value,
    );
    if (localized) parsed = localized;
  }
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

/** 兜底：递归收集对象里的 title/text/content 字符串字段（卡片消息等） */
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
      if (
        (k === "title" || k === "text" || k === "content") &&
        typeof v === "string"
      ) {
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
    preserveLongText?: (text: string, messageId: string) => string;
    addImage?: (attachment: RunAttachment) => void;
    resolveOwnText?: (messageId: string) => Promise<string | undefined>;
    format: (text: string, senderName?: string) => string;
  },
): Promise<string | undefined> {
  const res = await channel.rawClient.im.v1.message.get({
    path: { message_id: messageId },
    params: { card_msg_content_type: "user_card_content" },
  });
  if (res.code !== undefined && res.code !== 0) throw new Error("message_fetch_failed");
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
  const items = res.data?.items ?? [];
  const visited = new Set<string>();
  const render = async (current: NonNullable<typeof item>, currentId: string): Promise<string> => {
    if (visited.has(currentId)) return "[重复转发子消息未重复读取]";
    visited.add(currentId);
    if (current.msg_type === "merge_forward") {
      const children = items.filter(child => child.upper_message_id === currentId)
        .sort((left, right) => Number(left.create_time ?? 0) - Number(right.create_time ?? 0));
      if (!children.length) return "[合并转发子消息未读取成功，请勿猜测其内容]";
      const parts: string[] = [];
      for (const child of children) {
        const sender = child.sender?.sender_name ?? child.sender?.id ?? "未知发送者";
        try {
          const body = child.message_id ? await render(child, child.message_id) : "[子消息缺少ID，未读取]";
          parts.push(`【转发子消息｜发送方：${sender}】\n${body}`);
        } catch {
          parts.push(`【转发子消息｜发送方：${sender}】\n[该子消息未读取成功，请勿猜测其内容]`);
        }
      }
      return parts.join("\n\n");
    }
    if (!current.body?.content) return "[消息正文未取得]";
    let text = extractMessageText(current.msg_type, current.body.content,
      current.mentions?.map(mention => ({ key: mention.key, name: mention.name })));
    const placeholder = current.msg_type === "interactive" && text.includes("请升级至最新版本客户端");
    if (placeholder) {
      const ownText = current.sender?.sender_type === "app" && current.sender.id === options.selfAppId
        ? await options.resolveOwnText?.(currentId) : undefined;
      if (!ownText) throw new Error("interactive_card_content_unavailable");
      text = ownText;
    }
    if (current.msg_type === "file") {
      const file = JSON.parse(current.body.content) as { file_name?: string; file_key?: string };
      text = `[文件：${file.file_name ?? "未命名文件"}]`;
      if (!options.addImage || !file.file_key) return text + "\n[引用文件内容未取得：缺少附件入口或资源标识]";
      // Forwarded resource keys belong to the receiving container, not the origin child ID.
      const downloaded = await downloadInboundAttachments(channel, messageId,
        [{ type: "file", fileKey: file.file_key, fileName: file.file_name }], 10_000_000);
      for (const attachment of downloaded.attachments) {
        try {
          options.addImage(attachment);
          text += `\n[引用文件附件：${attachment.name}；请读取文件后再判断]`;
        } catch { text += "\n[引用文件内容未传递：附件数量或大小限制]"; }
      }
      for (const reason of downloaded.skipped) text += `\n[引用文件内容未取得：${reason}；请单独发送或转发原文件，不能仅凭文件名核验内容]`;
      return text;
    }
    let keys = new Set<string>();
    if (!placeholder) {
      try { keys = quotedImageKeys(JSON.parse(current.body.content)); } catch { /* Plain text has no image keys. */ }
    }
    let index = 0;
    for (const key of keys) {
      index++;
      if (!options.addImage || index > 10) {
        text += "\n[引用图片未传递：附件数量或通道限制，请勿猜测图片内容]";
        break;
      }
      try {
        const data = await downloadMessageResource(channel, messageId, key, "image", 10_000_000);
        const mimeType = sniffImageMime(data);
        if (!mimeType.startsWith("image/")) throw new Error("invalid_image");
        const name = `quoted-${currentId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${index}.${mimeType.split("/")[1]}`;
        options.addImage({ name, mimeType, dataBase64: data.toString("base64") });
        text += `\n[引用图片附件：${name}；请读取原图，若模型不支持视觉请明确说明]`;
      } catch { text += `\n[引用图片 ${index} 未读取成功，请勿猜测图片内容]`; }
    }
    return text;
  };
  const text = await render(item, messageId);
  if (!text) return undefined;
  const fullText = text.length > QUOTE_MAX_CHARS
    ? options.preserveLongText?.(text, messageId)
    : undefined;
  return `${options.format(text, item.sender?.sender_name)}\n引用消息 ID：${messageId}`
    + (fullText ? `\n完整内容见附件：${fullText}；处理代码或参数前请先读取全文。` : "");
}

export async function fetchQuotedMessage(
  channel: LarkChannel,
  messageId: string,
  selfAppId?: string,
  preserveLongText?: (text: string, messageId: string) => string,
  addImage?: (attachment: RunAttachment) => void,
  resolveOwnText?: (messageId: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  return fetchMessageContext(channel, messageId, {
    selfAppId,
    skipSelfApp: false,
    preserveLongText,
    addImage,
    resolveOwnText,
    format: formatQuotedContext,
  });
}
