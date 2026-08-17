import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  MentionRegistry,
  formatMentionGuidance,
  type AppConfig,
  type ChannelSessionIngress,
  type ChannelSlot,
} from "@codebridge/core";
import {
  RunOrchestrator,
  createFeishuStreamPresenter,
  handleSlashCommand,
} from "@codebridge/router";
import {
  TelegramApi,
  chunkTelegramText,
  type TelegramBotCommand,
  type TelegramMessageEntity,
  type TelegramUpdate,
} from "./telegram-api.js";
import { TelegramSessionWatcher } from "./telegram-session-watcher.js";

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
    entities?: TelegramMessageEntity[],
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
  sessionIngress?: ChannelSessionIngress;
}

export class TelegramBridge {
  private config: AppConfig;
  private readonly orchestrator: RunOrchestrator;
  private readonly api: TelegramTransport;
  private readonly offsetPath: string;
  private pollAbort?: AbortController;
  private pollTask?: Promise<void>;
  private readonly activeReplies = new Set<Promise<void>>();
  private readonly mentionRegistry = new MentionRegistry();
  private readonly sessionWatchers = new Map<string, TelegramSessionWatcher>();
  private readonly instanceId = randomUUID();
  private offset = 0;
  private sessionIngress?: ChannelSessionIngress;

