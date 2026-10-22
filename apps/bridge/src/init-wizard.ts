import { verifyFeishu, telegramCall } from "./channel-credentials.js";
import { execFileSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument, stringify as stringifyYaml, type Document } from "yaml";
import {
  ConfigStore,
  SUPPORTED_AGENT_IDS,
  SECRET_PATHS,
  SECRET_ENV_VARS,
  defaultConfig,
  keychainServiceFor,
  resolveSecretRef,
  secretSourceOf,
  storeKeychainSecret,
  type SecretOptions,
  type SecretPath,
} from "@codebridge/core";

/** Terminal I/O the wizard needs; injected so the whole flow is testable. */
export interface WizardIo {
  checkCancelled(): void;
  print(text: string): void;
  ask(question: string, defaultValue?: string): Promise<string>;
  /** Input is never echoed. */
  askSecret(question: string): Promise<string>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
}

export interface InitWizardOptions {
  dataDir: string;
  io: WizardIo;
  fetch?: typeof fetch;
  secrets?: SecretOptions;
  /** Whether a command is on PATH. */
  hasCommand?: (command: string) => boolean;
  newToken?: () => string;
  newCode?: () => string;
}

export interface InitSummary {
  configPath: string;
  channels: string[];
  defaultAgent?: string;
  secretStorage: Record<string, "keychain" | "kept">;
}

/** Commands AgentSetupService probes for each agent CLI. */
const AGENT_COMMANDS: Record<string, string[]> = {
  cursor: ["cursor-agent", "agent"],
  claude: ["claude"],
  codex: ["codex"],
  opencode: ["opencode"],
};

const INSTALL_HINTS: Record<string, string> = {
  cursor: "https://cursor.com/docs/cli",
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  opencode: "npm install -g opencode-ai",
};

function needsValue(value: unknown): boolean {
  const source = secretSourceOf(value);
  return source === "missing" || source === "placeholder";
}

function defaultHasCommand(command: string): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function newRunnerToken(): string {
  return randomBytes(24).toString("hex");
}

