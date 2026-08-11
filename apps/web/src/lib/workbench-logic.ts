import type { AgentSession, ConfigOption } from "./types";

export function isModelOption(option: ConfigOption): boolean {
  return option.category?.toLowerCase() === "model" || option.id.toLowerCase().includes("model");
}

export function orderSessions(sessions: AgentSession[]): AgentSession[] {
  return [...sessions].sort((left, right) => {
    if (Boolean(left.pinned_at) !== Boolean(right.pinned_at)) return left.pinned_at ? -1 : 1;
    return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
  });
}

export function restoreSessionSelection(
  sessions: AgentSession[],
  currentSessionId: string | null,
  agentId: string,
  rememberedSessionId: string | null,
): string | null {
  const current = sessions.find((session) => session.session_id === currentSessionId);
  if (current?.agent_id === agentId && !current.archived_at) return current.session_id;
  const remembered = sessions.find((session) => session.session_id === rememberedSessionId);
  return remembered?.agent_id === agentId && !remembered.archived_at ? remembered.session_id : null;
}

export function workspacePaths(session: AgentSession | null): string[] {
  if (!session) return [];
  return [...new Set([session.cwd, ...session.additional_directories].filter((value): value is string => Boolean(value)))];
}
