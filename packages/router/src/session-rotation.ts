import type { ChannelCommandContext, SessionAutoRotateConfig } from "@codebridge/core";

const DEFAULT_IDLE_HOURS = 12;

/**
 * Decide whether an idle channel session should start fresh on the next message.
 * Context length is handled by native provider compaction, preserving the session.
 * Never rotates a busy session: queued turns would be left paused on the old one.
 */
export function sessionRotationReason(
  context: ChannelCommandContext,
  policy: SessionAutoRotateConfig | undefined,
  now: number,
): string | undefined {
  if (policy?.enabled === false || !context.sessionId) return undefined;
  if (context.activeRunId || (context.queuedTurns ?? 0) > 0) return undefined;
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
