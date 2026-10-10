import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseDocument, stringify as stringifyYaml, type Document } from "yaml";
import {
  ConfigSchema,
  SUPPORTED_AGENT_IDS,
  defaultConfig,
  keychainServiceFor,
  secretSourceOf,
  storeKeychainSecret,
  type SecretOptions,
  type SecretPath,
} from "@codebridge/core";

/** Terminal I/O the wizard needs; injected so the whole flow is testable. */
export interface WizardIo {
  print(text: string): void;
  ask(question: string, defaultValue?: string): Promise<string>;
  /** Input is not echoed. */
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
}

export interface InitSummary {
  configPath: string;
  channels: string[];
  defaultAgent?: string;
  secretStorage: Record<string, "keychain" | "plaintext" | "kept">;
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

/**
 * Interactive, non-destructive setup: fills what is missing in config.yaml, keeps every
 * other field and comment, verifies credentials against Feishu/Telegram, and stores
 * secrets in the OS keychain with keychain: refs in the file.
 */
export async function runInitWizard(options: InitWizardOptions): Promise<InitSummary> {
  const { io, dataDir } = options;
  const fetchImpl = options.fetch ?? fetch;
  const hasCommand = options.hasCommand ?? defaultHasCommand;
  const configPath = path.join(dataDir, "config.yaml");
  const existed = fs.existsSync(configPath);
  const doc: Document = parseDocument(existed ? fs.readFileSync(configPath, "utf8") : stringifyYaml(defaultConfig()));
  const summary: InitSummary = { configPath, channels: [], secretStorage: {} };

  io.print(existed ? `更新已有配置：${configPath}（只补缺失项，其余保持不变）` : `新建配置：${configPath}`);

  const storeSecret = async (secretPath: SecretPath, value: string): Promise<void> => {
    const name = secretPath.join(".");
    const service = keychainServiceFor(secretPath, dataDir);
    try {
      storeKeychainSecret(service, value, options.secrets);
      doc.setIn(secretPath, `keychain:${service}`);
      summary.secretStorage[name] = "keychain";
    } catch (error) {
      io.print(`无法写入系统钥匙串：${error instanceof Error ? error.message : String(error)}`);
      if (!(await io.confirm(`改为明文写入 config.yaml（文件权限 600）？`, false))) {
        throw new Error(`${name} 未保存，初始化中止；config.yaml 未修改`);
      }
      doc.setIn(secretPath, value);
      summary.secretStorage[name] = "plaintext";
    }
  };

  // Runner token: generated, never typed.
  if (needsValue(doc.getIn(["runner", "token"]))) {
    await storeSecret(["runner", "token"], options.newToken?.() ?? randomBytes(24).toString("hex"));
  } else {
    summary.secretStorage["runner.token"] = "kept";
  }

  // Feishu.
  const feishuConfigured = !needsValue(doc.getIn(["feishu", "appSecret"])) && doc.getIn(["feishu", "appId"]) !== "cli_placeholder";
  if (await io.confirm("启用飞书机器人？", true)) {
    summary.channels.push("feishu");
    if (!feishuConfigured || await io.confirm("飞书凭据已配置，是否重新填写？", false)) {
      await promptFeishu(doc, io, fetchImpl, storeSecret);
    } else {
      summary.secretStorage["feishu.appSecret"] = "kept";
    }
  }

  // Telegram: never without an allowlist, since an empty one lets anyone drive local agents.
  const telegramConfigured = Boolean(doc.getIn(["telegram", "botToken"]));
  if (await io.confirm("启用 Telegram 机器人？", telegramConfigured)) {
    summary.channels.push("telegram");
    if (!telegramConfigured || await io.confirm("Telegram 已配置，是否重新填写？", false)) {
      await promptTelegram(doc, io, fetchImpl, storeSecret);
    } else {
      summary.secretStorage["telegram.botToken"] = "kept";
    }
  }

  // Workspace root.
  const currentRoot = String(doc.getIn(["workspaces", "root"]) ?? path.join(os.homedir(), "Projects"));
  const root = path.resolve((await io.ask("项目根目录（Agent 默认在这里工作）", currentRoot)).replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(root)) {
    if (await io.confirm(`${root} 不存在，现在创建？`, true)) fs.mkdirSync(root, { recursive: true });
  }
  doc.setIn(["workspaces", "root"], root);

  // Default agent among installed CLIs.
  const installed = Object.entries(AGENT_COMMANDS).filter(([, commands]) => commands.some(hasCommand)).map(([id]) => id);
  io.print(`已检测到的 Agent CLI：${installed.length ? installed.join("、") : "无"}`);
  for (const [id, hint] of Object.entries(INSTALL_HINTS)) {
    if (!installed.includes(id)) io.print(`  未安装 ${id}：${hint}`);
  }
  if (installed.length) {
    const current = String(doc.getIn(["defaultAgent"]) ?? doc.getIn(["defaultBackend"]) ?? "");
    let choice = "";
    while (!installed.includes(choice)) {
      choice = (await io.ask(`默认 Agent（${installed.join(" / ")}）`, installed.includes(current) ? current : installed[0])).trim();
    }
    doc.setIn(["defaultAgent"], choice);
    if ((SUPPORTED_AGENT_IDS as readonly string[]).includes(choice)) doc.setIn(["defaultBackend"], choice);
    summary.defaultAgent = choice;
  } else {
    io.print("至少安装一个 Agent CLI 才能写代码；安装后重新运行 codebridge init 选择默认 Agent。");
  }

  // Refs are strings, so the schema validates the file exactly as written.
  ConfigSchema.parse(doc.toJS());
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, doc.toString(), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, configPath);
  return summary;
}

