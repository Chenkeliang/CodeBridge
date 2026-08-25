import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type {
  AgentEvent,
  ChannelDeliveryRow,
  ChannelDeliveryRunSnapshot,
  ChannelSessionEvent,
  ChannelSessionIngress,
} from "@codebridge/core";
import {
  createChannelFlowProjector,
  createChannelStreamProjector,
  renderChannelFlowFinal,
  renderChannelFlowLive,
  type ChannelFlowProjector,
  type ChannelStreamProjector,
} from "@codebridge/router";
import { CoalescingCardWriter } from "./coalescing-card-writer.js";
import {
  applyRunSnapshot,
  createFeishuRunStatus,
  finishFeishuRunStatus,
  recordFeishuRunActivity,
  recordRunVerificationFailure,
  renderFeishuRunStatus,
  setCoreEventStream,
  setHttpWrite,
  setInboundWebSocket,
  type FeishuConnectionState,
  type FeishuRunState,
  type FeishuRunStatus,
} from "./run-status.js";

export const FEISHU_LIVE_STATUS_TICK_MS = 15_000;
export { FEISHU_LIVE_STATUS_QUIET_MS } from "./run-status.js";
const FEISHU_LIVE_PROGRESS_CHARS = 1200;
const FEISHU_FLOW_SAVE_REQUEST_NOTICE =
  "已记录“存为 Flow”请求。请前往 Web 确认；尚未创建 Candidate。";

export function classifyFeishuCardWriteError(
  error: unknown,
): "transient" | "permanent" {
  const text = error instanceof Error ? error.message : String(error);
  return /11310|card\s*id\s*invalid|cardid\s*invalid/i.test(text)
    ? "permanent"
    : "transient";
}

export interface PendingFeishuStream {
  chatId: string;
  sourceMessageId: string;
  startedAt: string;
}

export interface FeishuCardHost {
  channel?: LarkChannel;
  sendMarkdown(chatId: string, markdown: string, replyTo?: string): Promise<void>;
  resolveCardId?(messageId: string): Promise<string>;
  /** Update the CardKit instance itself, never the referencing IM message. */
  updateCard(cardId: string, card: object): Promise<void>;
  registerPendingStream(messageId: string, entry: PendingFeishuStream): void;
  clearPendingStream(messageId: string): void;
  log(message: string): void;
  isDisconnecting(): boolean;
}

function markdownCard(content: string): object {
  return {
    schema: "2.0",
    body: {
      elements: [{ tag: "markdown", content }],
    },
  };
}

type CardSnapshot = { content: string; statusOnly: boolean };

function isStructuredFlowEvent(type: string): boolean {
  return type === "STEP_STARTED"
    || type === "STEP_SUCCEEDED"
    || type === "STEP_FAILED"
    || type === "STEP_RETRYING"
    || type === "STEP_SKIPPED"
    || type === "ARTIFACT_CREATED"
    || type === "VERIFICATION_FAILED"
    || type === "RUN_SNAPSHOT"
    || type === "APPROVAL_REQUESTED"
    || type === "APPROVAL_GRANTED"
    || type === "APPROVAL_REJECTED"
    || type === "FLOW_BATCH_DRAFTED"
    || type === "FLOW_BATCH_CONFIRMED"
    || type === "FLOW_BATCH_UPDATED"
    || type === "FLOW_BATCH_COMPLETED";
}

