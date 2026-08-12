import type { ConversationProjection } from "@/lib/events";
import type { AgentSession, ConfigOption } from "@/lib/types";
import { workspacePaths } from "@/lib/workbench-logic";

export type Theme = "paper" | "carbon";
export type PanelArea = "agents" | "flows";
export type MenuView = "actions" | "rename" | "delete";

export const DEFAULT_SELECT_VALUE = "__default__";

export const statusLabel: Record<string, string> = {
  healthy: "就绪",
  unavailable: "不可用",
  needs_setup: "需要配置",
  active: "运行中",
  idle: "就绪",
  closed: "已关闭",
};

export function defaultModelLabel(option: ConfigOption): string {
  const current = option.values.find((candidate) => candidate.value === option.currentValue);
  return current ? `${current.name || current.value} · 默认` : "Agent 默认";
}

export function projectionKey(item: ConversationProjection, index: number): string {
  if (item.kind === "work") return item.id;
  if (item.kind === "user") return item.eventId;
  if (item.kind === "approval") return item.requestId;
  return `${item.kind}-${item.runId ?? "session"}-${index}`;
}

export function formatElapsed(startedAt: string, endedAt: string): string {
  const seconds = Math.max(1, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function workspaceLabel(session: AgentSession | null): string {
  if (!session) return "工作区";
  const path = session.additional_directories.at(-1) ?? session.cwd;
  if (!path) return "添加工作区";
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function relativeTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

export function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}


export function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

