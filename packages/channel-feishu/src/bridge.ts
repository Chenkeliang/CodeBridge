import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createLarkChannel,
  LoggerLevel,
  type LarkChannel,
  type ResourceDescriptor,
} from "@larksuiteoapi/node-sdk";
import {
  JsonMapStore,
  MentionRegistry,
  formatMentionGuidance,
  resolveRequireMention,
  type AgentEvent,
  type AppConfig,
  type ChannelFlowBatchSnapshot,
  type ChannelSessionEvent,
  type ChannelSessionIngress,
  type ChannelSlot,
  type RunAttachment,
} from "@codebridge/core";
import {
  RunOrchestrator,
  BOT_MENU_EVENT_KEYS,
  ChannelFlowController,
  checkAccess,
  createChannelStreamProjector,
  formatChannelFlowBatchSnapshot,
  formatElapsed,
  formatWelcomeMessage,
  handleSlashCommand,
  isTerminalChannelFlowBatch,
} from "@codebridge/router";
import { registerFeishuExtraEvents } from "./feishu-extra-events.js";
import { ChainTopicTracker } from "./chain-topics.js";
import {
  FeishuSessionWatcher,
  FEISHU_LIVE_STATUS_TICK_MS,
  FEISHU_PROGRESS_NOTICE_INTERVAL_MS,
  type FeishuCardHost,
} from "./session-watcher.js";
import {
  downloadInboundImages,
  resolveInboundPrompt,
} from "./feishu-inbound-media.js";
import { resolveOutboundFile } from "./feishu-outbound-file.js";
import { buildInboundPromptPrefix } from "./feishu-inbound-context.js";
import {
  shouldAcceptGroupMessage,
  topicActiveForMessage,
} from "./feishu-mention-gate.js";
import { CoalescingCardWriter } from "./coalescing-card-writer.js";
import {
  createFeishuRunStatus,
  finishFeishuRunStatus,
  recordFeishuRunActivity,
  renderFeishuRunStatus,
  type FeishuConnectionState,
} from "./run-status.js";
import { FeishuDeliveryReconciler } from "./delivery-reconciler.js";

export interface FeishuMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  senderName?: string;
  content: string;
  threadId?: string;
  /** 回复串的串首消息 id（普通群回复时有值） */
  rootId?: string;
  /** 被直接回复（引用）的消息 id */
  replyToMessageId?: string;
  mentionedBot?: boolean;
  mentions?: FeishuMention[];
  attachments?: RunAttachment[];
}

export interface FeishuMention {
  openId?: string;
  userId?: string;
  name?: string;
  isBot?: boolean;
}

export interface FeishuBridgeOptions {
  config: AppConfig;
  dataDir: string;
  onLog?: (msg: string) => void;
  sessionIngress?: ChannelSessionIngress;
}

/** 降级时单条普通消息的最大字符数；结果超过就用 chunkMarkdown 分条发，避免撞飞书消息长度上限 */
const FEISHU_MSG_CHUNK_CHARS = 12000;

/** 只在卡片保留最新进度，避免长任务把数百条 commentary 累积成超长卡片。 */
const FEISHU_LIVE_PROGRESS_CHARS = 1200;

const FEISHU_OUTPUT_STYLE_GUIDANCE =
  "【飞书输出样式】最终答复可按需少量使用飞书官方 `<text_tag color='blue'>文本</text_tag>`：blue 表示分组/信息，orange 表示需关注的修改，green 表示成功，red 表示失败/阻塞；每次最多 3 个，其余使用标准 Markdown，不必强行加色。";

interface PendingFeishuStream {
  chatId: string;
  sourceMessageId: string;
  startedAt: string;
}

interface ChannelFlowSubmission {
  flowId: string;
  definitionRevision: string;
  inputs: Record<string, unknown>;
  idempotencyKey: string;
}

function interruptedStreamCard(): object {
  return {
    schema: "2.0",
    config: {
      summary: { content: "任务因服务重启而中断" },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content:
            "⚠️ **任务因 CodeBridge 服务重启而中断。**\n\n请重新发送上一条消息继续。",
        },
      ],
    },
  };
}

