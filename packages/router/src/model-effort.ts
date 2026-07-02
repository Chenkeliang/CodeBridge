/** Per-backend model hints for `/model` (not exhaustive; CLI aliases change). */
export const MODEL_HINTS: Record<string, string[]> = {
  cursor: [
    "gpt-5",
    "sonnet-4",
    "sonnet-4-thinking",
    "（完整列表：终端运行 `cursor-agent models`）",
  ],
  claude: [
    "opus",
    "sonnet",
    "haiku",
    "（完整列表：终端运行 `claude models`）",
  ],
  codex: [
    "gpt-5.1-codex",
    "o3",
    "（或 config.toml / `codex exec -m` 支持的名称）",
  ],
};

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export function backendSupportsEffort(backendId: string): boolean {
  return backendId === "claude";
}

export function formatModelHelp(backendId: string, current?: string): string {
  const hints = MODEL_HINTS[backendId] ?? ["（见对应 CLI 文档）"];
  const lines = [
    `**${backendId}** 可用 model 示例：`,
    ...hints.map((h) => `- ${h}`),
  ];
  if (current) lines.push("", `当前会话: \`${current}\``);
  lines.push("", "用法: `/model <名称>` | `/model default` 恢复配置默认");
  return lines.join("\n");
}

export function formatEffortHelp(backendId: string, current?: string): string {
  if (!backendSupportsEffort(backendId)) {
    return `**${backendId}** 的 CLI 不支持 \`--effort\`（仅 Claude Code 支持）。`;
  }
  const lines = [
    "**Claude effort** 可选：",
    ...EFFORT_LEVELS.map((e) => `- \`${e}\``),
  ];
  if (current) lines.push("", `当前会话: \`${current}\``);
  lines.push("", "用法: `/effort <级别>` | `/effort default` 恢复配置默认");
  return lines.join("\n");
}
