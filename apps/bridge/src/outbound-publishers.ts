import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 出站路由名，与 /outbound/<name> 一一对应。 */
export const OUTBOUND_ROUTES = ["file", "markdown", "mention"] as const;
export type OutboundRoute = (typeof OUTBOUND_ROUTES)[number];

/** 省略 routes 时的最小授权：能说话，不能外发文件。 */
export const DEFAULT_ROUTES: OutboundRoute[] = ["markdown", "mention"];

/**
 * 出站发布者：本地定时任务一类的非 Agent 发送方。
 *
 * 它保证的是三件事：收件人在配置期由人写死、运行期任何发送方都改不了；
 * 每条凭据只能用它被授权的那几个路由；以及 runner token 依旧必须带 runId，
 * Agent 不会因为这条路径而被放行。
 *
 * 它不保证 Agent 永远拿不到该凭据：Agent 子进程与 Bridge 同一个系统用户，
 * 能读文件就能读到它。0600 只挡其他用户。真正的隔离要靠沙箱，这里没有。
 */
export interface OutboundPublisher {
  label: string;
  token: string;
  chatId: string;
  topicId?: string;
  routes: OutboundRoute[];
}

export const PUBLISHERS_FILE = "publisher-tokens.json";

const CHAT_ID_PATTERN = /^(oc_[A-Za-z0-9]+|telegram:-?\d+)$/;
const MIN_TOKEN_LENGTH = 24;

export function publishersPath(dataDir: string): string {
  return path.join(dataDir, PUBLISHERS_FILE);
}

function invalid(file: string, index: number, reason: string): Error {
  return new Error(`${file} 第 ${index + 1} 条发布者${reason}`);
}

function parseRoutes(file: string, index: number, value: unknown): OutboundRoute[] {
  if (value === undefined) return [...DEFAULT_ROUTES];
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(file, index, "的 routes 必须是非空数组");
  }
  for (const route of value) {
    if (!OUTBOUND_ROUTES.includes(route as OutboundRoute)) {
      throw invalid(file, index, `的 routes 含未知路由 ${JSON.stringify(route)}`);
    }
  }
  return [...new Set(value as OutboundRoute[])];
}

/**
 * 读取 <dataDir>/publisher-tokens.json。文件缺失表示没有配置发布者；
 * 文件存在但内容不合法时抛错，不把一条静默失效的凭据当成已生效。
 */
export function loadOutboundPublishers(
  dataDir: string,
  runnerToken: string,
): OutboundPublisher[] {
  const file = publishersPath(dataDir);
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
      routes: parseRoutes(file, index, entry.routes),
    };
  });
}

const LOCK_STALE_MS = 60_000;

/** 等锁多久放弃；测试用环境变量调短，生产不设置即 5 秒。 */
function lockTimeoutMs(): number {
  return Number(process.env.CODEBRIDGE_PUBLISHER_LOCK_TIMEOUT_MS ?? 5_000);
}

/**
 * 串行化"读全量→改→整份写回"，否则两个并发的 add 会互相吞掉对方新签的凭据。
 * 锁文件带时间戳，进程崩溃留下的陈旧锁到点自动接管，不会把后续签发永久卡死。
 */
function withPublisherLock<T>(dataDir: string, action: () => T): T {
  const lock = `${publishersPath(dataDir)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + lockTimeoutMs();
  let handle: number | undefined;
  while (handle === undefined) {
    try {
      handle = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`${lock} 正被另一个进程占用，请稍后重试`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return action();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lock, { force: true });
  }
}

function writePublishers(dataDir: string, entries: OutboundPublisher[]): void {
  const file = publishersPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // 每个写入者用自己的临时名，免得并发写互相踩，也免得崩溃残留被下一个写入者接手。
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const payload = entries.map((entry) => ({
    label: entry.label,
    token: entry.token,
    chatId: entry.chatId,
    ...(entry.topicId ? { topicId: entry.topicId } : {}),
    routes: entry.routes,
  }));
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

/** 签发一条新凭据；同名 label 视为轮换，旧 token 立即作废。 */
export function addPublisher(
  dataDir: string,
  runnerToken: string,
  entry: { label: string; chatId: string; topicId?: string; routes?: OutboundRoute[] },
): OutboundPublisher {
  if (!entry.label.trim()) throw new Error("label 不能为空");
  if (!CHAT_ID_PATTERN.test(entry.chatId)) throw new Error("chatId 不是有效的通道聊天 ID");
  for (const route of entry.routes ?? []) {
    if (!OUTBOUND_ROUTES.includes(route)) throw new Error(`未知路由 ${route}`);
  }
  const issued: OutboundPublisher = {
    label: entry.label,
    token: crypto.randomBytes(24).toString("hex"),
    chatId: entry.chatId,
    topicId: entry.topicId || undefined,
    routes: entry.routes?.length ? [...new Set(entry.routes)] : [...DEFAULT_ROUTES],
  };
  withPublisherLock(dataDir, () => {
    const kept = loadOutboundPublishers(dataDir, runnerToken).filter((row) => row.label !== entry.label);
    writePublishers(dataDir, [...kept, issued]);
  });
  return issued;
}

/** 列出已登记的发布者，永不返回 token 本身。 */
export function listPublishers(
  dataDir: string,
  runnerToken: string,
): Array<Omit<OutboundPublisher, "token">> {
  return loadOutboundPublishers(dataDir, runnerToken).map(({ token: _token, ...rest }) => rest);
}

/** 吊销一条凭据；返回是否真的删掉了。 */
export function revokePublisher(dataDir: string, runnerToken: string, label: string): boolean {
  return withPublisherLock(dataDir, () => {
    const entries = loadOutboundPublishers(dataDir, runnerToken);
    const kept = entries.filter((row) => row.label !== label);
    if (kept.length === entries.length) return false;
    writePublishers(dataDir, kept);
    return true;
  });
}

/**
 * 按文件指纹热加载：签发或吊销后无需重启 Bridge，下一次请求即生效。
 * 文件读坏时保留上一份可用凭据并上报一次，避免一个笔误就让投递全断。
 */
export class OutboundPublisherStore {
  private cache: OutboundPublisher[] = [];
  private fingerprint: string | undefined;

  constructor(
    private readonly dataDir: string,
    private readonly runnerToken: string,
    private readonly onError: (error: Error) => void = () => {},
  ) {}

  current(): OutboundPublisher[] {
    let fingerprint = "";
    try {
      const stats = fs.statSync(publishersPath(this.dataDir));
      fingerprint = `${stats.mtimeMs}:${stats.size}:${stats.ino}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        fingerprint = `unreadable:${String((error as NodeJS.ErrnoException).code)}`;
      }
    }
    if (fingerprint === this.fingerprint) return this.cache;
    this.fingerprint = fingerprint;
    try {
      this.cache = loadOutboundPublishers(this.dataDir, this.runnerToken);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
    return this.cache;
  }
}
