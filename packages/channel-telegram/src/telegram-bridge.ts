import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "@feishu-code-bridge/core";
import {
  RunOrchestrator,
  createFeishuStreamPresenter,
  handleSlashCommand,
} from "@feishu-code-bridge/router";
import {
  TelegramApi,
  chunkTelegramText,
  type TelegramBotCommand,
  type TelegramUpdate,
} from "./telegram-api.js";

export const TELEGRAM_BOT_COMMANDS: TelegramBotCommand[] = [
  { command: "menu", description: "打开手机快捷菜单" },
  { command: "help", description: "查看帮助；加 full 查看全部" },
  { command: "status", description: "查看当前会话状态" },
  { command: "resume", description: "列出或恢复本机会话" },
  { command: "new", description: "新建会话" },
  { command: "stop", description: "停止当前任务" },
  { command: "backend", description: "切换 Cursor、Claude 或 Codex" },
  { command: "model", description: "查看或切换模型" },
  { command: "permission", description: "查看或切换权限模式" },
  { command: "ws", description: "管理命名工作区" },
];

interface TelegramTransport {
  getMe(): Promise<{ username?: string; first_name?: string }>;
  setMyCommands?(commands: TelegramBotCommand[]): Promise<true>;
  getUpdates(
    offset: number,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]>;
  sendMessage(
    chatId: string,
    text: string,
    topicId?: string,
  ): Promise<{ message_id: number }>;
  editMessage(
    chatId: string,
    messageId: number,
    text: string,
  ): Promise<{ message_id: number }>;
  sendDocument(
    chatId: string,
    fileName: string,
    content: Uint8Array,
    topicId?: string,
  ): Promise<{ message_id: number }>;
}

export interface TelegramBridgeOptions {
  config: AppConfig;
  dataDir: string;
  onLog?: (message: string) => void;
  api?: TelegramTransport;
}

export class TelegramBridge {
  private config: AppConfig;
  private readonly orchestrator: RunOrchestrator;
  private readonly api: TelegramTransport;
  private readonly offsetPath: string;
  private pollAbort?: AbortController;
  private pollTask?: Promise<void>;
  private readonly activeReplies = new Set<Promise<void>>();
  private offset = 0;

  constructor(private readonly options: TelegramBridgeOptions) {
    const telegram = options.config.telegram;
    if (!telegram) throw new Error("Telegram 配置不存在");
    this.config = options.config;
    this.api = options.api ?? new TelegramApi({ token: telegram.botToken });
    this.orchestrator = new RunOrchestrator({
      dataDir: options.dataDir,
      config: options.config,
    });
    this.offsetPath = path.join(options.dataDir, "telegram-offset.json");
    this.offset = this.readOffset();
  }

  updateConfig(config: AppConfig): void {
    this.config = config;
    this.orchestrator.updateConfig(config);
  }