/** 把长文本按行切成 ≤ maxLen 的块，用于超长结果分条普通消息发送（避免又撞长度上限） */
export function chunkMarkdown(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    let seg = line;
    while (seg.length > maxLen) {
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      chunks.push(seg.slice(0, maxLen));
      seg = seg.slice(maxLen);
    }
    if (cur && cur.length + seg.length + 1 > maxLen) {
      chunks.push(cur);
      cur = "";
    }
    cur += cur ? `\n${seg}` : seg;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function waitForBatchPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export class FeishuBridge {
  private channel?: LarkChannel;
  private orchestrator: RunOrchestrator;
  private config: AppConfig;
  /** chat|topic → 最近一条入站消息 id（出站消息回贴话题用） */
  private readonly lastInboundMessageId = new Map<string, string>();
  /** 普通群回复串 → 会话 topic 映射 */
  private readonly chainTopics = new ChainTopicTracker();
  /** bot 已参与过的话题（内存；重启后由 Catalog 槽位绑定续上） */
  private readonly botParticipatedTopics = new Set<string>();
  private readonly mentionRegistry = new MentionRegistry();
  private readonly pendingStreams: JsonMapStore<PendingFeishuStream>;
  /** 所有活动流的 AbortController（非 chat-scoped），disconnect 时统一 abort */
  private readonly activeAborts = new Set<AbortController>();
  /** 每 Session 一个持久事件订阅，单订阅路由 Turn/Run/Delivery */
  private readonly sessionWatchers = new Map<string, FeishuSessionWatcher>();
  private readonly flowController = new ChannelFlowController();
  private readonly instanceId = randomUUID();
  private readonly deliveryReconciler: FeishuDeliveryReconciler;
  private inboundWebSocketState: FeishuConnectionState = "unavailable";
  private disconnecting = false;
  private sessionIngress?: ChannelSessionIngress;
  private readonly cardUpdateSequences = new Map<string, number>();

  constructor(private readonly options: FeishuBridgeOptions) {
    this.config = options.config;
    this.sessionIngress = options.sessionIngress;
    this.pendingStreams = new JsonMapStore<PendingFeishuStream>(
      path.join(options.dataDir, "feishu-pending-streams.json"),
    );
    this.orchestrator = new RunOrchestrator({
      dataDir: options.dataDir,
      config: options.config,
    });
    this.deliveryReconciler = new FeishuDeliveryReconciler({
      intervalMs: FEISHU_LIVE_STATUS_TICK_MS,
      reconcile: () => this.reconcileDeliveries(),
      onError: (error) => {
        this.options.onLog?.(
          `飞书 Delivery/Run 对账失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });
  }

  get orchestratorRef(): RunOrchestrator {
    return this.orchestrator;
  }

  setSessionIngress(ingress: ChannelSessionIngress): void {
    this.sessionIngress = ingress;
  }

  updateConfig(config: AppConfig) {
    this.config = config;
    this.orchestrator.updateConfig(config);
    this.applyPolicyToChannel();
  }

  private applyPolicyToChannel() {
    if (!this.channel) return;
    const policy = this.config.feishu.policy;
    // 群 @ 策略由 Bridge 按话题/session 判断；SDK 层关闭以免话题内续聊被拦截
    this.channel.updatePolicy?.({
      requireMention: false,
      dmMode: policy?.dmMode ?? "open",
      dmAllowlist: policy?.dmAllowlist,
      groupAllowlist: policy?.groupAllowlist,
      respondToMentionAll: policy?.respondToMentionAll ?? false,
    });
  }

  async connect(): Promise<void> {
    this.disconnecting = false;
    const { feishu } = this.config;
    this.channel = createLarkChannel({
      appId: feishu.appId,
      appSecret: feishu.appSecret,
      domain: feishu.domain,
      loggerLevel: LoggerLevel.info,
      policy: {
        requireMention: false,
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
      this.inboundWebSocketState = "reconnecting";
      for (const watcher of this.sessionWatchers.values()) {
        void watcher.setInboundWebSocketState("reconnecting").catch(() => {});
      }
      this.options.onLog?.("飞书 WebSocket 重连中…");
    });

    this.channel.on("reconnected", () => {
      this.inboundWebSocketState = "connected";
      for (const watcher of this.sessionWatchers.values()) {
        void watcher.setInboundWebSocketState("connected").catch(() => {});
      }
      void this.deliveryReconciler.trigger();
      this.options.onLog?.("飞书 WebSocket 已重连");
    });

    registerFeishuExtraEvents(this.channel, {
      onP2pChatEntered: async (data) => {
        const chatId = data.chat_id;
        if (!chatId || data.last_message_id) return;
        const name = this.channel?.botIdentity?.name ?? "CodeBridge";
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
    this.inboundWebSocketState = "connected";
    this.deliveryReconciler.start();
    await this.recoverInterruptedStreams();
    const botName = this.channel.botIdentity?.name ?? "unknown";
    this.options.onLog?.(`已连接飞书 bot: ${botName}`);
    this.options.onLog?.(
      "提示：可在飞书开放平台配置机器人自定义菜单，详见 docs/zh-CN/feishu-bot-menu.md",
    );
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true;
    this.deliveryReconciler.stop();
    this.inboundWebSocketState = "unavailable";
    for (const ac of this.activeAborts) ac.abort();
    this.activeAborts.clear();
    for (const watcher of this.sessionWatchers.values()) watcher.abort();
    this.sessionWatchers.clear();
    await this.channel?.disconnect();
  }

  private async recoverInterruptedStreams(): Promise<void> {
    if (!this.channel) return;
    for (const messageId of Object.keys(this.pendingStreams.read())) {
      try {
        await this.channel.updateCard(messageId, interruptedStreamCard());
        this.pendingStreams.update((all) => {
          const next = { ...all };
          delete next[messageId];
          return next;
        });
        this.options.onLog?.(`已收尾服务重启前中断的飞书卡片: ${messageId}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.options.onLog?.(`中断卡片收尾失败，保留待下次重试: ${messageId} ${message}`);
      }
    }
  }

  private chatKey(chatId: string, topicId?: string): string {
    return `${chatId}|${topicId ?? ""}`;
  }

  private async dispatchInboundMessage(msg: {
    messageId: string;
    chatId: string;
    chatType: "p2p" | "group";
    senderId: string;
    senderName?: string;
    content: string;
    threadId?: string;
    rootId?: string;
    replyToMessageId?: string;
    mentionedBot?: boolean;
    mentions?: FeishuMention[];
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
      senderName: msg.senderName,
      content: msg.content,
      threadId: msg.threadId,
      rootId: msg.rootId,
      replyToMessageId: msg.replyToMessageId,
      mentionedBot: msg.mentionedBot,
      mentions: msg.mentions,
      attachments,
    });
  }

  /**
   * 消息所属会话 topic：话题群直接用 thread_id；普通群把「回复串」映射为
   * topic——群根发起的对话延续群级会话，回复陌生消息（如告警推送）的串
   * 自动成为独立话题、开启全新 session。
   */
  private resolveTopicId(msg: FeishuMessage): string | undefined {
    if (msg.threadId) return msg.threadId;
    if (msg.chatType !== "group") return undefined;
    if (!msg.rootId) {
      this.chainTopics.recordGroupRoot(msg.messageId);
      return undefined;
    }
    return this.chainTopics.resolve(msg.rootId);
  }

  private async handleMessage(msg: FeishuMessage): Promise<void> {
    const isDm = msg.chatType === "p2p";
    if (
      !checkAccess(this.config, msg.chatId, msg.senderId, isDm)
    ) {
      return;
    }

    const policy = this.config.feishu.policy;
    const topicId = this.resolveTopicId(msg);

    // 槽位是否已绑 session（Catalog 事实源），不再读 sessions.json。
    const boundSessionId = this.sessionIngress
      ? (await this.sessionIngress.getSlotCommandContext(
          this.buildFullSlot(msg.chatId, topicId),
        )).sessionId
      : null;

    if (
      !isDm &&
      !shouldAcceptGroupMessage({
        chatId: msg.chatId,
        mentionedBot: msg.mentionedBot,
        topicId,
        requireMention: resolveRequireMention(policy, msg.chatId),
        topicActive: topicActiveForMessage(
          msg,
          topicId,
          Boolean(boundSessionId),
          this.botParticipatedTopics,
        ),
      })
    ) {
      return;
    }

    // 记录话题/会话最近一条入站消息，供出站 API 回贴到正确的话题
    this.lastInboundMessageId.set(
      this.chatKey(msg.chatId, topicId),
      msg.messageId,
    );

    const flowCommand = this.sessionIngress
      ? await this.flowController.handle({
          scopeKey: `feishu|${this.chatKey(msg.chatId, topicId)}|${msg.senderId}`,
          text: msg.content,
          listFlows: () => this.sessionIngress!.listConsumableFlows(),
          getSessionId: async () => {
            const context = await this.sessionIngress!.getSlotCommandContext(this.buildFullSlot(msg.chatId, topicId));
            return context.sessionId;
          },
          listManageableFlows: this.sessionIngress.listManageableFlows,
          saveLatestGuide: this.sessionIngress.saveLatestGuide,
          getFlowReviewSummary: this.sessionIngress.getFlowReviewSummary,
          updateCandidateSummary: this.sessionIngress.updateCandidateSummary,
          rejectCandidate: this.sessionIngress.rejectCandidate,
          getFlowBatchDraft: this.sessionIngress.getFlowBatchDraft,
          confirmFlowBatchDraft: this.sessionIngress.confirmFlowBatchDraft,
          getFlowBatch: this.sessionIngress.getFlowBatch,
          cancelFlowBatch: this.sessionIngress.cancelFlowBatch,
          retryFailedFlowBatch: this.sessionIngress.retryFailedFlowBatch,
          getActiveRunId: async () => {
            const context = await this.sessionIngress!.getSlotCommandContext(
              this.buildFullSlot(msg.chatId, topicId),
            );
            return context.activeRunId;
          },
          listApprovals: (runId) =>
            this.sessionIngress!.listRuntimeApprovals?.(runId) ?? Promise.resolve([]),
          resolveApproval: (runId, approvalId, decision) => {
            const resolve = this.sessionIngress!.resolveRuntimeApproval;
            if (!resolve) throw new Error("Runtime 审批入口未就绪");
            return resolve(runId, approvalId, decision);
          },
        })
      : null;
    if (flowCommand?.type === "reply") {
      await this.sendMarkdown(msg.chatId, flowCommand.text, msg.messageId);
      if (flowCommand.batch) {
        this.monitorFlowBatch(flowCommand.batch, msg.chatId, msg.messageId);
      }
      return;
    }
    if (flowCommand?.type === "invoke") {
      await this.submitAndStream(
        msg,
        `运行 Flow：${flowCommand.flow.name}`,
        topicId,
        {
          flowId: flowCommand.flow.flowId,
          definitionRevision: flowCommand.flow.definitionRevision,
          inputs: flowCommand.inputs,
          idempotencyKey: flowCommand.idempotencyKey,
        },
      );
      return;
    }

    const slash = await handleSlashCommand({
      chatId: msg.chatId,
      topicId,
      senderId: msg.senderId,
      text: msg.content,
      config: this.config,
      router: this.orchestrator.router,
      listSessions: (options) =>
        this.orchestrator.listSessions(msg.chatId, topicId, options),
      resumeProviderSession: async (providerSessionId) => {
        if (!this.sessionIngress) {
          return { ok: false, error: "Runner 未就绪" };
        }
        try {
          const { sessionId } = await this.sessionIngress.resumeProviderSession(
            this.buildFullSlot(msg.chatId, topicId),
            providerSessionId,
          );
          return { ok: true, sessionId };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            busy: message === "provider_session_busy",
            conflict: message === "slot_already_bound",
            error: message,
          };
        }
      },
      closeSession: (sessionId) =>
        this.orchestrator.closeSession(msg.chatId, topicId, sessionId),
      deleteSession: (sessionId) =>
        this.orchestrator.deleteSession(msg.chatId, topicId, sessionId),
      listConfigOptions: () =>
        this.orchestrator.listConfigOptions(msg.chatId, topicId),
      resolvePermission: async (approve) => {
        if (!this.sessionIngress) {
          return this.orchestrator.resolveActivePermission(
            msg.chatId,
            topicId,
            approve,
          );
        }
        const ctx = await this.sessionIngress.getSlotCommandContext(
          this.buildFullSlot(msg.chatId, topicId),
        );
        if (!ctx.activeRunId) return false;
        return this.sessionIngress.resolvePermission(ctx.activeRunId, approve);
      },
      cancelActiveRun: async () => {
        if (!this.sessionIngress) {
          return this.orchestrator.cancelActiveForChat(msg.chatId, topicId);
        }
        const ctx = await this.sessionIngress.getSlotCommandContext(
          this.buildFullSlot(msg.chatId, topicId),
        );
        if (!ctx.sessionId || !ctx.activeRunId) return false;
        return this.sessionIngress.cancelRun(ctx.sessionId, ctx.activeRunId);
      },
      getSlotCommandContext: async () => {
        if (!this.sessionIngress) {
          return {
            sessionId: null,
            activeRunId: null,
            providerSessionId: null,
          };
        }
        return this.sessionIngress.getSlotCommandContext(
          this.buildFullSlot(msg.chatId, topicId),
        );
      },
      resumeQueue: async (sessionId) => {
        if (!this.sessionIngress) return { queueState: "paused" };
        return this.sessionIngress.resumeQueue(sessionId);
      },
      steerActiveRun: async (runId, prompt) => {
        if (!this.sessionIngress) {
          return { ok: false, error: "Runner 未就绪" };
        }
        return this.sessionIngress.steerRun(runId, prompt);
      },
      authorizeDirectory: (directory) =>
        this.orchestrator.authorizeDirectory(directory),
      notifyStatus: (text) =>
        this.sendMarkdown(msg.chatId, text, msg.messageId),
    });

    if (slash?.type === "reply") {
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

    await this.dispatchToAgent(msg, agentPrompt, topicId);
  }

  /** 组装话题/引用上下文并启动 agent 流式回复 */
  private async dispatchToAgent(
    msg: FeishuMessage,
    agentPrompt: string,
    topicId: string | undefined,
  ): Promise<void> {
    // 话题根消息 + 引用回复注入 prompt；拉取失败降级，不阻断
    let contextPrefix: string | undefined;
    if (this.channel) {
      try {
        contextPrefix = await buildInboundPromptPrefix(
          this.channel,
          msg,
          topicId,
          this.config.feishu.appId,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.options.onLog?.(`话题/引用上下文拉取失败: ${message}`);
      }
    }
    const promptWithContext = contextPrefix
      ? `${contextPrefix}\n\n${agentPrompt}`
      : agentPrompt;
    const scope = { chatId: msg.chatId, topicId };
    const requester = this.mentionRegistry.register(scope, {
      channel: "feishu",
      kind: "user",
      id: msg.senderId,
      name: msg.senderName,
    });
    const mentionTargets = [requester];
    for (const mention of msg.mentions ?? []) {
      const id = mention.openId ?? mention.userId;
      if (!id || mention.isBot) continue;
      const registered = this.mentionRegistry.register(scope, {
        channel: "feishu",
        kind: "user",
        id,
        name: mention.name,
      });
      if (!mentionTargets.some((target) => target.ref === registered.ref)) {
        mentionTargets.push(registered);
      }
    }
    const mentionGuidance = formatMentionGuidance(
      mentionTargets,
      requester.ref,
    );
    const finalPrompt = [
      promptWithContext,
      mentionGuidance,
      FEISHU_OUTPUT_STYLE_GUIDANCE,
    ].join("\n\n");

    if (topicId) this.botParticipatedTopics.add(topicId);

    void this.submitAndStream(msg, finalPrompt, topicId)
      .catch((err) => {
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

  private cardHost(): FeishuCardHost {
    return {
      channel: this.channel,
      sendMarkdown: (chatId, markdown, replyTo) =>
        this.sendMarkdown(chatId, markdown, replyTo),
      resolveCardId: async (messageId) => {
        if (!this.channel) throw new Error("Feishu channel is unavailable");
        const response = await this.channel.rawClient.cardkit.v1.card.idConvert({
          data: { message_id: messageId },
        });
        if (response.code !== undefined && response.code !== 0) {
          throw new Error(
            `CardKit id conversion failed (${response.code}): ${response.msg ?? "unknown"}`,
          );
        }
        const cardId = response.data?.card_id;
        if (!cardId) throw new Error("CardKit id conversion returned no card_id");
        return cardId;
      },
      updateCard: async (cardId, card) => {
        if (!this.channel) throw new Error("Feishu channel is unavailable");
        const wallClockSequence = Math.floor(Date.now() / 1000);
        const sequence = Math.max(
          wallClockSequence,
          (this.cardUpdateSequences.get(cardId) ?? 0) + 1,
        );
        if (sequence > 2_147_483_647) {
          throw new Error("CardKit update sequence exceeds int32 range");
        }
        this.cardUpdateSequences.set(cardId, sequence);
        const response = await this.channel.rawClient.cardkit.v1.card.update({
          path: { card_id: cardId },
          data: {
            card: { type: "card_json", data: JSON.stringify(card) },
            sequence,
            uuid: `recovery_${randomUUID()}`,
          },
        });
        if (response.code !== undefined && response.code !== 0) {
          throw new Error(
            `CardKit update failed (${response.code}): ${response.msg ?? "unknown"}`,
          );
        }
      },
      registerPendingStream: (messageId, entry) => {
        this.pendingStreams.update((all) => ({ ...all, [messageId]: entry }));
      },
      clearPendingStream: (messageId) => {
        this.pendingStreams.update((all) => {
          const next = { ...all };
          delete next[messageId];
          return next;
        });
      },
      log: (message) => this.options.onLog?.(message),
      isDisconnecting: () => this.disconnecting,
    };
  }

  private buildFullSlot(chatId: string, topicId?: string): ChannelSlot {
    const slot = this.orchestrator.router.buildSlot(chatId, topicId);
    return {
      channel: "feishu",
      conversationId: this.chatKey(chatId, topicId),
      agentId: slot.agentId,
      workspaceKey: slot.workspaceKey,
      generation: slot.generation,
    };
  }

  private ensureSessionWatcher(sessionId: string): FeishuSessionWatcher {
    const existing = this.sessionWatchers.get(sessionId);
    if (existing) return existing;
    const watcher = new FeishuSessionWatcher(
      this.cardHost(),
      this.sessionIngress!,
      sessionId,
      this.instanceId,
    );
    this.sessionWatchers.set(sessionId, watcher);
    return watcher;
  }

  private async reconcileDeliveries(): Promise<void> {
    if (!this.sessionIngress || !this.channel) return;
    const deliveries = await this.sessionIngress.listDeliveries("feishu");
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
        const chatId =
          delivery.conversationId.split("|")[0] ?? delivery.conversationId;
        const turn = {
          turnId: delivery.turnId,
          chatId,
          sourceMessageId: delivery.replyToMessageId,
          showThinking: true,
        };
        if (delivery.surfaceMessageId) {
          // delivering：从 legacy interrupted recovery 中剔除，避免被覆盖成“服务中断”
          this.pendingStreams.update((all) => {
            const next = { ...all };
            delete next[delivery.surfaceMessageId!];
            return next;
          });
        }
        await watcher.reconcileDelivery(
          delivery,
          turn,
          this.inboundWebSocketState,
        );
      }
      watcher.start(minAccepted);
    }
  }

  private async submitAndStream(
    msg: FeishuMessage,
    prompt: string,
    topicId: string | undefined,
    flow?: ChannelFlowSubmission,
  ): Promise<void> {
    if (!this.sessionIngress) {
      await this.streamAgentReply(msg, prompt, topicId);
      return;
    }
    const binding = this.orchestrator.router.getBinding(msg.chatId, topicId);
    const slot = this.orchestrator.router.buildSlot(msg.chatId, topicId);
    const receipt = await this.sessionIngress.submit({
      channel: "feishu",
      conversationId: this.chatKey(msg.chatId, topicId),
      agentId: binding.backendId,
      cwd: binding.cwd,
      generation: slot.generation,
      message: prompt,
      model: binding.model,
      ...(flow
        ? {
            flowId: flow.flowId,
            flowDefinitionRevision: flow.definitionRevision,
            inputs: flow.inputs,
          }
        : {}),
      attachments: msg.attachments,
      idempotencyKey: flow?.idempotencyKey ?? msg.messageId,
      replyToMessageId: msg.messageId,
      actorRef: { channel: "feishu", id: msg.senderId },
    });
    const turn = {
      turnId: receipt.turnId,
      chatId: msg.chatId,
      sourceMessageId: msg.messageId,
      showThinking: binding.showThinking ?? true,
    };
    const watcher = this.ensureSessionWatcher(receipt.sessionId);
    if (receipt.acceptance === "queued") {
      await this.sendMarkdown(
        msg.chatId,
        receipt.queueState === "paused"
          ? "⏸ 当前 Session 已暂停，消息已排队。发送 /c 恢复队列，或 /new 新建会话。"
          : `⏳ 当前任务进行中，消息已排队（turn ${receipt.turnId.slice(0, 8)}）。`,
        msg.messageId,
      ).catch(() => {});
      watcher.registerPendingTurn(receipt.turnId, turn);
      watcher.start(receipt.eventSequence);
      return;
    }
    if (!receipt.runId) {
      throw new Error(
        `dispatched receipt missing run_id for turn ${receipt.turnId}`,
      );
    }
    await watcher.openCardForRun(receipt.runId, turn);
    watcher.start(receipt.eventSequence);
  }

  private async streamAgentReply(
    msg: FeishuMessage,
    prompt: string,
    topicId: string | undefined,
    sessionId?: string,
    runId?: string | null,
    afterSequence?: number,
  ): Promise<void> {
    if (!this.channel) return;

    const streamAbort = new AbortController();
    this.activeAborts.add(streamAbort);

    // /thinking off：隐藏内部思考/工具；仍展示 Codex commentary 检查点和最终答案。
    const showThinking =
      this.orchestrator.router.getBinding(msg.chatId, topicId).showThinking ??
      true;
    const projector = createChannelStreamProjector({
      showThinking,
      maxProgressChars: FEISHU_LIVE_PROGRESS_CHARS,
    });
    const runStatus = createFeishuRunStatus();
    const startedAt = runStatus.startedAt;
    let agentConsumed = false; // 已消费过 agent 事件流？（避免降级时重复跑）
    let cardBroken = false; // 飞书卡片流式失败（如 11310 cardid invalid）→ 降级
    let streamMessageId: string | undefined;

    // 消费 Agent 事件只更新内存状态；飞书 I/O 由独立合并写队列处理，不能反压 ACP。
    const consumeAgent = async (
      onEvent: (event: AgentEvent) => void,
      onProjection: () => void,
    ): Promise<void> => {
      agentConsumed = true;
      try {
        const events = this.sessionIngress && sessionId
          ? mapDomainToAgent(
              this.sessionIngress.events(sessionId, {
                afterSequence: afterSequence ?? 0,
                signal: streamAbort.signal,
              }),
              runId ?? undefined,
            )
          : this.orchestrator.runAgent(msg.chatId, topicId, prompt, msg.attachments);
        for await (const event of events) {
          if (streamAbort.signal.aborted) return;
          onEvent(event);
          if (event.type === "permission_request") {
            // 独立消息比卡片内文字更醒目；等待期 runner 会在超时后自动拒绝
            void this.sendMarkdown(
              msg.chatId,
              this.sessionIngress
                ? `🔐 Agent 请求权限：**${event.title}**`
                : `🔐 Agent 请求权限：**${event.title}**\n回复 \`/approve\` 允许，\`/deny\` 拒绝（8 分钟未回复自动拒绝）。`,
              msg.messageId,
            ).catch(() => {});
            continue;
          }
          projector.apply(event);
          if (event.type === "done") {
            finishFeishuRunStatus(
              runStatus,
              event.exitCode === 0 ? "succeeded" : "failed",
            );
          }
          onProjection();
        }
        finishFeishuRunStatus(runStatus, "succeeded");
        onProjection();
      } catch (err) {
        if (streamAbort.signal.aborted) {
          finishFeishuRunStatus(runStatus, "interrupted");
          return;
        }
        if (err instanceof Error && err.name === "AbortError") {
          projector.apply({ type: "text_delta", text: "\n\n⏹ 已停止\n" });
          finishFeishuRunStatus(runStatus, "cancelled");
          onProjection();
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        projector.apply({ type: "error", message });
        finishFeishuRunStatus(runStatus, "failed");
        onProjection();
      }
    };

    try {
      await this.channel.stream(
        msg.chatId,
        {
          markdown: async (s) => {
            streamMessageId = s.messageId;
            this.pendingStreams.update((all) => ({
              ...all,
              [s.messageId]: {
                chatId: msg.chatId,
                sourceMessageId: msg.messageId,
                startedAt: new Date().toISOString(),
              },
            }));
            if (streamAbort.signal.aborted) return;
            let activityVersion = 0;
            let notifiedActivityVersion = 0;
            let quietNotifiedActivityVersion = -1;
            type CardSnapshot = { content: string; statusOnly: boolean };

            const renderBody = (): string => {
              const snapshot = projector.snapshot();
              return runStatus.state === "running"
                ? snapshot.liveText
                : snapshot.finalText;
            };

            const writer = new CoalescingCardWriter<CardSnapshot>(
              async (snapshot) => {
                if (cardBroken || streamAbort.signal.aborted) return;
                try {
                  await s.setContent(snapshot.content);
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err);
                  if (snapshot.statusOnly) {
                    this.options.onLog?.(
                      `飞书任务状态刷新失败（不影响 Agent 运行）：${message}`,
                    );
                    return;
                  }
                  cardBroken = true;
                  this.options.onLog?.(
                    `卡片流式失败，降级为普通消息：${message}`,
                  );
                }
              },
              undefined,
              (pending, next) => ({
                ...next,
                statusOnly: pending.statusOnly && next.statusOnly,
              }),
            );

            const queueRender = (statusOnly: boolean): void => {
              const status = renderFeishuRunStatus(runStatus);
              const body = renderBody();
              writer.enqueue({
                content:
                  status && body ? `${status}\n\n---\n\n${body}` : status || body,
                statusOnly,
              });
            };

            queueRender(false);
            const statusTimer = setInterval(() => {
              if (cardBroken || streamAbort.signal.aborted) return;
              queueRender(true);
            }, FEISHU_LIVE_STATUS_TICK_MS);
            statusTimer.unref?.();

            const noticeTimer = setInterval(() => {
              if (streamAbort.signal.aborted) return;
              const version = activityVersion;
              const hasNewActivity = version > notifiedActivityVersion;
              const quiet =
                Date.now() - runStatus.lastActivityAt >=
                FEISHU_PROGRESS_NOTICE_INTERVAL_MS;
              if (
                !hasNewActivity &&
                (!quiet || quietNotifiedActivityVersion === version)
              ) {
                return;
              }

              const checkpoint = projector.snapshot().progress.trim().slice(-360);
              const lines = [
                hasNewActivity
                  ? `🟢 **任务仍在运行** · 已运行 ${formatElapsed(Date.now() - startedAt)}`
                  : `🟠 **任务运行中 · 暂无新事件** · 已运行 ${formatElapsed(Date.now() - startedAt)}`,
                `最近真实任务事件：${formatElapsed(Date.now() - runStatus.lastActivityAt)}前`,
                `当前阶段：${runStatus.phase}`,
                checkpoint ? `最新检查点：${checkpoint}` : undefined,
              ]
                .filter((line): line is string => Boolean(line))
                .join("\n");

              void this.sendMarkdown(msg.chatId, lines, msg.messageId)
                .then(() => {
                  if (hasNewActivity) {
                    notifiedActivityVersion = Math.max(
                      notifiedActivityVersion,
                      version,
                    );
                  } else {
                    quietNotifiedActivityVersion = version;
                  }
                })
                .catch((err) => {
                  this.options.onLog?.(
                    `飞书进度提醒发送失败（不影响 Agent 运行）：${err instanceof Error ? err.message : String(err)}`,
                  );
                });
            }, FEISHU_PROGRESS_NOTICE_INTERVAL_MS);
            noticeTimer.unref?.();

            try {
              await consumeAgent(
                (event) => {
                  if (recordFeishuRunActivity(runStatus, event)) {
                    activityVersion += 1;
                    queueRender(true);
                  }
                },
                () => queueRender(false),
              );
            } finally {
              clearInterval(statusTimer);
              clearInterval(noticeTimer);
              // 合并队列保证旧状态先落完、最终快照最后落下，不会反向覆盖结果。
              queueRender(false);
              await writer.flush();
            }
          },
        },
        { replyTo: msg.messageId },
      );
    } catch (err) {
      // channel.stream 本身抛（多为建卡阶段就失败，markdown 回调没跑起来）→ 降级
      if (!streamAbort.signal.aborted) {
        cardBroken = true;
        this.options.onLog?.(
          `卡片建卡失败，降级为普通消息：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      this.activeAborts.delete(streamAbort);
      if (streamMessageId && !this.disconnecting) {
        this.pendingStreams.update((all) => {
          const next = { ...all };
          delete next[streamMessageId!];
          return next;
        });
      }
    }

    // 降级：仅当卡片真的报错(cardBroken)时 → 把完整结果用普通消息补发（超长自动分条）。
    // 卡片正常（哪怕很长）就不发普通消息。若 agent 还没跑过（建卡即失败），补跑一次非流式。
    if (cardBroken && !streamAbort.signal.aborted) {
      if (!agentConsumed) {
        await consumeAgent(
          () => {},
          () => {},
        );
      }
      if (streamAbort.signal.aborted) return;
      const text = `${renderFeishuRunStatus(runStatus)}\n\n---\n\n${projector.snapshot().finalText}`;
      for (const chunk of chunkMarkdown(text, FEISHU_MSG_CHUNK_CHARS)) {
        if (streamAbort.signal.aborted) return;
        await this.sendMarkdown(msg.chatId, chunk, msg.messageId).catch((err) => {
          this.options.onLog?.(
            `降级普通消息发送失败：${err instanceof Error ? err.message : String(err)}`,
          );
        });
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

  private monitorFlowBatch(
    initial: ChannelFlowBatchSnapshot,
    chatId: string,
    replyTo: string,
  ): void {
    const channel = this.channel;
    const getBatch = this.sessionIngress?.getFlowBatch;
    if (!channel || !getBatch || isTerminalChannelFlowBatch(initial)) return;
    const abortController = new AbortController();
    this.activeAborts.add(abortController);
    void channel.stream(
      chatId,
      {
        markdown: async (stream) => {
          this.pendingStreams.update((all) => ({
            ...all,
            [stream.messageId]: {
              chatId,
              sourceMessageId: replyTo,
              startedAt: new Date().toISOString(),
            },
          }));
          try {
            let snapshot = initial;
            let lastContent = "";
            while (!abortController.signal.aborted) {
              snapshot = await getBatch(initial.batchId);
              const content = formatChannelFlowBatchSnapshot(snapshot);
              if (content !== lastContent) {
                await stream.setContent(content);
                lastContent = content;
              }
              if (isTerminalChannelFlowBatch(snapshot)) return;
              await waitForBatchPoll(abortController.signal);
            }
          } finally {
            this.pendingStreams.update((all) => {
              const next = { ...all };
              delete next[stream.messageId];
              return next;
            });
          }
        },
      },
      { replyTo },
    ).catch((error) => {
      if (!abortController.signal.aborted) {
        this.options.onLog?.(
          `飞书 Flow 批量状态卡失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }).finally(() => {
      this.activeAborts.delete(abortController);
    });
  }

  /**
   * 话题群出站消息定位：带 topicId 时回贴到该话题最近一条入站消息，
   * 否则（或 Bridge 重启后话题内还没有新消息）落到群根/单聊。
   */
  private outboundSendOptions(
    chatId: string,
    topicId?: string,
  ): { replyTo: string; replyInThread: true } | undefined {
    if (!topicId) return undefined;
    const replyTo = this.lastInboundMessageId.get(
      this.chatKey(chatId, topicId),
    );
    if (!replyTo) return undefined;
    return { replyTo, replyInThread: true };
  }

  /** 出站 API：把本机文件作为文件消息发进聊天（供 Agent 内 fcb 调用） */
  async sendOutboundFile(
    chatId: string,
    rawPath: string,
    topicId?: string,
  ): Promise<string> {
    if (!this.channel) throw new Error("飞书通道未连接");
    const file = await resolveOutboundFile(rawPath);
    await this.channel.send(
      chatId,
      { file: { source: file.path, fileName: file.fileName } },
      this.outboundSendOptions(chatId, topicId),
    );
    return file.fileName;
  }

  /** 出站 API：把 markdown 消息发进聊天（供 Agent 内 fcb 调用） */
  async sendOutboundMarkdown(
    chatId: string,
    markdown: string,
    topicId?: string,
  ): Promise<void> {
    if (!this.channel) throw new Error("飞书通道未连接");
    await this.channel.send(
      chatId,
      { markdown },
      this.outboundSendOptions(chatId, topicId),
    );
  }

  async sendOutboundMention(
    chatId: string,
    ref: string,
    text: string,
    topicId?: string,
  ): Promise<void> {
    if (!this.channel) throw new Error("飞书通道未连接");
    const target = this.mentionRegistry.resolve({ chatId, topicId }, ref);
    if (!target || target.channel !== "feishu") {
      throw new Error(`当前对话不存在可通知对象：${ref}`);
    }
    await this.channel.send(
      chatId,
      { markdown: text },
      {
        ...this.outboundSendOptions(chatId, topicId),
        mentions: [
          {
            key: ref,
            openId: target.id,
            name: target.name,
            isBot: target.kind === "bot",
          },
        ],
      },
    );
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
      hint: "Start codebridge-runner on the host first",
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

/** 把会话域事件映射回 AgentEvent，并按 runId 过滤（watcher/单 run 卡片共用）。 */
async function* mapDomainToAgent(
  domain: AsyncGenerator<ChannelSessionEvent>,
  runId?: string,
): AsyncGenerator<AgentEvent> {
  for await (const event of domain) {
    if (runId && event.runId !== runId) continue;
    if (event.type === "AGENT_EVENT") {
      const agentEvent = event.payload.event as AgentEvent | undefined;
      if (agentEvent && agentEvent.type !== "done") yield agentEvent;
      continue;
    }
    if (event.type === "APPROVAL_REQUESTED") {
      yield {
        type: "permission_request",
        requestId: String(
          (event.payload as Record<string, unknown>)?.approval_id ?? "approval",
        ),
        title: "此步骤需要审批，请在 Web Workbench 中确认",
      };
      continue;
    }
    if (event.type === "RUN_SUCCEEDED") {
      yield { type: "done", exitCode: 0 };
      return;
    }
    if (
      event.type === "RUN_FAILED"
      || event.type === "RUN_CANCELLED"
      || event.type === "RUN_INTERRUPTED"
    ) {
      yield { type: "done", exitCode: 1 };
      return;
    }
  }
}
