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
  formatElapsed,
  formatWelcomeMessage,
  handleSlashCommand,
} from "@feishu-code-bridge/router";
import { registerFeishuExtraEvents } from "./feishu-extra-events.js";
import { ChainTopicTracker } from "./chain-topics.js";
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

export interface FeishuMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  content: string;
  threadId?: string;
  /** 回复串的串首消息 id（普通群回复时有值） */
  rootId?: string;
  /** 被直接回复（引用）的消息 id */
  replyToMessageId?: string;
  mentionedBot?: boolean;
  attachments?: RunAttachment[];
}

export interface FeishuBridgeOptions {
  config: AppConfig;
  dataDir: string;
  onLog?: (msg: string) => void;
}

/** 降级时单条普通消息的最大字符数；结果超过就用 chunkMarkdown 分条发，避免撞飞书消息长度上限 */
const FEISHU_MSG_CHUNK_CHARS = 12000;

/** 忙时最多排队多少条消息（合并成一条 prompt 发出，防无限堆积） */
const PENDING_PROMPTS_MAX = 5;

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

export class FeishuBridge {
  private channel?: LarkChannel;
  private orchestrator: RunOrchestrator;
  private config: AppConfig;
  /** 中断同会话内仍在进行的流式回复（斜杠命令需抢占） */
  private readonly chatStreamAbort = new Map<string, AbortController>();
  /** 忙时排队的消息（chatKey → 待发文本 + 最后一条消息作回复锚点），本轮结束自动派发 */
  private readonly pendingPrompts = new Map<
    string,
    { texts: string[]; lastMsg: FeishuMessage }
  >();
  /** chat|topic → 最近一条入站消息 id（出站消息回贴话题用） */
  private readonly lastInboundMessageId = new Map<string, string>();
  /** 普通群回复串 → 会话 topic 映射 */
  private readonly chainTopics = new ChainTopicTracker();
  /** bot 已参与过的话题（内存；重启后由 sessions.json 续上） */
  private readonly botParticipatedTopics = new Set<string>();

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
    rootId?: string;
    replyToMessageId?: string;
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
      rootId: msg.rootId,
      replyToMessageId: msg.replyToMessageId,
      mentionedBot: msg.mentionedBot,
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
          Boolean(
            this.orchestrator.router.getSessionRecord(
              this.orchestrator.router.buildSessionKey(msg.chatId, topicId),
            )?.cliSessionId,
          ),
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

    const slash = await handleSlashCommand({
      chatId: msg.chatId,
      topicId,
      senderId: msg.senderId,
      text: msg.content,
      config: this.config,
      router: this.orchestrator.router,
      listCliSessions: (options) =>
        this.orchestrator.listCliSessions(msg.chatId, topicId, options),
      bindCliSession: (sessionId) =>
        this.orchestrator.bindCliSession(msg.chatId, topicId, sessionId),
      listConfigOptions: () =>
        this.orchestrator.listConfigOptions(msg.chatId, topicId),
      cancelActiveRun: () =>
        this.orchestrator.cancelActiveForChat(msg.chatId, topicId),
      hasActiveRun: () =>
        this.orchestrator.hasActiveRun(msg.chatId, topicId),
      activeRunElapsedMs: () =>
        this.orchestrator.activeRunElapsedMs(msg.chatId, topicId),
    });

