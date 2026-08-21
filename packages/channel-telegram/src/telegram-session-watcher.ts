import type {
  AgentEvent,
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
import { CoalescingMessageWriter } from "./coalescing-message-writer.js";
import { chunkTelegramText } from "./telegram-api.js";

interface TelegramTransport {
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
}

export interface PendingTurn {
  turnId: string;
  chatId: string;
  topicId: string | undefined;
  showThinking: boolean;
}

class TelegramRunRenderer {
  private readonly projector: ChannelStreamProjector;
  private readonly flowProjector: ChannelFlowProjector;
  private readonly liveWriter: CoalescingMessageWriter;

  constructor(
    private readonly api: TelegramTransport,
    private readonly chatId: string,
    private readonly topicId: string | undefined,
    private readonly pendingMessageId: number,
    showThinking: boolean,
    onLog: (message: string) => void,
  ) {
    this.projector = createChannelStreamProjector({ showThinking });
    this.flowProjector = createChannelFlowProjector();
    this.liveWriter = new CoalescingMessageWriter(
      async (text) => {
        await this.api.editMessage(this.chatId, this.pendingMessageId, text);
      },
      (error) => onLog(
        `telegram Flow 实时消息更新失败，将由终态覆盖：${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }

  onAgentEvent(event: AgentEvent): void {
    this.projector.apply(event);
  }

  onDomainEvent(event: ChannelSessionEvent): void {
    const flow = this.flowProjector.apply(event);
    const text = composeTelegramRunBody(
      this.projector.snapshot().liveText,
      renderChannelFlowLive(flow),
    );
    if (text) this.liveWriter.enqueue(text);
  }

  async onPermissionRequest(title: string): Promise<void> {
    await this.api.sendMessage(
      this.chatId,
      `🔐 Agent 请求权限：${title}\n回复 /approve 允许，/deny 拒绝。`,
      this.topicId,
    );
  }

  appendError(message: string): void {
    this.projector.apply({ type: "error", message });
  }

  async finalize(): Promise<void> {
    await this.liveWriter.flush();
    this.liveWriter.close();
    const agent = this.projector.snapshot();
    const flowText = renderChannelFlowFinal(this.flowProjector.snapshot());
    const finalText = flowText
      ? composeTelegramRunBody(agent.result, flowText)
      : agent.finalText;
    const chunks = chunkTelegramText(finalText);
    try {
      await this.api.editMessage(
        this.chatId,
        this.pendingMessageId,
        chunks[0]!,
      );
    } catch {
      await this.api.sendMessage(this.chatId, chunks[0]!, this.topicId);
    }
    for (const chunk of chunks.slice(1)) {
      await this.api.sendMessage(this.chatId, chunk, this.topicId);
    }
  }
}

const STRUCTURED_FLOW_EVENTS = new Set([
  "STEP_STARTED",
  "STEP_SUCCEEDED",
  "STEP_FAILED",
  "STEP_RETRYING",
  "STEP_SKIPPED",
  "ARTIFACT_CREATED",
  "VERIFICATION_FAILED",
  "APPROVAL_REQUESTED",
  "APPROVAL_GRANTED",
  "APPROVAL_REJECTED",
  "RUN_SNAPSHOT",
]);

function isStructuredFlowEvent(event: ChannelSessionEvent): boolean {
  return STRUCTURED_FLOW_EVENTS.has(event.type);
}

function composeTelegramRunBody(agentText: string, flowText: string): string {
  return [agentText.trim(), flowText.trim()].filter(Boolean).join("\n\n---\n\n");
}

/** 每 Session 一个持久 events 订阅，单订阅路由 Turn / Run / Delivery。 */
export class TelegramSessionWatcher {
  private readonly abortController = new AbortController();
  private afterSequence = 0;
  private started = false;
  private readonly runs = new Map<string, TelegramRunRenderer>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly deliveries = new Map<string, { turnId: string; owner: string }>();
  private readonly fatalAgentErrorRuns = new Set<string>();

  constructor(
    private readonly api: TelegramTransport,
    private readonly ingress: ChannelSessionIngress,
    private readonly sessionId: string,
    private readonly instanceId: string,
    private readonly onLog: (message: string) => void,
  ) {}

  start(afterSequence: number): void {
    if (this.started) return;
    this.started = true;
    this.afterSequence = afterSequence;
    void this.run().catch((err) => {
      this.onLog(
        `telegram watcher 退出: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  registerPendingTurn(turnId: string, turn: PendingTurn): void {
    this.pendingTurns.set(turnId, turn);
  }

  /** 恢复 delivering：用已有消息 id 重放事件累积最终回答。 */
  resumeRun(
    runId: string,
    surfaceMessageId: string,
    turnId: string,
    owner: string,
    showThinking: boolean,
    chatId: string,
    topicId: string | undefined,
  ): void {
    const pendingMessageId = Number(surfaceMessageId);
    if (!Number.isSafeInteger(pendingMessageId)) return;
    const renderer = new TelegramRunRenderer(
      this.api,
      chatId,
      topicId,
      pendingMessageId,
      showThinking,
      this.onLog,
    );
    this.runs.set(runId, renderer);
    this.deliveries.set(runId, { turnId, owner });
  }

  async openRun(runId: string, turn: PendingTurn): Promise<void> {
    if (this.runs.has(runId)) return;
    const owner = `telegram:${this.instanceId}:${runId}`;
    const claimed = await this.ingress.claimDelivery(turn.turnId, owner);
    if (!claimed) return;
    const pending = await this.api.sendMessage(
      turn.chatId,
      "⏳ Agent 正在处理…",
      turn.topicId,
    );
    const renderer = new TelegramRunRenderer(
      this.api,
      turn.chatId,
      turn.topicId,
      pending.message_id,
      turn.showThinking,
      this.onLog,
    );
    this.runs.set(runId, renderer);
    const acked = await this.ingress.ackDelivery(
      turn.turnId,
      owner,
      String(pending.message_id),
    );
    if (!acked) {
      this.runs.delete(runId);
      throw new Error(`ack delivery failed for run ${runId}`);
    }
    this.deliveries.set(runId, { turnId: turn.turnId, owner });
  }

  private async run(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      try {
        for await (const event of this.ingress.events(this.sessionId, {
          afterSequence: this.afterSequence,
          signal: this.abortController.signal,
        })) {
          await this.handle(event);
          this.afterSequence = event.sequence;
        }
      } catch (err) {
        if (this.abortController.signal.aborted) return;
        this.onLog(
          `telegram watcher 断线，按 sequence ${this.afterSequence} 重连：${
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
        await this.openRun(event.runId, turn);
        this.pendingTurns.delete(event.target);
      }
      return;
    }
    if (event.type === "AGENT_EVENT" && event.runId) {
      const renderer = this.runs.get(event.runId);
      const agentEvent = event.payload.event as AgentEvent | undefined;
      if (agentEvent?.type === "error" && agentEvent.fatal && event.runId) {
        this.fatalAgentErrorRuns.add(event.runId);
      }
      if (renderer && agentEvent && agentEvent.type !== "done") {
        if (agentEvent.type === "permission_request") {
          await renderer.onPermissionRequest(agentEvent.title);
        } else {
          renderer.onAgentEvent(agentEvent);
        }
      }
      return;
    }
    if (isStructuredFlowEvent(event) && event.runId) {
      this.runs.get(event.runId)?.onDomainEvent(event);
    }
    if (event.type === "STEP_FAILED" && event.runId) {
      if (!this.fatalAgentErrorRuns.has(event.runId)) {
        const message = String(
          (event.payload as Record<string, unknown>)?.error ?? "Step failed",
        );
        this.runs.get(event.runId)?.appendError(message);
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
      const renderer = this.runs.get(event.runId);
      if (renderer) {
        await renderer.finalize();
        this.runs.delete(event.runId);
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
    this.runs.clear();
    this.pendingTurns.clear();
  }
}
