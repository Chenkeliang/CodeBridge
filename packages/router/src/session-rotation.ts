import type { ChannelCommandContext, SessionAutoRotateConfig } from "@codebridge/core";

const DEFAULT_IDLE_HOURS = 12;
const DEFAULT_MAX_CONTEXT_RATIO = 0.5;

/**
 * Decide whether the next channel message should start a fresh provider session
 * instead of resuming the bound one. Returns a user-facing reason, or undefined.
 * Never rotates a busy session: queued turns would be left paused on the old one.
 */
export function sessionRotationReason(
  context: ChannelCommandContext,
  policy: SessionAutoRotateConfig | undefined,
  now: number,
): string | undefined {
  if (policy?.enabled === false || !context.sessionId) return undefined;
  if (context.activeRunId || (context.queuedTurns ?? 0) > 0) return undefined;
  const ratio = policy?.maxContextRatio ?? DEFAULT_MAX_CONTEXT_RATIO;
  const { contextUsed: used, contextSize: size } = context;
  if (used && size && used / size >= ratio) {
    return `上一会话上下文已用 ${Math.round((used / size) * 100)}%（${Math.round(used / 1000)}k / ${Math.round(size / 1000)}k tokens）`;
  }
  const idleMs = (policy?.idleHours ?? DEFAULT_IDLE_HOURS) * 3_600_000;
  const last = context.lastActivityAt ? Date.parse(context.lastActivityAt) : Number.NaN;
  if (idleMs > 0 && Number.isFinite(last) && now - last >= idleMs) {
    return `上一会话已闲置 ${Math.floor((now - last) / 3_600_000)} 小时`;
  }
  return undefined;
}

export function sessionRotationNotice(reason: string): string {
  return `🆕 ${reason}，已自动开启新会话，本条消息不带之前的上下文。需要接着旧会话可发 /resume。`;
}