    if (slash?.type === "reply") {
      const cmd = msg.content.trim().split(/\s+/)[0]?.toLowerCase();
      // 只有 /stop /cancel 打断正在跑的任务（其取消由各自 handler 通过 cancelActiveRun 完成，
      // 这里补 abortChatStream 让卡片立即收尾）。其余 reply 命令（/status /model /effort
      // /permission /help /cd /backend …）绝不打断运行中的任务——尤其 /status 是查进度用的。
      // 之前这里无差别 abort + cancelActiveForChat，会把长任务连同一次 /status 查询一起杀掉。
      if (cmd === "/stop" || cmd === "/cancel") {
        this.abortChatStream(msg.chatId, topicId);
        // 用户主动中断 = 排队的后续消息也一并作废
        this.pendingPrompts.delete(this.chatKey(msg.chatId, topicId));
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

    // 已有任务在跑时，新消息不打断——排队暂存，本轮结束后自动作为下一条 prompt 发送
    //（借鉴 codeg 的 pending_prompt）。/stop 中断当前任务并清空队列。
    const activeElapsedMs = this.orchestrator.activeRunElapsedMs(
      msg.chatId,
      topicId,
    );
    if (activeElapsedMs !== undefined) {
      const key = this.chatKey(msg.chatId, topicId);
      const entry = this.pendingPrompts.get(key) ?? { texts: [], lastMsg: msg };
      if (entry.texts.length >= PENDING_PROMPTS_MAX) {
        await this.sendMarkdown(
          msg.chatId,
          `⏳ 排队消息已达 ${PENDING_PROMPTS_MAX} 条上限，本条未入队；请等当前任务（已运行 ${formatElapsed(activeElapsedMs)}）结束，或发送 \`/stop\` 中断。`,
          msg.messageId,
        ).catch(() => {});
        return;
      }
      entry.texts.push(agentPrompt);
      entry.lastMsg = msg;
      this.pendingPrompts.set(key, entry);
      await this.sendMarkdown(
        msg.chatId,
        `⏳ 当前任务进行中（已运行 ${formatElapsed(activeElapsedMs)}），消息已排队（第 ${entry.texts.length} 条），本轮结束后自动发送；\`/status\` 查进度，\`/stop\` 中断并清空队列。`,
        msg.messageId,
      ).catch(() => {});
      return;
    }

    await this.dispatchToAgent(msg, agentPrompt, topicId);
  }

  /** 组装话题/引用上下文并启动 agent 流式回复；结束后自动派发排队消息 */
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
    const finalPrompt = contextPrefix
      ? `${contextPrefix}\n\n${agentPrompt}`
      : agentPrompt;

    if (topicId) this.botParticipatedTopics.add(topicId);

    void this.streamAgentReply(msg, finalPrompt, topicId)
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
      })
      .finally(() => {
        this.flushPendingPrompts(msg.chatId, topicId);
      });
  }

  /** 上一轮结束后，把排队消息合并成下一条 prompt 自动发出（递归 finally 链保证连续排队也能依次跑完） */
  private flushPendingPrompts(chatId: string, topicId: string | undefined): void {
    const key = this.chatKey(chatId, topicId);
    const entry = this.pendingPrompts.get(key);
    if (!entry || entry.texts.length === 0) {
      this.pendingPrompts.delete(key);
      return;
    }
    this.pendingPrompts.delete(key);
    const combined = entry.texts.join("\n\n");
    void this.sendMarkdown(
      chatId,
      `▶️ 上一任务已结束，自动发送排队的 ${entry.texts.length} 条消息`,
      entry.lastMsg.messageId,
    ).catch(() => {});
    void this.dispatchToAgent(entry.lastMsg, combined, topicId);
  }

  private async streamAgentReply(
    msg: FeishuMessage,
    prompt: string,
    topicId: string | undefined,
  ): Promise<void> {
    if (!this.channel) return;

    const key = this.chatKey(msg.chatId, topicId);
    this.abortChatStream(msg.chatId, topicId);
    void this.orchestrator
      .cancelActiveForChat(msg.chatId, topicId)
      .catch(() => {});

    const streamAbort = new AbortController();
    this.chatStreamAbort.set(key, streamAbort);

    const { present } = createFeishuStreamPresenter();
    let resultBuffer = ""; // 结果区累积；卡片挂了/被截断就用它降级发普通消息
    let agentConsumed = false; // 已消费过 agent 事件流？（避免降级时重复跑）
    let cardBroken = false; // 飞书卡片流式失败（如 11310 cardid invalid）→ 降级

    // 消费一次 agent 事件流：thinking / result 分别交给回调；result 同时累积进 buffer。
    const consumeAgent = async (
      onThinking: (t: string) => Promise<void>,
      onResult: (t: string) => Promise<void>,
    ): Promise<void> => {
      agentConsumed = true;
      try {
        for await (const event of this.orchestrator.runAgent(
          msg.chatId,
          topicId,
          prompt,
          msg.attachments,
        )) {
          if (streamAbort.signal.aborted) return;
          const part = present(event);
          if (!part) continue;
          if (part.zone === "thinking") {
            await onThinking(part.text);
          } else {
            resultBuffer += part.text;
            await onResult(part.text);
          }
        }
      } catch (err) {
        if (streamAbort.signal.aborted) return;
        if (err instanceof Error && err.name === "AbortError") {
          await onResult("\n\n⏹ 已停止\n");
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        resultBuffer += `\n❌ ${message}\n`;
        await onResult(`\n❌ ${message}\n`);
      }
    };

    try {
      await this.channel.stream(
        msg.chatId,
        {
          markdown: async (s) => {
            if (streamAbort.signal.aborted) return;
            // 卡片写操作包一层：只有真报错才标记 cardBroken 并降级——之后不再碰卡片，
            // 让 consumeAgent 继续累积 resultBuffer，收尾时用普通消息补发完整结果。
            // 不主动截断超长卡片：卡片正常（哪怕很长）就一直流，不发普通消息。
            const safeAppend = async (text: string): Promise<void> => {
              if (cardBroken || streamAbort.signal.aborted) return;
              try {
                await s.append(text);
              } catch (err) {
                cardBroken = true;
                this.options.onLog?.(
                  `卡片流式失败，降级为普通消息：${err instanceof Error ? err.message : String(err)}`,
                );
              }
            };
            await safeAppend("_思考中…_");
            let resultStarted = false;
            await consumeAgent(
              (t) => safeAppend(t),
              async (t) => {
                if (!resultStarted) {
                  await safeAppend("\n\n---\n\n");
                  resultStarted = true;
                }
                await safeAppend(t);
              },
            );
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
      if (this.chatStreamAbort.get(key) === streamAbort) {
        this.chatStreamAbort.delete(key);
      }
    }

    // 降级：仅当卡片真的报错(cardBroken)时 → 把完整结果用普通消息补发（超长自动分条）。
    // 卡片正常（哪怕很长）就不发普通消息。若 agent 还没跑过（建卡即失败），补跑一次非流式。
    if (cardBroken && !streamAbort.signal.aborted) {
      if (!agentConsumed) {
        await consumeAgent(
          async () => {},
          async () => {},
        );
      }
      if (streamAbort.signal.aborted) return;
      const text = resultBuffer.trim() || "（本次无输出）";
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
