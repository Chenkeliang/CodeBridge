import type { AgentEvent } from "@codebridge/core";
import { formatElapsed } from "@codebridge/router";

export const FEISHU_LIVE_STATUS_QUIET_MS = 5 * 60_000;

export type FeishuRunState =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface FeishuRunStatus {
  startedAt: number;
  lastActivityAt: number;
  phase: string;
  state: FeishuRunState;
  endedAt?: number;
}

export function createFeishuRunStatus(now = Date.now()): FeishuRunStatus {
  return {
    startedAt: now,
    lastActivityAt: now,
    phase: "任务启动",
    state: "running",
  };
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
  const quiet = sinceActivity >= FEISHU_LIVE_STATUS_QUIET_MS;
  return [
    `${quiet ? "🟠 **任务连接保持**" : "🟢 **执行中**"} · 已运行 ${formatElapsed(Math.max(0, now - status.startedAt))}`,
    `最近确认活动：${formatElapsed(sinceActivity)}前`,
    quiet ? "暂未收到新的任务事件" : `当前阶段：${status.phase}`,
    quiet ? `最近阶段：${status.phase}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
