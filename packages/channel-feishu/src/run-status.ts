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
  if (status.state !== "running") {
    const titles: Record<Exclude<FeishuRunState, "running">, string> = {
      succeeded: "✅ **已完成**",
      failed: "❌ **已失败**",
      cancelled: "⏹ **已停止**",
      interrupted: "⚠️ **已中断**",
    };
    const endedAt = status.endedAt ?? now;
    return [
      `${titles[status.state]} · 总耗时 ${formatElapsed(Math.max(0, endedAt - status.startedAt))}`,
      `最终阶段：${status.phase}`,
    ].join("\n");
  }

  const sinceActivity = Math.max(0, now - status.lastActivityAt);
  const sinceVerification =
    status.lastVerifiedAt === undefined
      ? undefined
      : Math.max(0, now - status.lastVerifiedAt);
  const quiet = sinceActivity >= FEISHU_LIVE_STATUS_QUIET_MS;
  const coreEventStream = status.transport.coreEventStream;
  const title =
    coreEventStream === "reconnecting"
      ? "⚠️ **事件流重连中 · 后台任务仍在运行**"
      : coreEventStream === "unavailable" || status.verificationError
        ? "⚠️ **状态核验暂不可用 · 后台任务状态待确认**"
        : quiet
          ? "🟠 **任务运行中 · 暂无新事件**"
          : "🟢 **执行中**";
  return [
    `${title} · 已运行 ${formatElapsed(Math.max(0, now - status.startedAt))}`,
    `最近任务事件：${formatElapsed(sinceActivity)}前`,
    sinceVerification === undefined
      ? "最近状态核验：尚未核验"
      : `最近状态核验：${formatElapsed(sinceVerification)}前`,
    quiet ? "暂未收到新的任务事件" : `当前阶段：${status.phase}`,
    quiet ? `最近阶段：${status.phase}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
