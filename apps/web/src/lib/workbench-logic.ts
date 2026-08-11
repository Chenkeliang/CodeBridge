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
