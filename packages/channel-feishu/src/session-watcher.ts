import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type {
  AgentEvent,
  ChannelSessionEvent,
  ChannelSessionIngress,
} from "@codebridge/core";
import {
  createFeishuStreamPresenter,
  formatElapsed,
  type FeishuStreamPart,
} from "@codebridge/router";
import { CoalescingCardWriter } from "./coalescing-card-writer.js";

const FEISHU_LIVE_STATUS_INTERVAL_MS = 5 * 60_000;
const FEISHU_PROGRESS_NOTICE_INTERVAL_MS = 10 * 60_000;
const FEISHU_LIVE_PROGRESS_CHARS = 1200;

export interface FeishuLiveStatus {
  startedAt: number;
  lastActivityAt: number;
  phase: string;
}

export interface PendingFeishuStream {
  chatId: string;
  sourceMessageId: string;
  startedAt: string;
}

export interface FeishuCardHost {
  channel?: LarkChannel;
  sendMarkdown(chatId: string, markdown: string, replyTo?: string): Promise<void>;
  registerPendingStream(messageId: string, entry: PendingFeishuStream): void;
  clearPendingStream(messageId: string): void;
  log(message: string): void;
  isDisconnecting(): boolean;
}

function recordLiveActivity(
  status: FeishuLiveStatus,
  event: AgentEvent,
  now = Date.now(),
): boolean {
  let phase: string | undefined;
  switch (event.type) {
    case "thought_delta":
      phase = "分析任务";
      break;
    case "text_delta":
      phase = event.phase === "commentary" ? "任务检查点" : "生成最终回复";
      break;
    case "tool_start":
      phase = `工具执行：${event.name}`;
      break;
    case "tool_update":
      phase = event.name ? `工具执行：${event.name}` : status.phase;
      break;
    case "tool_end":
      phase = event.name ? `工具完成：${event.name}` : "工具完成";
      break;
    case "plan":
    case "plan_update":
    case "plan_removed":
      phase = "更新计划";
      break;
    case "permission_request":
      phase = "等待权限确认";
      break;
    default:
      return false;
  }
  status.lastActivityAt = now;
  status.phase = phase;
  return true;
}

function renderLiveStatus(status: FeishuLiveStatus, now = Date.now()): string {
  const sinceActivity = Math.max(0, now - status.lastActivityAt);
  const quiet = sinceActivity >= FEISHU_LIVE_STATUS_INTERVAL_MS;
  return [
    `${quiet ? "🟠 **任务连接保持**" : "🟢 **执行中**"} · 已运行 ${formatElapsed(now - status.startedAt)}`,
    `最近确认活动：${formatElapsed(sinceActivity)}前`,
    quiet ? "暂未收到新的任务事件" : `当前阶段：${status.phase}`,
  ].join("\n");
}

type CardSnapshot = { content: string; statusOnly: boolean };

/** 一个 Run 的飞书流式卡片。开卡后由 watcher 喂 AgentEvent，终态时 finalize。 */
export class FeishuRunCard {
  private readonly present: (event: AgentEvent) => FeishuStreamPart | null;
  private readonly liveStatus: FeishuLiveStatus;
  private readonly abortController: AbortController;
  private readonly cardDone: Promise<void>;
  private cardDoneResolve!: () => void;
  private readyResolve!: () => void;
  private readonly ready = new Promise<void>((resolve) => { this.readyResolve = resolve; });

  private writer?: CoalescingCardWriter<CardSnapshot>;
  private timers: Array<NodeJS.Timeout> = [];
  private resultBuffer = "";
  private thinkingContent = "";
  private progressContent = "";
  private progressMessageId?: string;
  private showLiveStatus = true;
  private activityVersion = 0;
  private notifiedActivityVersion = 0;
  private quietNotifiedActivityVersion = -1;
  private cardBroken = false;
  private streamMessageId?: string;
  private queueRender: (statusOnly: boolean) => void = () => {};
  private done = false;

