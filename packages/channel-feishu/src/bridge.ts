import {
  createLarkChannel,
  LoggerLevel,
  type LarkChannel,
  type ResourceDescriptor,
} from "@larksuiteoapi/node-sdk";
import {
  resolveRequireMention,
  type AppConfig,
  type RunAttachment,
} from "@feishu-code-bridge/core";
import {
  RunOrchestrator,
  BOT_MENU_EVENT_KEYS,
  checkAccess,
  createFeishuStreamPresenter,
  formatWelcomeMessage,
  handleSlashCommand,
} from "@feishu-code-bridge/router";
import { registerFeishuExtraEvents } from "./feishu-extra-events.js";
import {
  downloadInboundImages,
  resolveInboundPrompt,
} from "./feishu-inbound-media.js";
import { resolveOutboundFile } from "./feishu-outbound-file.js";

export interface FeishuMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  content: string;
  threadId?: string;
  mentionedBot?: boolean;
  attachments?: RunAttachment[];
}

export interface FeishuBridgeOptions {
  config: AppConfig;
  dataDir: string;
  onLog?: (msg: string) => void;
}

export class FeishuBridge {
  private channel?: LarkChannel;
  private orchestrator: RunOrchestrator;
  private config: AppConfig;
  /** 中断同会话内仍在进行的流式回复（斜杠命令需抢占） */
  private readonly chatStreamAbort = new Map<string, AbortController>();

  constructor(private readonly options: FeishuBridgeOptions) {
    this.config = options.config;
    this.orchestrator = new RunOrchestrator({
      dataDir: options.dataDir,
      config: options.config,
    });
  }

  get orchestratorRef(): RunOrchestrator {
    return this.orchestrator;
  }

  updateConfig(config: AppConfig) {
    this.config = config;
    this.orchestrator.updateConfig(config);
    this.applyPolicyToChannel();
  }

  private applyPolicyToChannel() {
    if (!this.channel) return;
    const policy = this.config.feishu.policy;
    this.channel.updatePolicy?.({
      requireMention: policy?.requireMention ?? true,
      dmMode: policy?.dmMode ?? "open",
      dmAllowlist: policy?.dmAllowlist,
      groupAllowlist: policy?.groupAllowlist,
      respondToMentionAll: policy?.respondToMentionAll ?? false,
    });
  }

