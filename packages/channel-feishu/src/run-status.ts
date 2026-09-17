import type { AgentEvent, ChannelDeliveryRunSnapshot } from "@codebridge/core";
import { formatElapsed } from "@codebridge/router";

export const FEISHU_LIVE_STATUS_QUIET_MS = 5 * 60_000;

export type FeishuRunState =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type FeishuConnectionState =
  | "connected"
  | "reconnecting"
  | "unavailable";

export type FeishuHttpWriteState = "healthy" | "degraded" | "unavailable";

export interface FeishuTransportSnapshot {
  coreEventStream: FeishuConnectionState;
  feishuInboundWebSocket: FeishuConnectionState;
  feishuHttpWrite: FeishuHttpWriteState;
}

export interface FeishuRunStatus {
  startedAt: number;
  lastActivityAt: number;
  lastVerifiedAt?: number;
  phase: string;
  state: FeishuRunState;
  endedAt?: number;
  transport: FeishuTransportSnapshot;
  verificationError?: string;
  /** 请求的 model 未被适配器采纳时的请求值/实际生效值对照（见 model_resolved 事件） */
  modelMismatch?: { requested: string; effective: string };
}

export function createFeishuRunStatus(now = Date.now()): FeishuRunStatus {
  return {
    startedAt: now,
    lastActivityAt: now,
    phase: "任务启动",
    state: "running",
    transport: {
      coreEventStream: "connected",
      feishuInboundWebSocket: "connected",
      feishuHttpWrite: "healthy",
    },
  };
}

export function recordRunVerification(
  status: FeishuRunStatus,
  now = Date.now(),
): void {
  status.lastVerifiedAt = now;
  status.verificationError = undefined;
}

export function recordRunVerificationFailure(
  status: FeishuRunStatus,
  message: string,
): void {
  status.verificationError = message;
}

export function setCoreEventStream(
  status: FeishuRunStatus,
  state: FeishuConnectionState,
): void {
  status.transport.coreEventStream = state;
}

export function setFeishuInboundWebSocket(
  status: FeishuRunStatus,
  state: FeishuConnectionState,
): void {
  status.transport.feishuInboundWebSocket = state;
}

export const setInboundWebSocket = setFeishuInboundWebSocket;

export function setFeishuHttpWrite(
  status: FeishuRunStatus,
  state: FeishuHttpWriteState,
): void {
  status.transport.feishuHttpWrite = state;
}

export const setHttpWrite = setFeishuHttpWrite;

function parsedTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function applyRunSnapshot(
  status: FeishuRunStatus,
  snapshot: ChannelDeliveryRunSnapshot,
  now = Date.now(),
): boolean {
  recordRunVerification(status, now);

  const startedAt = parsedTimestamp(snapshot.createdAt);
  const updatedAt = parsedTimestamp(snapshot.updatedAt);
  if (startedAt !== undefined) status.startedAt = startedAt;

  const terminalState =
    snapshot.status === "succeeded" ||
    snapshot.status === "failed" ||
    snapshot.status === "cancelled" ||
    snapshot.status === "interrupted"
      ? snapshot.status
      : undefined;

  if (!terminalState) {
    if (status.state !== "running") return false;
    if (snapshot.status === "queued") status.phase = "等待执行";
    if (snapshot.status === "waiting") status.phase = "等待步骤审批";
    return true;
  }

  if (status.state !== "running") return status.state === terminalState;
  status.state = terminalState;
  status.endedAt = updatedAt ?? now;
  if (snapshot.terminalReason) status.phase = snapshot.terminalReason;
  return true;
}

export function recordFeishuRunActivity(
  status: FeishuRunStatus,
  event: AgentEvent,
  now = Date.now(),
): boolean {
  if (status.state !== "running") return false;

  if (event.type === "model_resolved") {
    status.modelMismatch = { requested: event.requested, effective: event.effective };
    status.lastActivityAt = now;
    return true;
  }

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

export function finishFeishuRunStatus(
  status: FeishuRunStatus,
  state: Exclude<FeishuRunState, "running">,
  now = Date.now(),
): boolean {
  if (status.state !== "running") return false;
  status.state = state;
  status.endedAt = now;
  return true;
}

export function renderFeishuRunStatus(
  status: FeishuRunStatus,
  now = Date.now(),
): string {
  const terminal = status.state !== "running";
  const observedAt = terminal ? status.endedAt ?? now : now;
  const elapsed = Math.max(0, observedAt - status.startedAt);
  const sinceActivity = Math.max(0, observedAt - status.lastActivityAt);
  let title: string;
  let phase = status.phase.replace(/[\r\n]+/g, " ").trim() || "—";

  if (status.state !== "running") {
    const titles: Record<Exclude<FeishuRunState, "running">, string> = {
      succeeded: "✅ **已完成**",
      failed: "❌ **已失败**",
      cancelled: "⏹ **已停止**",
      interrupted: "⚠️ **已中断**",
    };
    title = titles[status.state];
  } else {
    const quiet = sinceActivity >= FEISHU_LIVE_STATUS_QUIET_MS;
    const coreEventStream = status.transport.coreEventStream;
    title =
      coreEventStream === "reconnecting"
        ? "⚠️ **事件流重连中 · 后台任务仍在运行**"
        : coreEventStream === "unavailable" || status.verificationError
          ? "⚠️ **状态核验暂不可用 · 后台任务状态待确认**"
          : quiet
            ? "🟠 **任务运行中 · 暂无新事件**"
            : "🟢 **执行中**";
    if (quiet) phase = `${phase}（暂无新事件）`;
  }

  const lines = [
    `任务状态：${title}`,
    `运行时长：${formatElapsed(elapsed)}`,
    `最近任务事件：${formatElapsed(sinceActivity)}前`,
    `当前阶段：${phase}`,
  ];
  // 只在实际生效模型与用户请求不一致时提示，避免正常运行多一行噪音
  if (status.modelMismatch) {
    lines.push(
      `实际使用模型：${status.modelMismatch.effective}（请求：${status.modelMismatch.requested}，未生效）`,
    );
  }
  return lines.join("\n");
}