type StoreSecret = (secretPath: SecretPath, value: string) => Promise<void>;

async function promptFeishu(doc: Document, io: WizardIo, fetchImpl: typeof fetch, storeSecret: StoreSecret): Promise<void> {
  const domain = String(doc.getIn(["feishu", "domain"]) ?? "https://open.feishu.cn").replace(/\/$/, "");
  io.print("飞书开放平台 → 企业自建应用 → 凭证与基础信息，复制 App ID 和 App Secret。");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = String(doc.getIn(["feishu", "appId"]) ?? "");
    const appId = (await io.ask("飞书 App ID", current === "cli_placeholder" ? undefined : current)).trim();
    const appSecret = (await io.askSecret("飞书 App Secret（输入不显示）")).trim();
    if (!appId || !appSecret) {
      io.print("App ID 和 App Secret 都不能为空。");
      continue;
    }
    const problem = await verifyFeishu(fetchImpl, domain, appId, appSecret);
    if (!problem) {
      doc.setIn(["feishu", "appId"], appId);
      await storeSecret(["feishu", "appSecret"], appSecret);
      io.print("✓ 飞书凭据有效。");
      io.print("  还需在开放平台：开启机器人；开通 im:message、im:message:send_as_bot；事件订阅选长连接并添加 im.message.receive_v1。");
      return;
    }
    io.print(`✗ 飞书凭据校验失败：${problem}`);
  }
  throw new Error("飞书凭据连续 3 次校验失败，初始化中止；config.yaml 未修改");
}

async function verifyFeishu(fetchImpl: typeof fetch, domain: string, appId: string, appSecret: string): Promise<string | undefined> {
  try {
    const response = await fetchImpl(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({})) as { code?: number; msg?: string };
    return body.code === 0 ? undefined : `${body.msg ?? `HTTP ${response.status}`}（code ${body.code ?? "?"}）`;
  } catch (error) {
    return `无法连接 ${domain}：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function promptTelegram(doc: Document, io: WizardIo, fetchImpl: typeof fetch, storeSecret: StoreSecret): Promise<void> {
  io.print("在 Telegram 找 @BotFather，/newbot 后复制 bot token。");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const token = (await io.askSecret("Telegram bot token（输入不显示）")).trim();
    const bot = await telegramCall<{ username?: string }>(fetchImpl, token, "getMe");
    if (!bot.ok) {
      io.print(`✗ Telegram token 校验失败：${bot.error}`);
      continue;
    }
    io.print(`✓ 机器人 @${bot.result.username ?? "?"} 有效。`);
    const users = await promptTelegramUsers(io, fetchImpl, token);
    await storeSecret(["telegram", "botToken"], token);
    doc.setIn(["telegram", "allowedUsers"], users);
    return;
  }
  throw new Error("Telegram token 连续 3 次校验失败，初始化中止；config.yaml 未修改");
}

/** An empty allowlist lets anyone who finds the bot drive local agents, so at least one id is required. */
async function promptTelegramUsers(io: WizardIo, fetchImpl: typeof fetch, token: string): Promise<string[]> {
  if (await io.confirm("自动识别你的 Telegram 用户 ID？（需要你先给机器人发一条消息）", true)) {
    io.print("现在去 Telegram 给机器人发任意一条消息，然后回到这里按回车。");
    await io.ask("已发送？按回车继续", "");
    const updates = await telegramCall<Array<{ message?: { from?: { id?: number; username?: string } } }>>(fetchImpl, token, "getUpdates");
    const sender = updates.ok ? [...updates.result].reverse().find((update) => update.message?.from?.id)?.message?.from : undefined;
    if (sender?.id && await io.confirm(`识别到用户 ${sender.username ? `@${sender.username} ` : ""}(${sender.id})，只允许此人使用？`, true)) {
      return [String(sender.id)];
    }
    io.print(updates.ok ? "没有识别到消息，改为手动填写。" : `读取消息失败（${updates.error}），改为手动填写。`);
  }
  for (;;) {
    const ids = (await io.ask("允许使用的 Telegram 用户 ID（数字，逗号分隔；可问 @userinfobot）")).split(",").map((id) => id.trim()).filter(Boolean);
    if (ids.length && ids.every((id) => /^\d+$/.test(id))) return ids;
    io.print("至少填写一个纯数字的用户 ID；不设白名单会让任何人都能操作你的电脑。");
  }
}

async function telegramCall<T>(fetchImpl: typeof fetch, token: string, method: string): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) return { ok: false, error: "格式应为 123456:ABC…" };
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; result?: T; description?: string };
    return body.ok ? { ok: true, result: body.result as T } : { ok: false, error: body.description ?? `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Readline-backed WizardIo; askSecret mutes echo while the user types. */
export function terminalIo(): WizardIo & { close(): void } {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const ask = async (question: string, defaultValue?: string) => {
    const answer = await rl.question(`${question}${defaultValue ? ` [${defaultValue}]` : ""}: `);
    return answer.trim() || defaultValue || "";
  };
  return {
    print: (text) => process.stdout.write(`${text}\n`),
    ask,
    askSecret: async (question) => {
      process.stdout.write(`${question}: `);
      muted = true;
      try {
        return await rl.question("");
      } finally {
        muted = false;
        process.stdout.write("\n");
      }
    },
    confirm: async (question, defaultYes) => {
      const answer = (await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}: `)).trim().toLowerCase();
      return answer ? answer.startsWith("y") : defaultYes;
    },
    close: () => rl.close(),
  };
}
