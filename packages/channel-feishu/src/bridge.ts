import {
  createLarkChannel,
  LoggerLevel,
  type LarkChannel,
} from "@larksuiteoapi/node-sdk";
import {
  resolveRequireMention,
  type AppConfig,
} from "@feishu-code-bridge/core";
import {
  RunOrchestrator,
  BOT_MENU_EVENT_KEYS,
  checkAccess,
  createFeishuStreamFormatter,
  formatWelcomeMessage,
  handleSlashCommand,
} from "@feishu-code-bridge/router";
import { registerFeishuExtraEvents } from "./feishu-extra-events.js";

export interface FeishuMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  content: string;
  threadId?: string;
  mentionedBot?: boolean;
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

    this.channel.on("message", async (msg) => {
      await this.handleMessage({
        messageId: msg.messageId,
        chatId: msg.chatId,
        chatType: msg.chatType,
        senderId: msg.senderId,
        content: msg.content,
        threadId: msg.threadId,
        mentionedBot: msg.mentionedBot,
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
        await this.handleMessage({
          messageId: `menu-${data.event_id ?? Date.now()}`,
          chatId: openId,
          chatType: "p2p",
          senderId:
            data.operator?.operator_id?.user_id ??
            data.operator?.operator_id?.open_id ??
            "menu",
          content: text,
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
    await this.channel?.disconnect();
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
    });

    if (slash?.type === "reply") {
      await this.sendMarkdown(msg.chatId, slash.text, msg.messageId);
      return;
    }

    const prompt =
      slash?.type === "agent"
        ? slash.prompt
        : slash?.type === "noop"
          ? null
          : msg.content;

    if (!prompt?.trim()) return;

    await this.streamAgentReply(msg, prompt);
  }

  private async streamAgentReply(
    msg: FeishuMessage,
    prompt: string,
  ): Promise<void> {
    if (!this.channel) return;

    await this.channel.stream(
      msg.chatId,
      {
        markdown: async (s) => {
          await s.append("_思考中…_");
          const format = createFeishuStreamFormatter();
          try {
            for await (const event of this.orchestrator.runAgent(
              msg.chatId,
              msg.threadId,
              prompt,
            )) {
              const chunk = format(event);
              if (chunk) await s.append(chunk);
            }
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
              await s.append("\n\n⏹ 已停止\n");
              return;
            }
            const message =
              err instanceof Error ? err.message : String(err);
            await s.append(`\n❌ ${message}\n`);
          }
        },
      },
      { replyTo: msg.messageId },
    );
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
