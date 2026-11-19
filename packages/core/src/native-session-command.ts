import type { SessionGoalObservation } from "./types.js";

export const SLASH_COMMAND_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "/help": ["/h"],
  "/menu": ["/mn"],
  "/commands": ["/cmd"],
  "/context": ["/ctx"],
  "/usage": ["/u"],
  "/goal": ["/g"],
  "/status": ["/s"],
  "/stop": ["/x", "/cancel"],
  "/continue": ["/c"],
  "/command-status": ["/cs"],
  "/command-cancel": ["/cc"],
  "/steer": ["/st"],
  "/approve": ["/a"],
  "/deny": ["/d"],
  "/new": ["/n", "/reset"],
  "/resume": ["/r"],
  "/session": ["/sess"],
  "/backend": ["/b"],
  "/transport": ["/tr"],
  "/model": ["/m"],
  "/effort": ["/e"],
  "/permission": ["/perm"],
  "/config": ["/cfg"],
  "/thinking": ["/think"],
  "/cd": ["/j"],
  "/roots": ["/rs"],
  "/root": ["/rt"],
  "/ws": ["/w"],
  "/send": ["/sf"],
  "/clone": ["/cl"],
  "/pull": ["/pl"],
  "/compact": ["/cp"],
  "/review": ["/rv"],
  "/review-branch": ["/rvb"],
  "/review-commit": ["/rvc"],
  "/review-result": ["/rvr"],
};

const canonicalByAlias = new Map(Object.entries(SLASH_COMMAND_ALIASES).flatMap(
  ([command, aliases]) => aliases.map((alias) => [alias, command] as const),
));

export function canonicalSlashCommand(command: string): string {
  return canonicalByAlias.get(command) ?? command;
}

export const NATIVE_SESSION_COMMANDS = ["compact", "goal", "review", "review-branch", "review-commit"] as const;
export type NativeSessionCommand = typeof NATIVE_SESSION_COMMANDS[number];

export const NATIVE_COMMAND_UNAVAILABLE = {
  unbound: "当前会话尚未绑定 Provider 会话",
  runner_unavailable: "Runner 暂不可达或尚未提供原生命令状态",
  unsupported_backend: "当前后端暂无此命令的原生实现",
  release_unverified: "当前发布缺少此后端的验证证据",
  adapter_changed: "当前适配器与已验证的制品不同",
  not_reported: "当前 Provider 会话尚未确认此命令",
  requires_admin: "当前群聊要求管理员执行此命令",
  unverified_command: "Agent 已上报，执行合同尚未验证",
} as const;

export type NativeCommandUnavailableReason = keyof typeof NATIVE_COMMAND_UNAVAILABLE;

export function isNativeCommandUnavailableReason(value: unknown): value is NativeCommandUnavailableReason {
  return typeof value === "string" && Object.hasOwn(NATIVE_COMMAND_UNAVAILABLE, value);
}

export function isNativeSessionCommand(value: unknown): value is NativeSessionCommand {
  return typeof value === "string" && NATIVE_SESSION_COMMANDS.some((name) => name === value);
}

export function parseNativeSessionCommand(text: string): { command: NativeSessionCommand; instructions: string } | null {
  const match = /^\/([a-z-]+)(?:\s([\s\S]*))?$/i.exec(text.trimStart());
  if (!match) return null;
  const command = canonicalSlashCommand(`/${match[1]!.toLowerCase()}`).slice(1);
  if (!isNativeSessionCommand(command)) return null;
  const instructions = match[2] ?? "";
  return command === "goal" && !instructions.trim() ? null : { command, instructions };
}

export function parseGoalAction(text: string): { action: "set"; objective: string } | { action: "pause" | "resume" | "clear" } | null {
  const value = text.trim();
  const action = value.toLowerCase();
  if (action === "pause" || action === "resume" || action === "clear") return { action };
  const objective = value.replace(/^set(?:\s+|$)/i, "");
  return objective && objective.length <= 4000 && !/^(?:pause|resume|clear)$/i.test(objective)
    ? { action: "set", objective } : null;
}

export function parseSessionGoalObservation(value: unknown): SessionGoalObservation | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const { status, tokensUsed, tokenBudget } = value as Record<string, unknown>;
  if (status !== "active" && status !== "paused" && status !== "blocked" && status !== "complete" && status !== "limited") return undefined;
  return {
    status,
    ...(typeof tokensUsed === "number" && Number.isSafeInteger(tokensUsed) && tokensUsed >= 0 ? { tokensUsed } : {}),
    ...(typeof tokenBudget === "number" && Number.isSafeInteger(tokenBudget) && tokenBudget >= 0 ? { tokenBudget } : {}),
  };
}