  constructor(
    private readonly host: FeishuCardHost,
    private readonly chatId: string,
    private readonly sourceMessageId: string,
    readonly runId: string,
    private readonly showThinking: boolean,
  ) {
    this.present = createFeishuStreamPresenter({ showThinking }).present;
    const now = Date.now();
    this.liveStatus = { startedAt: now, lastActivityAt: now, phase: "任务启动" };
    this.abortController = new AbortController();
    this.cardDone = new Promise<void>((resolve) => { this.cardDoneResolve = resolve; });
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get cardMessageId(): string | undefined {
    return this.streamMessageId;
  }

  async open(): Promise<void> {
    if (!this.host.channel) return;
    void this.host.channel.stream(
      this.chatId,
      {
        markdown: async (s) => {
          this.streamMessageId = s.messageId;
          this.host.registerPendingStream(s.messageId, {
            chatId: this.chatId,
            sourceMessageId: this.sourceMessageId,
            startedAt: new Date().toISOString(),
          });
          if (this.abortController.signal.aborted) {
            this.cardDoneResolve();
            return;
          }
          this.thinkingContent = this.showThinking ? "_思考中…_" : "";

          const renderBody = (): string => {
            if (!this.showLiveStatus && this.resultBuffer) {
              return this.thinkingContent
                ? `${this.thinkingContent}\n\n---\n\n${this.resultBuffer}`
                : this.resultBuffer;
            }
            const sections: string[] = [];
            if (this.thinkingContent) sections.push(this.thinkingContent);
            if (this.progressContent) {
              sections.push(`**最新进度**\n${this.progressContent}`);
            }
            if (this.resultBuffer) sections.push(this.resultBuffer);
            return sections.join("\n\n---\n\n");
          };

          this.writer = new CoalescingCardWriter<CardSnapshot>(
            async (snapshot) => {
              if (this.cardBroken || this.abortController.signal.aborted) return;
              try {
                await s.setContent(snapshot.content);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (snapshot.statusOnly) {
                  this.host.log(`飞书任务状态刷新失败（不影响 Agent 运行）：${message}`);
                  return;
                }
                this.cardBroken = true;
                this.host.log(`卡片流式失败，降级为普通消息：${message}`);
              }
            },
            undefined,
            (pending, next) => ({
              ...next,
              statusOnly: pending.statusOnly && next.statusOnly,
            }),
          );

          this.queueRender = (statusOnly: boolean): void => {
            const status = this.showLiveStatus
              ? renderLiveStatus(this.liveStatus)
              : "";
            const body = renderBody();
            this.writer?.enqueue({
              content: status && body ? `${status}\n\n---\n\n${body}` : status || body,
              statusOnly,
            });
          };

          this.queueRender(false);

          const statusTimer = setInterval(() => {
            if (this.abortController.signal.aborted) return;
            this.queueRender(true);
          }, FEISHU_LIVE_STATUS_INTERVAL_MS);
          this.timers.push(statusTimer);

          const noticeTimer = setInterval(() => {
            if (this.abortController.signal.aborted) return;
            const version = this.activityVersion;
            const hasNewActivity = version > this.notifiedActivityVersion;
            const quiet =
              Date.now() - this.liveStatus.lastActivityAt >=
              FEISHU_PROGRESS_NOTICE_INTERVAL_MS;
            if (!hasNewActivity && (!quiet || this.quietNotifiedActivityVersion === version)) {
              return;
            }
            const checkpoint = this.progressContent.trim().slice(-360);
            const lines = [
              hasNewActivity
                ? `🟢 **任务仍在运行** · 已运行 ${formatElapsed(Date.now() - this.liveStatus.startedAt)}`
                : `🟠 **会话仍连接，但暂无新任务事件** · 已运行 ${formatElapsed(Date.now() - this.liveStatus.startedAt)}`,
              `最近真实任务事件：${formatElapsed(Date.now() - this.liveStatus.lastActivityAt)}前`,
              `当前阶段：${this.liveStatus.phase}`,
              checkpoint ? `最新检查点：${checkpoint}` : undefined,
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n");
            void this.host
              .sendMarkdown(this.chatId, lines, this.sourceMessageId)
              .then(() => {
                if (hasNewActivity) {
                  this.notifiedActivityVersion = Math.max(this.notifiedActivityVersion, version);
                } else {
                  this.quietNotifiedActivityVersion = version;
                }
              })
              .catch((err) => {
                this.host.log(
                  `飞书进度提醒发送失败（不影响 Agent 运行）：${err instanceof Error ? err.message : String(err)}`,
                );
              });
          }, FEISHU_PROGRESS_NOTICE_INTERVAL_MS);
          this.timers.push(noticeTimer);
          noticeTimer.unref?.();

          this.readyResolve();
          await this.cardDone;
        },
      },
      { replyTo: this.sourceMessageId },
    ).catch((err) => {
      this.host.log(
        `卡片建卡失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.readyResolve();
      this.cardDoneResolve();
    });
    await this.ready;
  }

  async onAgentEvent(event: AgentEvent): Promise<void> {
    await this.ready;
    if (this.abortController.signal.aborted) return;
    if (recordLiveActivity(this.liveStatus, event)) this.activityVersion += 1;
    if (event.type === "permission_request") {
      void this.host
        .sendMarkdown(
          this.chatId,
          `🔐 Agent 请求权限：**${event.title}**`,
          this.sourceMessageId,
        )
        .catch(() => {});
      return;
    }
    const part = this.present(event);
    if (!part) return;
    if (part.zone === "thinking") {
      this.thinkingContent += part.text;
      this.queueRender(false);
    } else if (part.zone === "progress") {
      if (
        part.messageId
        && this.progressMessageId
        && part.messageId !== this.progressMessageId
      ) {
        this.progressContent = "";
      }
      if (part.messageId) this.progressMessageId = part.messageId;
      this.progressContent = (this.progressContent + part.text).slice(
        -FEISHU_LIVE_PROGRESS_CHARS,
      );
      this.queueRender(false);
    } else {
      this.resultBuffer += part.text;
      this.queueRender(false);
    }
  }

  async finalize(): Promise<void> {
    await this.ready;
    if (this.done) return;
    this.done = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.showLiveStatus = false;
    this.queueRender(false);
    await this.writer?.flush();
    if (this.streamMessageId && !this.host.isDisconnecting()) {
      this.host.clearPendingStream(this.streamMessageId);
    }
    this.cardDoneResolve();
  }

  abort(): void {
    if (this.done) return;
    this.done = true;
    this.abortController.abort();
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.cardDoneResolve();
  }
}

export interface PendingTurn {
  turnId: string;
  chatId: string;
  sourceMessageId: string;
  showThinking: boolean;
}

/** 每 Session 一个持久 events 订阅，单订阅统一路由 Turn / Run / Delivery。 */
export class FeishuSessionWatcher {
  private readonly abortController = new AbortController();
  private afterSequence = 0;
  private started = false;
  private readonly cards = new Map<string, FeishuRunCard>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly deliveries = new Map<
    string,
    { turnId: string; owner: string }
  >();
  private readonly fatalAgentErrorRuns = new Set<string>();

  constructor(
    private readonly host: FeishuCardHost,
    private readonly ingress: ChannelSessionIngress,
    private readonly sessionId: string,
    private readonly instanceId: string,
  ) {}

  /** 注入初始 cursor 后再启动，避免启动后登记 pending Turn/开卡前消费事件。 */
  start(afterSequence: number): void {
    if (this.started) return;
    this.started = true;
    this.afterSequence = afterSequence;
    void this.run().catch((err) => {
      this.host.log(
        `session watcher 退出: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  registerPendingTurn(turnId: string, turn: PendingTurn): void {
    this.pendingTurns.set(turnId, turn);
  }

  /** 恢复 delivering 状态：卡片已存在/表面 ID 已写，只登记 run→delivery 终态完成映射。 */
  registerTerminalDelivery(
    runId: string,
    turnId: string,
    owner: string,
  ): void {
    this.deliveries.set(runId, { turnId, owner });
  }

  async openCardForRun(runId: string, turn: PendingTurn): Promise<void> {
    if (this.cards.has(runId)) return;
    const card = new FeishuRunCard(
      this.host,
      turn.chatId,
      turn.sourceMessageId,
      runId,
      turn.showThinking,
    );
    this.cards.set(runId, card);
    const owner = `feishu:${this.instanceId}:${runId}`;
    try {
      const claimed = await this.ingress.claimDelivery(turn.turnId, owner);
      if (!claimed) {
        this.cards.delete(runId);
        return;
      }
      await card.open();
      const cardId = card.cardMessageId;
      if (cardId) {
        const acked = await this.ingress.ackDelivery(
          turn.turnId,
          owner,
          cardId,
        );
        if (!acked) {
          throw new Error(`ack delivery failed for run ${runId}`);
        }
      }
      this.deliveries.set(runId, { turnId: turn.turnId, owner });
    } catch (err) {
      this.cards.delete(runId);
      throw err;
    }
  }

  private async run(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      try {
        for await (const event of this.ingress.events(this.sessionId, {
          afterSequence: this.afterSequence,
          signal: this.abortController.signal,
        })) {
          await this.handle(event);
          // 状态转换成功后才推进 cursor；失败会抛错并由外层按旧 cursor 重连重放。
          this.afterSequence = event.sequence;
        }
      } catch (err) {
        if (this.abortController.signal.aborted) return;
        this.host.log(
          `session watcher 断线，按 sequence ${this.afterSequence} 重连：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  private async handle(event: ChannelSessionEvent): Promise<void> {
    if (event.type === "TURN_DISPATCHED" && event.runId && event.target) {
      const turn = this.pendingTurns.get(event.target);
      if (turn) {
        await this.openCardForRun(event.runId, turn);
        this.pendingTurns.delete(event.target);
      }
      return;
    }
    if (event.type === "AGENT_EVENT" && event.runId) {
      const card = this.cards.get(event.runId);
      const agentEvent = event.payload.event as AgentEvent | undefined;
      if (agentEvent?.type === "error" && agentEvent.fatal && event.runId) {
        this.fatalAgentErrorRuns.add(event.runId);
      }
      if (card && agentEvent && agentEvent.type !== "done") {
        await card.onAgentEvent(agentEvent);
      }
      return;
    }
    if (event.type === "STEP_FAILED" && event.runId) {
      if (!this.fatalAgentErrorRuns.has(event.runId)) {
        const card = this.cards.get(event.runId);
        const message = String(
          (event.payload as Record<string, unknown>)?.error ?? "Step failed",
        );
        if (card) await card.onAgentEvent({ type: "error", message });
      }
      return;
    }
    if (
      (event.type === "RUN_SUCCEEDED"
        || event.type === "RUN_FAILED"
        || event.type === "RUN_CANCELLED"
        || event.type === "RUN_INTERRUPTED")
      && event.runId
    ) {
      const card = this.cards.get(event.runId);
      if (card) {
        this.cards.delete(event.runId);
        await card.finalize();
      }
      const delivery = this.deliveries.get(event.runId);
      if (delivery) {
        const completed = await this.ingress.completeDelivery(
          delivery.turnId,
          delivery.owner,
        );
        if (completed) {
          this.deliveries.delete(event.runId);
        } else {
          throw new Error(
            `complete delivery returned false for run ${event.runId}`,
          );
        }
      }
    }
  }

  abort(): void {
    this.abortController.abort();
    for (const card of this.cards.values()) card.abort();
    this.cards.clear();
    this.pendingTurns.clear();
  }
}