function composeFeishuRunBody(
  agentText: string,
  flowText: string,
  flowSaveRequested = false,
): string {
  return [
    agentText || undefined,
    flowText || undefined,
    flowSaveRequested ? FEISHU_FLOW_SAVE_REQUEST_NOTICE : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n---\n\n");
}

function terminalStateForEvent(
  type: ChannelSessionEvent["type"],
): Exclude<FeishuRunState, "running"> | undefined {
  switch (type) {
    case "RUN_SUCCEEDED":
      return "succeeded";
    case "RUN_FAILED":
      return "failed";
    case "RUN_CANCELLED":
      return "cancelled";
    case "RUN_INTERRUPTED":
      return "interrupted";
    default:
      return undefined;
  }
}

/** 一个 Run 的飞书流式卡片。开卡后由 watcher 喂 AgentEvent，终态时 finalize。 */
export class FeishuRunCard {
  private readonly projector: ChannelStreamProjector;
  private readonly flowProjector: ChannelFlowProjector;
  private readonly runStatus: FeishuRunStatus;
  private readonly abortController: AbortController;
  private readonly cardDone: Promise<void>;
  private cardDoneResolve!: () => void;
  private readyResolve!: () => void;
  private readonly ready = new Promise<void>((resolve) => { this.readyResolve = resolve; });

  private writer?: CoalescingCardWriter<CardSnapshot>;
  private lastWriteError?: unknown;
  private streamMessageId?: string;
  private streamCardId?: string;
  private queueRender: (statusOnly: boolean) => void = () => {};
  private done = false;
  private flowSaveRequested = false;

  constructor(
    private readonly host: FeishuCardHost,
    private readonly chatId: string,
    private readonly sourceMessageId: string,
    readonly runId: string,
    showThinking: boolean,
  ) {
    this.projector = createChannelStreamProjector({
      showThinking,
      maxProgressChars: FEISHU_LIVE_PROGRESS_CHARS,
    });
    this.flowProjector = createChannelFlowProjector();
    this.runStatus = createFeishuRunStatus();
    this.abortController = new AbortController();
    this.cardDone = new Promise<void>((resolve) => { this.cardDoneResolve = resolve; });
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get cardMessageId(): string | undefined {
    return this.streamMessageId;
  }

  get cardInstanceId(): string | undefined {
    return this.streamCardId;
  }

  async open(): Promise<void> {
    if (!this.host.channel) return;
    void this.host.channel.stream(
      this.chatId,
      {
        markdown: async (s) => {
          const cardId = (s as unknown as { cardId?: unknown }).cardId;
          if (typeof cardId === "string" && cardId) {
            this.streamCardId = cardId;
          }
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
          this.writer = new CoalescingCardWriter<CardSnapshot>(
            async (snapshot) => {
              if (this.abortController.signal.aborted) return;
              try {
                await s.setContent(snapshot.content);
                this.lastWriteError = undefined;
                setHttpWrite(this.runStatus, "healthy");
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                setHttpWrite(this.runStatus, "degraded");
                if (snapshot.statusOnly) {
                  this.host.log(`飞书任务状态刷新失败（不影响 Agent 运行）：${message}`);
                  return;
                }
                this.lastWriteError = err;
                this.host.log(`飞书卡片内容写入失败，等待重放：${message}`);
                throw err;
              }
            },
            undefined,
            (pending, next) => ({
              ...next,
              statusOnly: pending.statusOnly && next.statusOnly,
            }),
          );

          this.queueRender = (statusOnly: boolean): void => {
            const status = renderFeishuRunStatus(this.runStatus);
            const snapshot = this.projector.snapshot();
            const flowSnapshot = this.flowProjector.snapshot();
            const flowText = this.runStatus.state === "running"
              ? renderChannelFlowLive(flowSnapshot)
              : renderChannelFlowFinal(flowSnapshot);
            const agentText = this.runStatus.state === "running"
              ? snapshot.liveText
              : flowText && !snapshot.result.trim()
                ? ""
                : snapshot.finalText;
            const body = composeFeishuRunBody(
              agentText,
              flowText,
              this.flowSaveRequested,
            );
            this.writer?.enqueue({
              content: status && body ? `${status}\n\n---\n\n${body}` : status || body,
              statusOnly,
            });
          };

          this.queueRender(false);

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
    const recorded = recordFeishuRunActivity(this.runStatus, event);
    if (event.type === "permission_request") {
      void this.host
        .sendMarkdown(
          this.chatId,
          `🔐 Agent 请求权限：**${event.title}**`,
          this.sourceMessageId,
        )
        .catch(() => {});
      if (recorded) this.queueRender(true);
      return;
    }
    const previous = this.projector.snapshot().liveText;
    const next = this.projector.apply(event);
    this.queueRender(previous === next.liveText);
  }

  async onDomainEvent(event: ChannelSessionEvent): Promise<void> {
    await this.ready;
    if (this.abortController.signal.aborted || !isStructuredFlowEvent(event.type)) return;
    const previous = renderChannelFlowLive(this.flowProjector.snapshot());
    const next = this.flowProjector.apply(event);
    const current = renderChannelFlowLive(next);
    this.queueRender(previous === current);
  }

  async onFlowSaveRequested(): Promise<void> {
    await this.ready;
    if (this.abortController.signal.aborted || this.flowSaveRequested) return;
    this.flowSaveRequested = true;
    this.queueRender(false);
  }

  async reconcileRun(
    snapshot: ChannelDeliveryRunSnapshot,
    inboundState: FeishuConnectionState,
  ): Promise<void> {
    await this.ready;
    if (this.abortController.signal.aborted) return;
    setInboundWebSocket(this.runStatus, inboundState);
    applyRunSnapshot(this.runStatus, snapshot);
    this.queueRender(false);
    await this.writer?.flush();
    if (this.runStatus.state !== "running" && this.lastWriteError) {
      throw this.lastWriteError;
    }
  }

  async setCoreEventStreamState(state: FeishuConnectionState): Promise<void> {
    await this.ready;
    if (this.abortController.signal.aborted) return;
    setCoreEventStream(this.runStatus, state);
    this.queueRender(true);
    await this.writer?.flush();
  }

  async setInboundWebSocketState(state: FeishuConnectionState): Promise<void> {
    await this.ready;
    if (this.abortController.signal.aborted) return;
    setInboundWebSocket(this.runStatus, state);
    this.queueRender(true);
    await this.writer?.flush();
  }

  async finalize(
    terminalState: Exclude<FeishuRunState, "running">,
  ): Promise<void> {
    await this.ready;
    if (this.done) return;
    finishFeishuRunStatus(this.runStatus, terminalState);
    this.queueRender(false);
    await this.writer?.flush();
    if (this.lastWriteError) throw this.lastWriteError;
    this.done = true;
    if (this.streamMessageId && !this.host.isDisconnecting()) {
      this.host.clearPendingStream(this.streamMessageId);
    }
    this.cardDoneResolve();
  }

  abort(): void {
    if (this.done) return;
    this.done = true;
    this.abortController.abort();
    this.cardDoneResolve();
  }
}

export interface PendingTurn {
  turnId: string;
  chatId: string;
  sourceMessageId: string;
  showThinking: boolean;
}

interface ResumedFeishuCard {
  surfaceMessageId: string;
  surfaceCardId: string;
  projector: ChannelStreamProjector;
  flowProjector: ChannelFlowProjector;
  runStatus: FeishuRunStatus;
  resultRecovery: "pending" | "confirmed";
  projectedSequences: Set<number>;
  flowSaveRequested: boolean;
}

function isTerminalRunSnapshot(
  snapshot: ChannelDeliveryRunSnapshot | null,
): boolean {
  return snapshot !== null
    && snapshot.status !== "queued"
    && snapshot.status !== "running"
    && snapshot.status !== "waiting";
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
  private readonly resumedCards = new Map<string, ResumedFeishuCard>();
  private readonly fatalAgentErrorRuns = new Set<string>();
  private readonly permanentlyInvalidCardIds = new Set<string>();
  private readonly loggedPermanentCardIds = new Set<string>();

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

  /** 恢复 delivering 状态：按 surfaceMessageId 重放事件投影最终回答，终态更新原卡片。 */
  resumeCardForRun(
    runId: string,
    surfaceMessageId: string,
    turnId: string,
    owner: string,
    showThinking: boolean,
    surfaceCardId: string,
  ): void {
    const existing = this.resumedCards.get(runId);
    if (existing) {
      this.deliveries.set(runId, { turnId, owner });
      return;
    }
    const runStatus = createFeishuRunStatus();
    this.resumedCards.set(runId, {
      surfaceMessageId,
      surfaceCardId,
      projector: createChannelStreamProjector({
        showThinking,
        maxProgressChars: FEISHU_LIVE_PROGRESS_CHARS,
      }),
      flowProjector: createChannelFlowProjector(),
      runStatus,
      resultRecovery: "pending",
      projectedSequences: new Set<number>(),
      flowSaveRequested: false,
    });
    this.deliveries.set(runId, { turnId, owner });
  }

  async reconcileDelivery(
    delivery: ChannelDeliveryRow,
    turn: PendingTurn,
    inboundState: FeishuConnectionState,
  ): Promise<void> {
    if (
      delivery.surfaceCardId &&
      this.permanentlyInvalidCardIds.has(delivery.surfaceCardId)
    ) {
      return;
    }
    if (!delivery.runId) {
      this.registerPendingTurn(delivery.turnId, turn);
      return;
    }

    if (!delivery.surfaceMessageId) {
      await this.openCardForRun(delivery.runId, turn);
    } else {
      let surfaceCardId = delivery.surfaceCardId;
      if (!surfaceCardId) {
        try {
          if (!this.host.resolveCardId) {
            throw new Error("CardKit id resolver is unavailable");
          }
          surfaceCardId = await this.host.resolveCardId(
            delivery.surfaceMessageId,
          );
          const persisted = await this.ingress.ackDelivery(
            delivery.turnId,
            delivery.claimOwner ?? "",
            delivery.surfaceMessageId,
            surfaceCardId,
          );
          if (!persisted) {
            throw new Error("resolved CardKit id could not be persisted");
          }
        } catch (error) {
          this.host.log(JSON.stringify({
            event: "feishu_card_id_recovery_failed",
            channel: "feishu",
            sessionId: this.sessionId,
            runId: delivery.runId,
            surfaceMessageId: delivery.surfaceMessageId,
            message: error instanceof Error ? error.message : String(error),
          }));
          return;
        }
      }
      this.resumeCardForRun(
        delivery.runId,
        delivery.surfaceMessageId,
        delivery.turnId,
        delivery.claimOwner ?? "",
        turn.showThinking,
        surfaceCardId,
      );
    }

    const card = this.cards.get(delivery.runId);
    if (card) {
      try {
        await card.setInboundWebSocketState(inboundState);
        if (delivery.runSnapshot) {
          await card.reconcileRun(delivery.runSnapshot, inboundState);
        }
      } catch (error) {
        const messageId = card.cardMessageId;
        if (messageId && this.recordPermanentCardFailure(
          delivery.runId,
          messageId,
          error,
        )) {
          card.abort();
          this.cards.delete(delivery.runId);
          return;
        }
        throw error;
      }
    }

    const resumed = this.resumedCards.get(delivery.runId);
    if (resumed) {
      setInboundWebSocket(resumed.runStatus, inboundState);
      const terminal = isTerminalRunSnapshot(delivery.runSnapshot);
      if (terminal) {
        await this.restorePersistedResult(delivery, resumed);
      }
      if (delivery.runSnapshot) {
        applyRunSnapshot(resumed.runStatus, delivery.runSnapshot);
        if (
          (delivery.runSnapshot.status === "running" ||
            delivery.runSnapshot.status === "waiting") &&
          delivery.runSnapshot.sessionActiveRunId !== delivery.runId
        ) {
          recordRunVerificationFailure(
            resumed.runStatus,
            "Run 与 Session activeRun 不一致",
          );
        }
      }
      const written = await this.writeResumedCard(delivery.runId, resumed);
      if (terminal && resumed.resultRecovery === "confirmed" && written) {
        await this.completeDeliveryForRun(delivery.runId);
      }
    }
  }

  private async restorePersistedResult(
    delivery: ChannelDeliveryRow,
    resumed: ResumedFeishuCard,
  ): Promise<void> {
    if (resumed.resultRecovery === "confirmed") return;
    if (!delivery.runId || !this.ingress.replayEvents) {
      this.logResultRecoveryFailure(delivery, "finite replay is unavailable");
      return;
    }
    try {
      const events = await this.ingress.replayEvents(delivery.sessionId, {
        afterSequence: delivery.acceptedSequence,
      });
      for (const event of events) {
        this.applyRecoveredEvent(delivery.runId, resumed, event);
      }
      const expectedTerminalState = delivery.runSnapshot?.status;
      const hasMatchingTerminalEvent = events.some((event) =>
        event.runId === delivery.runId
        && terminalStateForEvent(event.type) === expectedTerminalState
      );
      if (!hasMatchingTerminalEvent) {
        this.logResultRecoveryFailure(
          delivery,
          "matching terminal event is missing from finite replay",
        );
        return;
      }
      resumed.resultRecovery = "confirmed";
    } catch (error) {
      this.logResultRecoveryFailure(
        delivery,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private applyRecoveredEvent(
    runId: string,
    resumed: ResumedFeishuCard,
    event: ChannelSessionEvent,
  ): void {
    if (
      event.runId !== runId
      || resumed.projectedSequences.has(event.sequence)
    ) return;
    if (event.type === "FLOW_SAVE_REQUESTED") {
      resumed.flowSaveRequested = true;
      resumed.projectedSequences.add(event.sequence);
      return;
    }
    if (event.type === "AGENT_EVENT") {
      const agentEvent = event.payload.event as AgentEvent | undefined;
      if (!agentEvent) return;
      if (agentEvent.type === "error" && agentEvent.fatal) {
        this.fatalAgentErrorRuns.add(runId);
      }
      recordFeishuRunActivity(resumed.runStatus, agentEvent);
      resumed.projector.apply(agentEvent);
      resumed.projectedSequences.add(event.sequence);
      return;
    }
    if (isStructuredFlowEvent(event.type)) {
      resumed.flowProjector.apply(event);
      if (event.type !== "STEP_FAILED") {
        resumed.projectedSequences.add(event.sequence);
        return;
      }
    }
    if (event.type === "STEP_FAILED" && !this.fatalAgentErrorRuns.has(runId)) {
      resumed.projector.apply({
        type: "error",
        message: String(
          (event.payload as Record<string, unknown>)?.error ?? "Step failed",
        ),
      });
    }
    if (event.type === "STEP_FAILED") {
      resumed.projectedSequences.add(event.sequence);
    }
  }

  private logResultRecoveryFailure(
    delivery: ChannelDeliveryRow,
    message: string,
  ): void {
    this.host.log(JSON.stringify({
      event: "feishu_terminal_result_recovery_failed",
      channel: "feishu",
      sessionId: delivery.sessionId,
      runId: delivery.runId,
      turnId: delivery.turnId,
      message,
    }));
  }

  async setInboundWebSocketState(state: FeishuConnectionState): Promise<void> {
    await Promise.all(
      [...this.cards.values()].map((card) => card.setInboundWebSocketState(state)),
    );
    for (const resumed of this.resumedCards.values()) {
      setInboundWebSocket(resumed.runStatus, state);
      await this.writeResumedCard(undefined, resumed);
    }
  }

  private async setCoreEventStreamState(
    state: FeishuConnectionState,
  ): Promise<void> {
    await Promise.all(
      [...this.cards.values()].map((card) => card.setCoreEventStreamState(state)),
    );
    for (const resumed of this.resumedCards.values()) {
      setCoreEventStream(resumed.runStatus, state);
      await this.writeResumedCard(undefined, resumed);
    }
  }

  private recordPermanentCardFailure(
    runId: string | undefined,
    messageId: string,
    error: unknown,
  ): boolean {
    if (classifyFeishuCardWriteError(error) !== "permanent") return false;
    this.permanentlyInvalidCardIds.add(messageId);
    if (!this.loggedPermanentCardIds.has(messageId)) {
      this.loggedPermanentCardIds.add(messageId);
      this.host.log(JSON.stringify({
        event: "feishu_card_permanently_invalid",
        channel: "feishu",
        sessionId: this.sessionId,
        runId: runId ?? null,
        surfaceMessageId: messageId,
        errorClass: "permanent",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    return true;
  }

  private async writeResumedCard(
    runId: string | undefined,
    resumed: ResumedFeishuCard,
  ): Promise<boolean> {
    if (this.permanentlyInvalidCardIds.has(resumed.surfaceCardId)) return false;
    try {
      await this.host.updateCard(
        resumed.surfaceCardId,
        this.resumedCardBody(resumed),
      );
      setHttpWrite(resumed.runStatus, "healthy");
      return true;
    } catch (error) {
      if (this.recordPermanentCardFailure(
        runId,
        resumed.surfaceCardId,
        error,
      )) {
        setHttpWrite(resumed.runStatus, "unavailable");
        return false;
      }
      setHttpWrite(resumed.runStatus, "degraded");
      throw error;
    }
  }

  private resumedCardBody(
    resumed: ResumedFeishuCard,
  ): object {
    const status = renderFeishuRunStatus(resumed.runStatus);
    const snapshot = resumed.projector.snapshot();
    const flowSnapshot = resumed.flowProjector.snapshot();
    const flowText = resumed.runStatus.state === "running"
      ? renderChannelFlowLive(flowSnapshot)
      : renderChannelFlowFinal(flowSnapshot);
    const agentText = resumed.runStatus.state === "running"
      ? snapshot.liveText
      : resumed.resultRecovery === "pending"
        ? "⏳ 结果恢复中"
        : flowText && !snapshot.result.trim()
          ? ""
          : snapshot.finalText;
    const body = composeFeishuRunBody(
      agentText,
      flowText,
      resumed.flowSaveRequested,
    );
    const markdown = status && body
      ? `${status}\n\n---\n\n${body}`
      : status || body || "（运行中）";
    return markdownCard(markdown);
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
      const cardInstanceId = card.cardInstanceId;
      if (!cardId || !cardInstanceId) {
        throw new Error(`card did not produce a message id for run ${runId}`);
      }
      const acked = await this.ingress.ackDelivery(
        turn.turnId,
        owner,
        cardId,
        cardInstanceId,
      );
      if (!acked) {
        throw new Error(`ack delivery failed for run ${runId}`);
      }
      this.deliveries.set(runId, { turnId: turn.turnId, owner });
    } catch (err) {
      this.cards.delete(runId);
      card.abort();
      throw err;
    }
  }

  private async run(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      try {
        await this.setCoreEventStreamState("connected").catch(() => {});
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
        await this.setCoreEventStreamState("reconnecting").catch(() => {});
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
      const resumed = this.resumedCards.get(event.runId);
      const agentEvent = event.payload.event as AgentEvent | undefined;
      if (agentEvent?.type === "error" && agentEvent.fatal && event.runId) {
        this.fatalAgentErrorRuns.add(event.runId);
      }
      if (resumed && agentEvent) {
        this.applyRecoveredEvent(event.runId, resumed, event);
      }
      if (card && agentEvent && agentEvent.type !== "done") {
        await card.onAgentEvent(agentEvent);
      }
      return;
    }
    if (event.type === "FLOW_SAVE_REQUESTED" && event.runId) {
      const card = this.cards.get(event.runId);
      if (card) await card.onFlowSaveRequested();
      const resumed = this.resumedCards.get(event.runId);
      if (resumed) {
        const alreadyProjected = resumed.flowSaveRequested;
        this.applyRecoveredEvent(event.runId, resumed, event);
        if (!alreadyProjected && resumed.flowSaveRequested) {
          await this.writeResumedCard(event.runId, resumed);
        }
      }
      return;
    }
    if (isStructuredFlowEvent(event.type) && event.runId) {
      const card = this.cards.get(event.runId);
      if (card) await card.onDomainEvent(event);
      const resumed = this.resumedCards.get(event.runId);
      if (resumed) {
        this.applyRecoveredEvent(event.runId, resumed, event);
        await this.writeResumedCard(event.runId, resumed);
      }
      if (event.type !== "STEP_FAILED") return;
    }
    if (event.type === "STEP_FAILED" && event.runId) {
      const message = String(
        (event.payload as Record<string, unknown>)?.error ?? "Step failed",
      );
      if (!this.fatalAgentErrorRuns.has(event.runId)) {
        const card = this.cards.get(event.runId);
        if (card) await card.onAgentEvent({ type: "error", message });
      }
      return;
    }
    const terminalState = terminalStateForEvent(event.type);
    if (terminalState && event.runId) {
      const card = this.cards.get(event.runId);
      if (card) {
        try {
          await card.finalize(terminalState);
          this.cards.delete(event.runId);
        } catch (error) {
          const messageId = card.cardMessageId;
          if (messageId && this.recordPermanentCardFailure(
            event.runId,
            messageId,
            error,
          )) {
            card.abort();
            this.cards.delete(event.runId);
            return;
          }
          throw error;
        }
      }
      const resumed = this.resumedCards.get(event.runId);
      if (resumed) {
        resumed.resultRecovery = "confirmed";
        finishFeishuRunStatus(resumed.runStatus, terminalState);
        const written = await this.writeResumedCard(event.runId, resumed);
        if (!written) return;
      }
      await this.completeDeliveryForRun(event.runId);
    }
  }

  private async completeDeliveryForRun(runId: string): Promise<void> {
    const delivery = this.deliveries.get(runId);
    if (!delivery) return;
    const completed = await this.ingress.completeDelivery(
      delivery.turnId,
      delivery.owner,
    );
    if (!completed) {
      throw new Error(`complete delivery returned false for run ${runId}`);
    }
    this.deliveries.delete(runId);
    this.resumedCards.delete(runId);
  }

  abort(): void {
    this.abortController.abort();
    for (const card of this.cards.values()) card.abort();
    this.cards.clear();
    this.resumedCards.clear();
    this.pendingTurns.clear();
  }
}
