import type { ConversationEvent } from "./events";
import type { AgentCommand, AgentProfile, AgentSession, ConfigOption, MessageAttachmentInput } from "./types";

export function mergeConversationEvents(current: ConversationEvent[], incoming: ConversationEvent[]): ConversationEvent[] {
  const events = new Map(current.map((event) => [event.event_id, event]));
  for (const event of incoming) events.set(event.event_id, event);
  return [...events.values()].sort((left, right) => left.sequence - right.sequence);
}

export function isModelOption(option: ConfigOption): boolean {
  return option.category?.toLowerCase() === "model" || option.id.toLowerCase().includes("model");
}

export function isPermissionOption(option: ConfigOption): boolean {
  return option.category?.toLowerCase() === "mode" || option.id.toLowerCase().includes("permission");
}

export function isThoughtLevelOption(option: ConfigOption): boolean {
  return option.category?.toLowerCase() === "thought_level" || option.id.toLowerCase().includes("reasoning");
}

export function isSpeedOption(option: ConfigOption): boolean {
  const identity = `${option.id} ${option.name}`.toLowerCase();
  return option.category?.toLowerCase() === "model_config" && /\b(fast|speed)\b/.test(identity);
}

export function serializeConfigOverride(option: Pick<ConfigOption, "type">, value: string): string | boolean {
  return option.type === "boolean" ? value === "true" : value;
}

export function speedValueLabel(value: string, name?: string): string {
  const identity = `${value} ${name ?? ""}`.toLowerCase();
  return value.toLowerCase() === "true" || /\b(fast|quick)\b/.test(identity) ? "快速" : "标准";
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

export function selectInitialAgent(
  agents: AgentProfile[],
  defaultAgentId: string | null,
): string | null {
  const defaultAgent = defaultAgentId
    ? agents.find((agent) => agent.agent_id === defaultAgentId && agent.setup?.can_select_default)
    : undefined;
  if (defaultAgent) return defaultAgent.agent_id;
  return agents.find((agent) => agent.setup?.can_select_default)?.agent_id ?? null;
}

export function workspacePaths(session: AgentSession | null): string[] {
  if (!session) return [];
  return [...new Set([session.cwd, ...session.additional_directories].filter((value): value is string => Boolean(value)))];
}

export function composerTrigger(draft: string): { kind: "command" | "context"; query: string } | null {
  const match = draft.trimEnd().match(/(?:^|\s)([/@])([^\s]*)$/);
  if (!match) return null;
  return { kind: match[1] === "/" ? "command" : "context", query: match[2] ?? "" };
}

export function filterCommands(commands: AgentCommand[], query: string): AgentCommand[] {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? commands.filter((command) => `${command.name} ${command.description}`.toLowerCase().includes(normalized))
    : commands;
  return [...filtered].sort((left, right) => Number(right.name.startsWith("$")) - Number(left.name.startsWith("$")));
}

export function applyComposerSuggestion(draft: string, replacement: string): string {
  return draft.trimEnd().replace(/([/@])[^\s]*$/, replacement);
}

export function attachmentPreviewUrl(attachment: MessageAttachmentInput): string | null {
  return attachment.mimeType.startsWith("image/")
    ? `data:${attachment.mimeType};base64,${attachment.dataBase64}`
    : null;
}
