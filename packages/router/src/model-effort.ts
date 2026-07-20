import type { BackendConfigOption } from "@feishu-code-bridge/core";

/** Per-backend model hints for `/model` (not exhaustive; CLI aliases change). */
export const MODEL_HINTS: Record<string, string[]> = {
  cursor: [
    "auto",
    "composer-2.5",
    "composer-2.5-fast",
    "gpt-5.5-medium",
    "（完整列表：终端运行 `cursor-agent models`）",
  ],
  claude: [
    "opus",
    "sonnet",
    "haiku",
    "（别名指向当前最新版本；完整列表：`claude --help`）",
  ],
  codex: [
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.3-codex",
    "（以 `/model` 动态列表为准；OpenAI 会上下架模型名）",
  ],
};

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export const CLAUDE_PERMISSION_MODES = [
  "bypassPermissions",
  "acceptEdits",
  "auto",
  "default",
  "dontAsk",
  "plan",
] as const;

export function backendSupportsEffort(backendId: string): boolean {
  return backendId === "claude";
}

export function backendSupportsPermissionMode(backendId: string): boolean {
  return backendId === "claude";
}

/**
 * /model 动态列表：用 ACP 适配器 advertise 的真实模型选项渲染（value 才是 /model 接受的名字；
 * 有别名/展示名和描述就带上）。静态 MODEL_HINTS 仅在动态拉取失败时兜底。
 */
export function formatDynamicModelHelp(
  backendId: string,
  option: BackendConfigOption,
  current?: string,
): string {
  const lines = [`**${backendId}** 可用 model（适配器实时列表）：`];
  for (const v of option.values) {
    const label =
      v.name && v.name.toLowerCase() !== v.value.toLowerCase()
        ? `\`${v.value}\` — ${v.name}`
        : `\`${v.value}\``;
    const desc = v.description ? `：${v.description}` : "";
    const isDefault = option.currentValue === v.value ? "（适配器默认）" : "";
    lines.push(`- ${label}${isDefault}${desc}`);
  }
  if (current) lines.push("", `当前会话: \`${current}\``);
  lines.push("", "用法: `/model <名称>` | `/model default` 恢复配置默认");
  return lines.join("\n");
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

export function formatPermissionHelp(
  backendId: string,
  current?: string,
): string {
  if (!backendSupportsPermissionMode(backendId)) {
    return `**${backendId}** 不支持 Claude \`--permission-mode\`（仅 Claude Code）。`;
  }
  const lines = [
    "**Claude permission-mode** 可选：",
    ...CLAUDE_PERMISSION_MODES.map((m) => `- \`${m}\``),
    "",
    "飞书非交互 `-p` 建议 `bypassPermissions`（可跑 Bash/skill）；`dontAsk` 会直接拒绝命令。",
  ];
  if (current) lines.push("", `当前会话: \`${current}\``);
  lines.push(
    "",
    "用法: `/permission <模式>` | `/permission default` 恢复配置默认",
  );
  return lines.join("\n");
}