/** Stage beside the real target so rename remains atomic and preserves config symlinks. */
function stageConfig(configPath: string, text: string): { temporary: string; target: string } {
  const target = fs.existsSync(configPath) ? fs.realpathSync(configPath) : path.resolve(configPath);
  const dataDir = path.dirname(target);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dataDir, `.config.${randomBytes(12).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    try {
      new ConfigStore({ dataDir, configFileName: path.basename(temporary), resolve: [] });
    } catch {
      // Schema errors may contain credential values; never dump them to the terminal.
      throw new Error("配置校验失败，请检查 config.yaml 和环境变量；原配置和密钥未修改");
    }
    return { temporary, target };
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** Delete only a new, wizard-owned staging item, never an existing credential. */
function removeStagedSecret(service: string, secrets: SecretOptions = {}): void {
  const run = secrets.run ?? ((file: string, args: string[]) => execFileSync(file, args, {
    encoding: "utf8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"],
  }));
  if ((secrets.platform ?? process.platform) === "darwin") {
    run("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", "codebridge"]);
  } else {
    run("secret-tool", ["clear", "service", service, "account", "codebridge"]);
  }
}

/** No TTY: require an externally supplied token; never persist a generated plaintext credential. */
export function initDefaults(dataDir: string): { written: boolean; configPath: string } {
  const configPath = path.join(dataDir, "config.yaml");
  if (fs.existsSync(configPath)) return { written: false, configPath };
  if (!process.env.RUNNER_TOKEN || process.env.RUNNER_TOKEN.length < 8) {
    throw new Error("非交互初始化需要先设置 RUNNER_TOKEN；配置只保存 env: 引用，或运行交互式 codebridge init 使用系统钥匙串");
  }
  const doc = parseDocument(stringifyYaml(defaultConfig()));
  doc.setIn(["runner", "token"], "env:RUNNER_TOKEN");
  const staged = stageConfig(configPath, doc.toString());
  try {
    // link is no-clobber even if another init creates the config after our initial check.
    fs.linkSync(staged.temporary, staged.target);
  } finally {
    fs.rmSync(staged.temporary, { force: true });
  }
  return { written: true, configPath };
}

/**
 * Interactive setup. Fills what is missing in config.yaml and keeps every other field and
 * comment; verifies credentials against Feishu/Telegram; stores secrets in the OS keychain
 * with keychain: refs in the file. Nothing (keychain or file) is written until every step
 * has finished and the result validates. New keychain items are isolated until config commit.
 */
export async function runInitWizard(options: InitWizardOptions): Promise<InitSummary> {
  const { io, dataDir } = options;
  const fetchImpl = options.fetch ?? fetch;
  const hasCommand = options.hasCommand ?? defaultHasCommand;
  const configPath = path.join(dataDir, "config.yaml");
  const existed = fs.existsSync(configPath);
  const doc: Document = parseDocument(existed ? fs.readFileSync(configPath, "utf8") : stringifyYaml(defaultConfig()));
  if (doc.errors.length) throw new Error("config.yaml 格式错误，未修改配置");
  const summary: InitSummary = { configPath, channels: [], secretStorage: {} };
  /** Secrets to store at the very end, after everything else succeeded. */
  const pending = new Map<string, { secretPath: SecretPath; value: string }>();
  const setSecret = (secretPath: SecretPath, value: string) => pending.set(secretPath.join("."), { secretPath, value });
  const resolveExisting = (value: unknown): string | undefined => {
    if (typeof value !== "string" || needsValue(value)) return undefined;
    if (!value.startsWith("keychain:") && !value.startsWith("env:")) return value;
    try {
      return resolveSecretRef(value, options.secrets);
    } catch {
      return undefined;
    }
  };

  io.print(existed ? `更新已有配置：${configPath}（保留已有设置；只修改本次确认的项目，YAML 格式可能调整）` : `新建配置：${configPath}`);

  // Runner token: generated, never typed.
  if (process.env.RUNNER_TOKEN) {
    if (needsValue(doc.getIn(["runner", "token"]))) doc.setIn(["runner", "token"], "env:RUNNER_TOKEN");
    summary.secretStorage["runner.token"] = "kept";
  } else if (needsValue(doc.getIn(["runner", "token"]))) setSecret(["runner", "token"], options.newToken?.() ?? newRunnerToken());
  else summary.secretStorage["runner.token"] = "kept";

  // Feishu.
  const feishuFromEnv = Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET);
  const feishuConfigured = feishuFromEnv || !needsValue(doc.getIn(["feishu", "appSecret"])) && doc.getIn(["feishu", "appId"]) !== "cli_placeholder";
  if (await io.confirm("启用飞书机器人？", true)) {
    if (feishuFromEnv) io.print("飞书凭据由环境变量提供；运行时环境变量优先于文件设置。");
    if (feishuConfigured && !(await io.confirm("飞书凭据已配置，是否重新填写？", false))) {
      summary.channels.push("feishu");
      summary.secretStorage["feishu.appSecret"] = "kept";
    } else {
      const feishu = await promptFeishu(doc, io, fetchImpl);
      if (feishu) {
        doc.setIn(["feishu", "appId"], feishu.appId);
        setSecret(["feishu", "appSecret"], feishu.appSecret);
        summary.channels.push("feishu");
      }
    }
    const policy = doc.getIn(["feishu", "policy", "dmMode"]);
    if (summary.channels.includes("feishu") && (policy ?? "open") === "open") {
      io.print("  注意：飞书私聊当前对租户内所有人开放（feishu.policy.dmMode: open）。只给自己用时，需在 config.yaml 同时设置 dmMode: allowlist 和 dmAllowlist。");
    }
  }

  // Telegram: never left without an allowlist, since an empty one lets anyone drive local agents.
  const telegramFromEnv = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN || doc.getIn(["telegram", "botToken"]);
  if (telegramFromEnv) io.print("Telegram 凭据由环境变量提供，本次保留该机器人；更换机器人需先更新或移除 TELEGRAM_BOT_TOKEN 再运行向导。");
  const telegramConfigured = Boolean(telegramToken);
  if (await io.confirm("启用 Telegram 机器人？", telegramConfigured)) {
    if (telegramConfigured && (telegramFromEnv || !(await io.confirm("Telegram 已配置，是否重新填写？", false)))) {
      summary.channels.push("telegram");
      summary.secretStorage["telegram.botToken"] = "kept";
      if (!hasItems(doc.getIn(["telegram", "allowedUsers"])) && !hasItems(doc.getIn(["telegram", "allowedChats"]))) {
        io.print("⚠ 现有 Telegram 配置没有白名单，任何人都能通过机器人操作这台电脑，必须补上。");
        doc.setIn(["telegram", "allowedUsers"], await promptTelegramUsers(io, fetchImpl, resolveExisting(telegramToken), options));
      }
    } else {
      const telegram = await promptTelegram(io, fetchImpl, doc, options);
      if (telegram) {
        setSecret(["telegram", "botToken"], telegram.token);
        doc.setIn(["telegram", "allowedUsers"], telegram.users);
        if (telegram.replaceChats) doc.deleteIn(["telegram", "allowedChats"]);
        summary.channels.push("telegram");
      }
    }
  }

  if (feishuConfigured && !summary.channels.includes("feishu")) {
    summary.channels.push("feishu");
    io.print("本次未修改已有飞书配置。");
  }
  if (telegramConfigured && !summary.channels.includes("telegram")) {
    summary.channels.push("telegram");
    io.print("本次未修改已有 Telegram 凭据。");
    if (!hasItems(doc.getIn(["telegram", "allowedUsers"])) && !hasItems(doc.getIn(["telegram", "allowedChats"]))) {
      io.print("现有 Telegram 仍会启用，需补上白名单。");
      doc.setIn(["telegram", "allowedUsers"], await promptTelegramUsers(io, fetchImpl, resolveExisting(telegramToken), options));
    }
  }

  // Workspace root.
  const currentRoot = String(doc.getIn(["workspaces", "root"]) ?? path.join(os.homedir(), "Projects"));
  const answerRoot = await io.ask("项目根目录（Agent 默认在这里工作）", currentRoot);
  const root = path.resolve(answerRoot.replace(/^~(?=$|\/)/, os.homedir()));
  if (answerRoot !== currentRoot || !doc.hasIn(["workspaces", "root"])) doc.setIn(["workspaces", "root"], root);
  let createRoot = false;
  if (!fs.existsSync(root)) {
    createRoot = await io.confirm(`${root} 不存在，现在创建？`, true);
    if (!createRoot) throw new Error("项目目录不存在，初始化中止；原配置和密钥未修改");
  }

  // Default agent: installed CLIs, plus the current default (e.g. pi or a custom backend).
  const installed = Object.entries(AGENT_COMMANDS).filter(([, commands]) => commands.some(hasCommand)).map(([id]) => id);
  const current = String(doc.getIn(["defaultAgent"]) ?? "") || (existed ? String(doc.getIn(["defaultBackend"]) ?? "") : "");
  const backends = doc.getIn(["backends"]) as { has?: (key: string) => boolean } | undefined;
  const currentValid = Boolean(current) && ((SUPPORTED_AGENT_IDS as readonly string[]).includes(current) || backends?.has?.(current) === true);
  const choices = [...new Set([...(currentValid ? [current] : []), ...installed])];
  io.print(`已检测到的 Agent CLI：${installed.length ? installed.join("、") : "无"}`);
  for (const [id, hint] of Object.entries(INSTALL_HINTS)) {
    if (!installed.includes(id)) io.print(`  未安装 ${id}：${hint}`);
  }
  if (choices.length) {
    let choice = "";
    while (!choices.includes(choice)) {
      choice = (await io.ask(`默认 Agent（${choices.join(" / ")}）`, choices[0])).trim();
    }
    if (choice !== current) {
      doc.setIn(["defaultAgent"], choice);
      if ((SUPPORTED_AGENT_IDS as readonly string[]).includes(choice)) doc.setIn(["defaultBackend"], choice);
    }
    summary.defaultAgent = choice;
  } else {
    io.print("至少安装一个 Agent CLI 才能写代码；安装后重新运行 codebridge init 选择默认 Agent。");
  }

  // Validate before touching credentials. Each new item has its own name, so even a
  // failed commit cannot replace a secret referenced by the live config/deployer.
  io.checkCancelled();
  for (const secretPath of SECRET_PATHS) {
    const value = doc.getIn(secretPath);
    const envName = SECRET_ENV_VARS[secretPath.join(".")];
    if (typeof value === "string" && secretSourceOf(value) === "plaintext" && envName && process.env[envName]) {
      doc.setIn(secretPath, `env:${envName}`);
    } else if (typeof value === "string" && secretSourceOf(value) === "plaintext" && !pending.has(secretPath.join("."))) setSecret(secretPath, value);
  }
  const planned = [...pending.values()].map((entry) => ({
    ...entry, service: `${keychainServiceFor(entry.secretPath, dataDir)}.init-${randomBytes(12).toString("hex")}`,
  }));
  for (const entry of planned) doc.setIn(entry.secretPath, `keychain:${entry.service}`);
  const staged = stageConfig(configPath, doc.toString());
  const stored: string[] = [];
  let committed = false;
  try {
    for (const { secretPath, value, service } of planned) {
      const name = secretPath.join(".");
      let saved = false;
      try {
        storeKeychainSecret(service, value, options.secrets);
        stored.push(service);
        saved = resolveSecretRef(`keychain:${service}`, options.secrets) === value;
      } catch { /* Fail closed without leaking helper errors or writing plaintext. */ }
      if (saved) {
        summary.secretStorage[name] = "keychain";
      } else {
        if (stored.includes(service)) {
          removeStagedSecret(service, options.secrets);
          stored.splice(stored.indexOf(service), 1);
        }
        throw new Error(`${name} 无法保存到系统钥匙串；请使用 env: 引用配置，原配置和密钥未修改`);
      }
    }
    io.checkCancelled();
    fs.writeFileSync(staged.temporary, doc.toString());
    if (createRoot) fs.mkdirSync(root, { recursive: true });
    fs.renameSync(staged.temporary, staged.target);
    committed = true;
  } finally {
    fs.rmSync(staged.temporary, { force: true });
    if (!committed) {
      const failed: string[] = [];
      for (const service of stored) {
        try { removeStagedSecret(service, options.secrets); } catch { failed.push(service); }
      }
      if (failed.length) io.print(`未能清理新建钥匙串条目：${failed.join("、")}；原配置引用的密钥未修改。`);
    }
  }
  return summary;
}

function hasItems(node: unknown): boolean {
  const items = (node as { items?: unknown[] } | undefined)?.items;
  return Array.isArray(node) ? node.length > 0 : Boolean(items?.length);
}

async function promptFeishu(doc: Document, io: WizardIo, fetchImpl: typeof fetch): Promise<{ appId: string; appSecret: string } | undefined> {
  const domain = String(process.env.FEISHU_DOMAIN ?? doc.getIn(["feishu", "domain"]) ?? "https://open.feishu.cn").replace(/\/$/, "");
  io.print("飞书开放平台 → 企业自建应用 → 凭证与基础信息，复制 App ID 和 App Secret。");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = String(doc.getIn(["feishu", "appId"]) ?? "");
    const appId = (await io.ask("飞书 App ID（输入 /skip 跳过；无默认值时回车也可跳过）", current === "cli_placeholder" ? undefined : current)).trim();
    if (!appId || appId === "/skip") {
      io.print("已跳过飞书。");
      return undefined;
    }
    const appSecret = (await io.askSecret("飞书 App Secret（输入不显示）")).trim();
    if (!appSecret) {
      io.print("已跳过飞书，本次不修改凭据。");
      return undefined;
    }
    const problem = await verifyFeishu(fetchImpl, domain, appId, appSecret);
    if (!problem) {
      io.print("✓ 飞书凭据有效。");
      io.print("  还需在开放平台：开启机器人；开通 im:message、im:message:send_as_bot；事件订阅选长连接并添加 im.message.receive_v1。");
      return { appId, appSecret };
    }
    io.print(`✗ 飞书凭据校验失败：${problem}`);
  }
  if (await io.confirm("飞书连续 3 次校验失败，跳过飞书、先完成其余配置？", true)) return undefined;
  throw new Error("飞书凭据连续 3 次校验失败，初始化中止；原配置和密钥未修改");
}


async function promptTelegram(io: WizardIo, fetchImpl: typeof fetch, doc: Document, options: InitWizardOptions): Promise<{ token: string; users: string[]; replaceChats: boolean } | undefined> {
  io.print("在 Telegram 找 @BotFather，/newbot 后复制 bot token。");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const token = (await io.askSecret("Telegram bot token（输入不显示，回车跳过 Telegram）")).trim();
    if (!token) {
      io.print("已跳过 Telegram。");
      return undefined;
    }
    const bot = await telegramCall<{ username?: string }>(fetchImpl, token, "getMe");
    if (!bot.ok) {
      io.print(`✗ Telegram token 校验失败：${bot.error}`);
      continue;
    }
    io.print(`✓ 机器人 @${bot.result.username ?? "?"} 有效。`);
    const existing = doc.getIn(["telegram", "allowedUsers"]) as { toJSON?: () => unknown } | undefined;
    const existingUsers = (existing?.toJSON?.() as string[] | undefined) ?? [];
    const chats = doc.getIn(["telegram", "allowedChats"]) as { toJSON?: () => unknown } | undefined;
    const existingChats = (chats?.toJSON?.() as string[] | undefined) ?? [];
    if ((existingUsers.length || existingChats.length) && await io.confirm(`保留现有白名单（用户：${existingUsers.join(", ") || "未限制"}；聊天：${existingChats.join(", ") || "未限制"}；选否将改用新用户白名单并清除原聊天限制）？`, true)) {
      return { token, users: existingUsers.map(String), replaceChats: false };
    }
    return { token, users: await promptTelegramUsers(io, fetchImpl, token, options), replaceChats: true };
  }
  if (await io.confirm("Telegram 连续 3 次校验失败，跳过 Telegram、先完成其余配置？", true)) return undefined;
  throw new Error("Telegram token 连续 3 次校验失败，初始化中止；原配置和密钥未修改");
}

interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; chat?: { type?: string }; from?: { id?: number; username?: string; is_bot?: boolean } };
}

/**
 * At least one user id is required. Auto-detection binds to a one-time code the user sends
 * in a private chat, so a stranger messaging the public bot can never be picked.
 */
async function promptTelegramUsers(io: WizardIo, fetchImpl: typeof fetch, token: string | undefined, options: InitWizardOptions): Promise<string[]> {
  if (token && await io.confirm("自动识别你的 Telegram 用户 ID？（需要私聊机器人发一个验证码）", true)) {
    const code = options.newCode?.() ?? `cb-${randomBytes(8).toString("hex")}`;
    io.print(`在 Telegram 私聊你的机器人，发送这段验证码：${code}`);
    await io.ask("发送后按回车继续", "");
    let offset: number | undefined;
    let match: TelegramUpdate | undefined;
    for (let page = 0; page < 10 && !match; page++) {
      const updates = await telegramCall<TelegramUpdate[]>(fetchImpl, token, `getUpdates${offset === undefined ? "" : `?offset=${offset}`}`);
      if (!updates.ok) {
        io.print(`读取消息失败（${updates.error}），改为手动填写。`);
        break;
      }
      match = updates.result.find((update) => update.message?.text?.trim() === code
        && update.message.chat?.type === "private" && update.message.from?.is_bot === false && update.message.from?.id);
      if (match || updates.result.length < 100) break;
      offset = updates.result.at(-1)!.update_id + 1;
    }
    if (match) {
      // Acknowledge, so the code is not delivered to the bridge as a prompt on first start.
      const acknowledged = await telegramCall(fetchImpl, token, `getUpdates?offset=${match.update_id + 1}&limit=1`);
      if (!acknowledged.ok) throw new Error("Telegram 验证码消息未能确认，初始化中止以免它被当作任务执行；原配置和密钥未修改");
      const from = match.message!.from!;
      if (await io.confirm(`验证码来自 ${from.username ? `@${from.username} ` : ""}(${from.id})，只允许此人使用？`, false)) {
        return [String(from.id)];
      }
    } else {
      io.print("没有收到这段验证码的私聊消息，改为手动填写。");
    }
  }
  for (;;) {
    const ids = (await io.ask("允许使用的 Telegram 用户 ID（数字，逗号分隔；可问 @userinfobot）")).split(",").map((id) => id.trim()).filter(Boolean);
    if (ids.length && ids.every((id) => /^\d+$/.test(id))) return ids;
    io.print("至少填写一个纯数字的用户 ID；不设白名单会让任何人都能操作你的电脑。");
  }
}


export interface LineState {
  buffer: string;
  escape?: string;
  done: boolean;
  cancelled: boolean;
  echo: string;
}

/** No history; discard pasted lines after Enter, including fragmented escape sequences. */
export function applyLineInput(state: Pick<LineState, "buffer" | "escape">, chunk: string, secret: boolean): LineState {
  let buffer = state.buffer;
  let escape = state.escape ?? "";
  let echo = "";
  for (const ch of chunk) {
    if (escape) {
      escape += ch;
      if (escape.length === 2 && (ch === "[" || ch === "O")) continue;
      if (escape.length === 2 || /[@-~]/.test(ch)) escape = "";
      continue;
    }
    if (ch === "\x1b") { escape = ch; continue; }
    if (ch === "\r" || ch === "\n") return { buffer, done: true, cancelled: false, echo };
    if (ch === "\u0003" || (ch === "\u0004" && !buffer)) return { buffer: "", done: true, cancelled: true, echo };
    if (ch === "\u007f" || ch === "\b") {
      if (buffer) {
        buffer = [...buffer].slice(0, -1).join("");
        if (!secret) echo += "\b \b";
      }
      continue;
    }
    if (ch < " ") continue;
    buffer += ch;
    if (!secret) echo += ch;
  }
  return { buffer, escape, done: false, cancelled: false, echo };
}

/** Keep raw mode until close so type-ahead during network calls is never echoed. */
export function terminalIo(): WizardIo & { close(): void } {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  let decoder = new StringDecoder("utf8");
  let active: { secret: boolean; state: Pick<LineState, "buffer" | "escape">; resolve(value: string): void; reject(error: Error): void } | undefined;
  let cancelled = false;
  let pasting = false;
  let discardPaste = false;
  let marker = "";
  const consume = (text: string) => {
    if (text.includes("\u0003")) {
      cancelled = true;
      active?.reject(new Error("已取消初始化"));
      active = undefined;
      return;
    }
    if (discardPaste) return;
    if (!active) {
      if (text.includes("\u0003") || text.includes("\u0004")) cancelled = true;
      return;
    }
    const next = applyLineInput(active.state, text, active.secret);
    if (next.echo) process.stdout.write(next.echo);
    active.state = next;
    if (!next.done) return;
    const pending = active;
    active = undefined;
    if (pasting) discardPaste = true;
    process.stdout.write("\n");
    if (next.cancelled) { cancelled = true; pending.reject(new Error("已取消初始化")); }
    else pending.resolve(next.buffer);
  };
  const onData = (chunk: Buffer) => {
    for (const ch of decoder.write(chunk)) {
      if (marker || ch === "\x1b") {
        marker += ch;
        if (marker === "\x1b[200~") { pasting = true; marker = ""; continue; }
        if (marker === "\x1b[201~") { pasting = false; discardPaste = false; marker = ""; continue; }
        if ("\x1b[200~".startsWith(marker) || "\x1b[201~".startsWith(marker)) continue;
        consume(marker);
        marker = "";
      } else consume(ch);
    }
  };
  const onEnd = () => {
    cancelled = true;
    active?.reject(new Error("终端输入已关闭，初始化中止"));
    active = undefined;
  };
  stdin.setRawMode(true);
  process.stdout.write("\x1b[?2004h");
  stdin.on("data", onData);
  stdin.on("end", onEnd);
  stdin.resume();
  const readLine = (prompt: string, secret: boolean) => new Promise<string>((resolve, reject) => {
    if (cancelled) { reject(new Error("已取消初始化")); return; }
    decoder = new StringDecoder("utf8");
    active = { secret, state: { buffer: "" }, resolve, reject };
    process.stdout.write(prompt);
  });
  return {
    checkCancelled: () => { if (cancelled) throw new Error("已取消初始化"); },
    print: (text) => process.stdout.write(`${text}\n`),
    ask: async (question, defaultValue) => {
      const answer = (await readLine(`${question}${defaultValue ? ` [${defaultValue}]` : ""}: `, false)).trim();
      return answer || defaultValue || "";
    },
    askSecret: (question) => readLine(`${question}: `, true),
    confirm: async (question, defaultYes) => {
      const answer = (await readLine(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}: `, false)).trim().toLowerCase();
      return answer ? answer.startsWith("y") : defaultYes;
    },
    close: () => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      process.stdout.write("\x1b[?2004l");
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    },
  };
}
