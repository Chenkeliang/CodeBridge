import type { SessionGoalObservation } from "./types.js";

export const NATIVE_SESSION_COMMANDS = ["compact", "goal", "review", "review-branch", "review-commit"] as const;
export type NativeSessionCommand = typeof NATIVE_SESSION_COMMANDS[number];

export function isNativeSessionCommand(value: unknown): value is NativeSessionCommand {
  return typeof value === "string" && NATIVE_SESSION_COMMANDS.some((name) => name === value);
}

export function parseNativeSessionCommand(text: string): { command: NativeSessionCommand; instructions: string } | null {
  const match = /^\/([a-z-]+)(?:\s([\s\S]*))?$/i.exec(text.trimStart());
  const command = match?.[1]?.toLowerCase();
  if (!isNativeSessionCommand(command)) return null;
  const instructions = match?.[2] ?? "";
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
