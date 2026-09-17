import fs from "node:fs";
import path from "node:path";

/**
 * 出站发布者：本地定时任务一类的非 Agent 发送方。
 *
 * 它保证的是两件事：收件人在配置期由人写死、运行期任何发送方都改不了；
 * 以及 runner token 依旧必须带 runId，Agent 不会因为这条路径而被放行。
 *
 * 它不保证 Agent 永远拿不到该凭据：Agent 子进程与 Bridge 同一个系统用户，
 * 能读文件就能读到它。0600 只挡其他用户。真正的隔离要靠沙箱，这里没有。
 */
export interface OutboundPublisher {
  label: string;
  token: string;
  chatId: string;
  topicId?: string;
}

export const PUBLISHERS_FILE = "publisher-tokens.json";

const CHAT_ID_PATTERN = /^(oc_[A-Za-z0-9]+|telegram:-?\d+)$/;
const MIN_TOKEN_LENGTH = 24;

function invalid(file: string, index: number, reason: string): Error {
  return new Error(`${file} 第 ${index + 1} 条发布者${reason}`);
}

/**
 * 读取 <dataDir>/publisher-tokens.json。文件缺失表示没有配置发布者；
 * 文件存在但内容不合法时抛错，不把一条静默失效的凭据当成已生效。
 */
export function loadOutboundPublishers(
  dataDir: string,
  runnerToken: string,
): OutboundPublisher[] {
  const file = path.join(dataDir, PUBLISHERS_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if ((fs.statSync(file).mode & 0o077) !== 0) {
    throw new Error(`${file} 对同组或其他用户可读，请先 chmod 600`);
  }
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries)) throw new Error(`${file} 必须是发布者数组`);
  const seen = new Set<string>();
  return entries.map((value, index) => {
    const entry = (value ?? {}) as Partial<OutboundPublisher>;
    if (typeof entry.label !== "string" || !entry.label.trim()) {
      throw invalid(file, index, "缺少 label");
    }
    if (typeof entry.token !== "string" || entry.token.length < MIN_TOKEN_LENGTH) {
      throw invalid(file, index, `的 token 少于 ${MIN_TOKEN_LENGTH} 位`);
    }
    if (entry.token === runnerToken) {
      throw invalid(file, index, "不能复用 runner token，否则 Agent 也能拿到它");
    }
    if (seen.has(entry.token)) throw invalid(file, index, "的 token 与前面的重复");
    seen.add(entry.token);
    if (typeof entry.chatId !== "string" || !CHAT_ID_PATTERN.test(entry.chatId)) {
      throw invalid(file, index, "的 chatId 不是有效的通道聊天 ID");
    }
    if (entry.topicId !== undefined && typeof entry.topicId !== "string") {
      throw invalid(file, index, "的 topicId 必须是字符串");
    }
    return {
      label: entry.label,
      token: entry.token,
      chatId: entry.chatId,
      topicId: entry.topicId || undefined,
    };
  });
}