  async connect(): Promise<void> {
    const me = await this.api.getMe();
    try {
      await this.api.setMyCommands?.(TELEGRAM_BOT_COMMANDS);
    } catch (err) {
      this.options.onLog?.(
        `Telegram 原生命令菜单注册失败，继续轮询：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.options.onLog?.(`已连接 Telegram bot: ${me.username ?? me.first_name ?? "unknown"}`);
    this.pollAbort = new AbortController();
    this.pollTask = this.poll(this.pollAbort.signal);
  }

  async disconnect(): Promise<void> {
    this.pollAbort?.abort();
    await this.pollTask?.catch(() => {});
    await Promise.allSettled([...this.activeReplies]);
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const telegram = this.config.telegram;
    if (!message || !telegram) return;
    const text = (message.text ?? message.caption ?? "").trim();
    if (!text || !message.from) return;
    const senderId = String(message.from.id);
    const rawChatId = String(message.chat.id);
    if (
      telegram.allowedUsers?.length &&
      !telegram.allowedUsers.includes(senderId)
    ) return;
    if (
      telegram.allowedChats?.length &&
      !telegram.allowedChats.includes(rawChatId)
    ) return;

    const chatId = `telegram:${rawChatId}`;
    const topicId = message.message_thread_id
      ? String(message.message_thread_id)
      : undefined;
    const normalized = text.replace(/^\/([^\s@]+)@[^\s]+/, "/$1");
    const slash = await handleSlashCommand({
      chatId,
      topicId,
      senderId,
      text: normalized,
      config: this.config,
      router: this.orchestrator.router,
      listSessions: (options) =>
        this.orchestrator.listSessions(chatId, topicId, options),
      bindSession: (sessionId) =>
        this.orchestrator.bindSession(chatId, topicId, sessionId),
      closeSession: (sessionId) =>
        this.orchestrator.closeSession(chatId, topicId, sessionId),
      deleteSession: (sessionId) =>
        this.orchestrator.deleteSession(chatId, topicId, sessionId),
      listConfigOptions: () =>
        this.orchestrator.listConfigOptions(chatId, topicId),
      cancelActiveRun: () =>
        this.orchestrator.cancelActiveForChat(chatId, topicId),
      hasActiveRun: () => this.orchestrator.hasActiveRun(chatId, topicId),
      activeRunElapsedMs: () =>
        this.orchestrator.activeRunElapsedMs(chatId, topicId),
      steerActiveRun: (prompt) =>
        this.orchestrator.steerActiveForChat(chatId, topicId, prompt),
      resolvePermission: (approve) =>
        this.orchestrator.resolveActivePermission(chatId, topicId, approve),
      authorizeDirectory: (directory) =>
        this.orchestrator.authorizeDirectory(directory),
      notifyStatus: (text) => this.sendText(chatId, text, topicId),
      helpFormat: "plain",
    });

    if (slash?.type === "reply") {
      await this.sendText(chatId, slash.text, topicId);
      return;
    }
    if (slash?.type === "send_file") {
      await this.sendOutboundFile(chatId, slash.path, topicId);
      return;
    }
    if (slash?.type === "noop") return;
    const prompt = slash?.type === "agent" ? slash.prompt : normalized;
    const task = this.replyWithAgent(chatId, topicId, prompt);
    this.activeReplies.add(task);
    void task
      .finally(() => this.activeReplies.delete(task))
      .catch((err) => {
        this.options.onLog?.(
          `Telegram Agent 回复失败：${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  async sendOutboundMarkdown(
    chatId: string,
    markdown: string,
    topicId?: string,
  ): Promise<void> {
    await this.sendText(chatId, markdown, topicId);
  }

  async sendOutboundFile(
    chatId: string,
    rawPath: string,
    topicId?: string,
  ): Promise<string> {
    const filePath = fs.realpathSync(rawPath.replace(/^~(?=\/)/, process.env.HOME ?? ""));
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`不是文件：${rawPath}`);
    const fileName = path.basename(filePath);
    await this.api.sendDocument(
      chatId,
      fileName,
      fs.readFileSync(filePath),
      topicId,
    );
    return fileName;
  }

  private async poll(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const timeout = this.config.telegram?.pollingTimeoutSec ?? 25;
        const updates = await this.api.getUpdates(this.offset, timeout, signal);
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          this.writeOffset();
          void this.handleUpdate(update).catch((err) => {
            this.options.onLog?.(
              `Telegram 消息处理失败：${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      } catch (err) {
        if (signal.aborted) return;
        this.options.onLog?.(
          `Telegram 轮询失败：${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async replyWithAgent(
    chatId: string,
    topicId: string | undefined,
    prompt: string,
  ): Promise<void> {
    const pending = await this.api.sendMessage(chatId, "⏳ Agent 正在处理…", topicId);
    const showThinking =
      this.orchestrator.router.getBinding(chatId, topicId).showThinking ?? true;
    const { present } = createFeishuStreamPresenter({ showThinking });
    let output = "";
    for await (const event of this.orchestrator.runAgent(chatId, topicId, prompt)) {
      if (event.type === "permission_request") {
        await this.sendText(
          chatId,
          `🔐 Agent 请求权限：${event.title}\n回复 /approve 允许，/deny 拒绝。`,
          topicId,
        );
        continue;
      }
      const part = present(event);
      if (part) output += part.text;
    }
    const chunks = chunkTelegramText(output.trim() || "（本次无输出）");
    try {
      await this.api.editMessage(chatId, pending.message_id, chunks[0]!);
    } catch {
      await this.api.sendMessage(chatId, chunks[0]!, topicId);
    }
    for (const chunk of chunks.slice(1)) {
      await this.api.sendMessage(chatId, chunk, topicId);
    }
  }

  private async sendText(
    chatId: string,
    text: string,
    topicId?: string,
  ): Promise<void> {
    for (const chunk of chunkTelegramText(text)) {
      await this.api.sendMessage(chatId, chunk, topicId);
    }
  }

  private readOffset(): number {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.offsetPath, "utf8")) as {
        offset?: number;
      };
      return Number.isSafeInteger(parsed.offset) ? parsed.offset! : 0;
    } catch {
      return 0;
    }
  }

  private writeOffset(): void {
    fs.mkdirSync(path.dirname(this.offsetPath), { recursive: true });
    fs.writeFileSync(this.offsetPath, `${JSON.stringify({ offset: this.offset })}\n`);
  }
}