  constructor(private readonly options: TelegramBridgeOptions) {
    const telegram = options.config.telegram;
    if (!telegram) throw new Error("Telegram 配置不存在");
    this.config = options.config;
    this.sessionIngress = options.sessionIngress;
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

  setSessionIngress(ingress: ChannelSessionIngress): void {
    this.sessionIngress = ingress;
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
    await this.recoverDeliveries();
    this.pollAbort = new AbortController();
    this.pollTask = this.poll(this.pollAbort.signal);
  }

  async disconnect(): Promise<void> {
    this.pollAbort?.abort();
    await this.pollTask?.catch(() => {});
    for (const watcher of this.sessionWatchers.values()) watcher.abort();
    this.sessionWatchers.clear();
    await Promise.allSettled([...this.activeReplies]);
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const telegram = this.config.telegram;
    if (!message || !telegram) return;
    const rawText = message.text ?? message.caption ?? "";
    const text = rawText.trim();
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
    const mentionScope = { chatId, topicId };
    const requester = this.mentionRegistry.register(mentionScope, {
      channel: "telegram",
      kind: message.from.is_bot ? "bot" : "user",
      id: senderId,
      name:
        message.from.first_name ??
        (message.from.username ? `@${message.from.username}` : "当前发送者"),
      username: message.from.username,
    });
    const mentionTargets = [requester];
    const entities = message.text
      ? message.entities
      : message.caption_entities;
    for (const entity of entities ?? []) {
      if (entity.type === "text_mention" && entity.user) {
        const registered = this.mentionRegistry.register(mentionScope, {
          channel: "telegram",
          kind: entity.user.is_bot ? "bot" : "user",
          id: String(entity.user.id),
          name:
            entity.user.first_name ??
            (entity.user.username ? `@${entity.user.username}` : undefined),
          username: entity.user.username,
        });
        if (!mentionTargets.some((target) => target.ref === registered.ref)) {
          mentionTargets.push(registered);
        }
      } else if (entity.type === "mention") {
        const username = rawText
          .slice(entity.offset, entity.offset + entity.length)
          .replace(/^@/, "");
        if (username) {
          const registered = this.mentionRegistry.register(mentionScope, {
            channel: "telegram",
            kind: "user",
            id: `username:${username.toLowerCase()}`,
            name: `@${username}`,
            username,
          });
          if (!mentionTargets.some((target) => target.ref === registered.ref)) {
            mentionTargets.push(registered);
          }
        }
      }
    }
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
      resetSession: async () => {
        if (this.sessionIngress) {
          await this.sessionIngress.resetSlot(
            this.buildFullSlot(chatId, topicId),
          );
        }
      },
      closeSession: (sessionId) =>
        this.orchestrator.closeSession(chatId, topicId, sessionId),
      deleteSession: (sessionId) =>
        this.orchestrator.deleteSession(chatId, topicId, sessionId),
      listConfigOptions: () =>
        this.orchestrator.listConfigOptions(chatId, topicId),
      cancelActiveRun: async () => {
        if (!this.sessionIngress) {
          return this.orchestrator.cancelActiveForChat(chatId, topicId);
        }
        const ctx = await this.sessionIngress.getSlotCommandContext(
          this.buildFullSlot(chatId, topicId),
        );
        if (!ctx.activeRunId) return false;
        return this.sessionIngress.cancelRun(ctx.sessionId, ctx.activeRunId);
      },
      hasActiveRun: () => this.orchestrator.hasActiveRun(chatId, topicId),
      activeRunElapsedMs: () =>
        this.orchestrator.activeRunElapsedMs(chatId, topicId),
      activeRunStatus: () =>
        this.orchestrator.activeRunStatus(chatId, topicId),
      steerActiveRun: (prompt) =>
        this.orchestrator.steerActiveForChat(chatId, topicId, prompt),
      resolvePermission: async (approve) => {
        if (!this.sessionIngress) {
          return this.orchestrator.resolveActivePermission(
            chatId,
            topicId,
            approve,
          );
        }
        const ctx = await this.sessionIngress.getSlotCommandContext(
          this.buildFullSlot(chatId, topicId),
        );
        if (!ctx.activeRunId || !ctx.approvalId) return false;
        return this.sessionIngress.resolveApprovalForRun(
          {
            sessionId: ctx.sessionId,
            runId: ctx.activeRunId,
            approvalId: ctx.approvalId,
          },
          approve,
        );
      },
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
    const mentionGuidance = formatMentionGuidance(
      mentionTargets,
      requester.ref,
    );
    const task = this.submitAndStream(
      chatId,
      topicId,
      `${prompt}\n\n${mentionGuidance}`,
    );
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

  async sendOutboundMention(
    chatId: string,
    ref: string,
    text: string,
    topicId?: string,
  ): Promise<void> {
    const target = this.mentionRegistry.resolve({ chatId, topicId }, ref);
    if (!target || target.channel !== "telegram") {
      throw new Error(`当前对话不存在可通知对象：${ref}`);
    }

    let label: string;
    let entity: TelegramMessageEntity;
    if (target.username) {
      label = `@${target.username.replace(/^@/, "")}`;
      entity = { type: "mention", offset: 0, length: label.length };
    } else {
      const id = Number(target.id);
      if (!Number.isSafeInteger(id)) {
        throw new Error(`Telegram 用户 ID 无效：${target.id}`);
      }
      label = target.name ?? "用户";
      entity = {
        type: "text_mention",
        offset: 0,
        length: label.length,
        user: {
          id,
          is_bot: target.kind === "bot",
          first_name: label,
        },
      };
    }
    await this.api.sendMessage(
      chatId,
      `${label} ${text}`,
      topicId,
      [entity],
    );
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

  private buildFullSlot(chatId: string, topicId?: string): ChannelSlot {
    const slot = this.orchestrator.router.buildSlot(chatId, topicId);
    return {
      channel: "telegram",
      conversationId: `${chatId}|${topicId ?? ""}`,
      agentId: slot.agentId,
      workspaceKey: slot.workspaceKey,
      generation: slot.generation,
    };
  }

  private ensureSessionWatcher(sessionId: string): TelegramSessionWatcher {
    const existing = this.sessionWatchers.get(sessionId);
    if (existing) return existing;
    const watcher = new TelegramSessionWatcher(
      this.api,
      this.sessionIngress!,
      sessionId,
      this.instanceId,
      (message) => this.options.onLog?.(message),
    );
    this.sessionWatchers.set(sessionId, watcher);
    return watcher;
  }

  private async recoverDeliveries(): Promise<void> {
    if (!this.sessionIngress) return;
    try {
      const deliveries = await this.sessionIngress.listDeliveries("telegram");
      const bySession = new Map<string, typeof deliveries>();
      for (const delivery of deliveries) {
        const list = bySession.get(delivery.sessionId) ?? [];
        list.push(delivery);
        bySession.set(delivery.sessionId, list);
      }
      for (const [sessionId, list] of bySession) {
        const watcher = this.ensureSessionWatcher(sessionId);
        const minAccepted = Math.min(
          ...list.map((delivery) => delivery.acceptedSequence),
        );
        for (const delivery of list) {
          const [chatId, rawTopic] = delivery.conversationId.split("|");
          const topicId = rawTopic && rawTopic.length > 0
            ? rawTopic
            : undefined;
          const turn = {
            turnId: delivery.turnId,
            chatId,
            topicId,
            showThinking: true,
          };
          if (delivery.runId && delivery.surfaceMessageId === null) {
            await watcher.openRun(delivery.runId, turn);
          } else if (delivery.runId) {
            watcher.resumeRun(
              delivery.runId,
              delivery.surfaceMessageId ?? "",
              delivery.turnId,
              delivery.claimOwner ?? "",
              true,
              chatId,
              topicId,
            );
          } else {
            watcher.registerPendingTurn(delivery.turnId, turn);
          }
        }
        watcher.start(minAccepted);
      }
    } catch (err) {
      this.options.onLog?.(
        `delivery 恢复失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async submitAndStream(
    chatId: string,
    topicId: string | undefined,
    prompt: string,
  ): Promise<void> {
    if (!this.sessionIngress) {
      await this.runLegacyAgent(chatId, topicId, prompt);
      return;
    }
    const binding = this.orchestrator.router.getBinding(chatId, topicId);
    const slot = this.orchestrator.router.buildSlot(chatId, topicId);
    const receipt = await this.sessionIngress.submit({
      channel: "telegram",
      conversationId: `${chatId}|${topicId ?? ""}`,
      agentId: binding.backendId,
      cwd: binding.cwd,
      generation: slot.generation,
      message: prompt,
      model: binding.model,
    });
    const turn = {
      turnId: receipt.turnId,
      chatId,
      topicId,
      showThinking: binding.showThinking ?? true,
    };
    const watcher = this.ensureSessionWatcher(receipt.sessionId);
    if (receipt.acceptance === "queued") {
      await this.sendText(
        chatId,
        receipt.queueState === "paused"
          ? "⏸ 当前 Session 已暂停，消息已排队。发送 /continue 恢复队列，或 /new 新建会话。"
          : `⏳ 当前任务进行中，消息已排队（turn ${receipt.turnId.slice(0, 8)}）。`,
        topicId,
      );
      watcher.registerPendingTurn(receipt.turnId, turn);
      watcher.start(receipt.eventSequence);
      return;
    }
    if (!receipt.runId) {
      throw new Error(
        `dispatched receipt missing run_id for turn ${receipt.turnId}`,
      );
    }
    await watcher.openRun(receipt.runId, turn);
    watcher.start(receipt.eventSequence);
  }

  private async runLegacyAgent(
    chatId: string,
    topicId: string | undefined,
    prompt: string,
  ): Promise<void> {
    const pending = await this.api.sendMessage(chatId, "⏳ Agent 正在处理…", topicId);
    const showThinking =
      this.orchestrator.router.getBinding(chatId, topicId).showThinking ?? true;
    const { present } = createFeishuStreamPresenter({ showThinking });
    let output = "";
    const events = this.orchestrator.runAgent(chatId, topicId, prompt);
    for await (const event of events) {
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