  async connect(): Promise<void> {
    const { feishu } = this.config;
    this.channel = createLarkChannel({
      appId: feishu.appId,
      appSecret: feishu.appSecret,
      domain: feishu.domain,
      loggerLevel: LoggerLevel.info,
      policy: {
        requireMention: feishu.policy?.requireMention ?? true,
        dmMode: (feishu.policy?.dmMode === "disabled"
        ? "disabled"
        : feishu.policy?.dmMode) ?? "open",
        dmAllowlist: feishu.policy?.dmAllowlist,
        groupAllowlist: feishu.policy?.groupAllowlist,
        respondToMentionAll: feishu.policy?.respondToMentionAll ?? false,
      },
    });

    this.channel.on("message", (msg) => {
      void this.dispatchInboundMessage(msg).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.options.onLog?.(`处理入站消息失败: ${message}`);
      });
    });

    this.channel.on("reconnecting", () => {
      this.options.onLog?.("飞书 WebSocket 重连中…");
    });

    this.channel.on("reconnected", () => {
      this.options.onLog?.("飞书 WebSocket 已重连");
    });

    registerFeishuExtraEvents(this.channel, {
      onP2pChatEntered: async (data) => {
        const chatId = data.chat_id;
        if (!chatId || data.last_message_id) return;
        const name = this.channel?.botIdentity?.name ?? "飞书码桥";
        await this.sendMarkdown(chatId, formatWelcomeMessage(name));
      },
      onBotMenu: async (data) => {
        const openId = data.operator?.operator_id?.open_id;
        const eventKey = data.event_key;
        if (!openId || !eventKey) return;
        const text = BOT_MENU_EVENT_KEYS[eventKey];
        if (!text) return;
        void this.handleMessage({
          messageId: `menu-${data.event_id ?? Date.now()}`,
          chatId: openId,
          chatType: "p2p",
          senderId:
            data.operator?.operator_id?.user_id ??
            data.operator?.operator_id?.open_id ??
            "menu",
          content: text,
        }).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.options.onLog?.(`处理菜单事件失败: ${message}`);
        });
      },
    });

    await this.channel.connect();
    const botName = this.channel.botIdentity?.name ?? "unknown";
    this.options.onLog?.(`已连接飞书 bot: ${botName}`);
    this.options.onLog?.(
      "提示：可在飞书开放平台配置机器人自定义菜单，详见 docs/zh-CN/feishu-bot-menu.md",
    );
  }

  async disconnect(): Promise<void> {
    for (const ac of this.chatStreamAbort.values()) ac.abort();
    this.chatStreamAbort.clear();
    await this.channel?.disconnect();
  }

  private chatKey(chatId: string, topicId?: string): string {
    return `${chatId}|${topicId ?? ""}`;
  }

  private abortChatStream(chatId: string, topicId?: string): void {
    const key = this.chatKey(chatId, topicId);
    this.chatStreamAbort.get(key)?.abort();
    this.chatStreamAbort.delete(key);
  }

  private async dispatchInboundMessage(msg: {
    messageId: string;
    chatId: string;
    chatType: "p2p" | "group";
    senderId: string;
    content: string;
    threadId?: string;
    mentionedBot?: boolean;
    resources?: ResourceDescriptor[];
  }): Promise<void> {
    this.options.onLog?.(
      `[inbound] ${msg.messageId} ${msg.content.slice(0, 60).replace(/\n/g, " ")}`,
    );
    let attachments: RunAttachment[] = [];
    const imageResources =
      msg.resources?.filter((r) => r.type === "image") ?? [];
    if (imageResources.length > 0 && this.channel) {
      try {
        attachments = await downloadInboundImages(
          this.channel,
          msg.messageId,
          imageResources,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.sendMarkdown(
          msg.chatId,
          `❌ 图片下载失败，将仅按文字处理：${message}\n\n` +
            "用户发送的图片需使用「消息资源」接口下载，请确认应用已开通：\n" +
            "- `im:message` 或 `im:message:readonly`\n" +
            "- `im:resource`（上传用；下载用户图片主要靠前者）",
          msg.messageId,
        );
        // 图片下载失败仅降级为纯文字处理，不中断整条消息；
        // 若消息本身没有可用文字内容（纯图片消息），则没有必要继续触发一次空跑。
        if (!resolveInboundPrompt(msg.content, 0)) return;
      }
    }

    await this.handleMessage({
      messageId: msg.messageId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      senderId: msg.senderId,
      content: msg.content,
      threadId: msg.threadId,
      mentionedBot: msg.mentionedBot,
      attachments,
    });
  }

  private async handleMessage(msg: FeishuMessage): Promise<void> {
    const isDm = msg.chatType === "p2p";
    if (
      !checkAccess(this.config, msg.chatId, msg.senderId, isDm)
    ) {
      return;
    }

    const policy = this.config.feishu.policy;
    if (
      !isDm &&
      resolveRequireMention(policy, msg.chatId) &&
      !msg.mentionedBot
    ) {
      return;
    }

    const slash = await handleSlashCommand({
      chatId: msg.chatId,
      topicId: msg.threadId,
      senderId: msg.senderId,
      text: msg.content,
      config: this.config,
      router: this.orchestrator.router,
      listCliSessions: (options) =>
        this.orchestrator.listCliSessions(msg.chatId, msg.threadId, options),
      bindCliSession: (sessionId) =>
        this.orchestrator.bindCliSession(msg.chatId, msg.threadId, sessionId),
      cancelActiveRun: () =>
        this.orchestrator.cancelActiveForChat(msg.chatId, msg.threadId),
      hasActiveRun: () =>
        this.orchestrator.hasActiveRun(msg.chatId, msg.threadId),
    });

    if (slash?.type === "reply") {
      const cmd = msg.content.trim().split(/\s+/)[0]?.toLowerCase();
      this.abortChatStream(msg.chatId, msg.threadId);
      if (cmd !== "/stop" && cmd !== "/cancel") {
        void this.orchestrator
          .cancelActiveForChat(msg.chatId, msg.threadId)
          .catch(() => {});
      }
      try {
        await this.sendMarkdown(msg.chatId, slash.text, msg.messageId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.options.onLog?.(`斜杠回复发送失败: ${message}`);
      }
      return;
    }

    if (slash?.type === "send_file") {
      // /send 不打断正在进行的 Agent 任务，独立发送文件
      try {
        const file = await resolveOutboundFile(slash.path);
        await this.channel?.send(
          msg.chatId,
          { file: { source: file.path, fileName: file.fileName } },
          { replyTo: msg.messageId },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.sendMarkdown(
          msg.chatId,
          `❌ 文件发送失败：${message}`,
          msg.messageId,
        ).catch(() => {});
      }
      return;
    }

    const rawPrompt =
      slash?.type === "agent"
        ? slash.prompt
        : slash?.type === "noop"
          ? null
          : msg.content;

    const prompt = rawPrompt
      ? resolveInboundPrompt(rawPrompt, msg.attachments?.length ?? 0)
      : null;

    if (!prompt?.trim() && !msg.attachments?.length) return;

    const agentPrompt =
      prompt?.trim() ||
      resolveInboundPrompt("", msg.attachments?.length ?? 0);

    void this.streamAgentReply(msg, agentPrompt).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.options.onLog?.(`Agent 回复失败: ${message}`);
      void this.sendMarkdown(
        msg.chatId,
        `❌ Agent 回复失败：${message}\n\n可试 \`/stop\` 后重发，或 \`./scripts/start.sh restart\``,
        msg.messageId,
      ).catch((sendErr) => {
        const sendMsg =
          sendErr instanceof Error ? sendErr.message : String(sendErr);
        this.options.onLog?.(`Agent 错误回执发送失败: ${sendMsg}`);
      });
    });
  }

  private async streamAgentReply(
    msg: FeishuMessage,
    prompt: string,
  ): Promise<void> {
    if (!this.channel) return;

    const key = this.chatKey(msg.chatId, msg.threadId);
    this.abortChatStream(msg.chatId, msg.threadId);
    void this.orchestrator
      .cancelActiveForChat(msg.chatId, msg.threadId)
      .catch(() => {});

    const streamAbort = new AbortController();
    this.chatStreamAbort.set(key, streamAbort);

    try {
      await this.channel.stream(
        msg.chatId,
        {
          markdown: async (s) => {
            if (streamAbort.signal.aborted) return;
            await s.append("_思考中…_");
            const { present } = createFeishuStreamPresenter();
            let resultStarted = false;
            const appendToResult = async (chunk: string) => {
              if (streamAbort.signal.aborted) return;
              if (!resultStarted) {
                await s.append("\n\n---\n\n");
                resultStarted = true;
              }
              await s.append(chunk);
            };
            try {
              for await (const event of this.orchestrator.runAgent(
                msg.chatId,
                msg.threadId,
                prompt,
                msg.attachments,
              )) {
                if (streamAbort.signal.aborted) return;
                const part = present(event);
                if (!part) continue;
                if (part.zone === "thinking") {
                  await s.append(part.text);
                } else {
                  await appendToResult(part.text);
                }
              }
            } catch (err) {
              if (streamAbort.signal.aborted) return;
              if (err instanceof Error && err.name === "AbortError") {
                await appendToResult("\n\n⏹ 已停止\n");
                return;
              }
              const message =
                err instanceof Error ? err.message : String(err);
              await appendToResult(`\n❌ ${message}\n`);
            }
          },
        },
        { replyTo: msg.messageId },
      );
    } catch (err) {
      if (!streamAbort.signal.aborted) throw err;
    } finally {
      if (this.chatStreamAbort.get(key) === streamAbort) {
        this.chatStreamAbort.delete(key);
      }
    }
  }

  private async sendMarkdown(
    chatId: string,
    markdown: string,
    replyTo?: string,
  ): Promise<void> {
    if (!this.channel) return;
    await this.channel.send(chatId, { markdown }, { replyTo });
  }

}

export async function runDoctor(
  config: AppConfig,
  dataDir: string,
): Promise<Record<string, unknown>> {
  const orch = new RunOrchestrator({ dataDir, config });
  let runner: unknown = { ok: false, error: "not checked" };
  let health: unknown = { ok: false };
  try {
    runner = await orch.doctor();
    health = await orch.health();
  } catch (err) {
    runner = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      hint: "Start feishu-code-runner on the host first",
    };
  }
  return {
    feishu: {
      domain: config.feishu.domain,
      appId: config.feishu.appId ? "set" : "missing",
    },
    runner: health,
    backends: runner,
  };
}
