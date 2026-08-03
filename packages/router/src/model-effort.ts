import type { BackendConfigOption } from "@codebridge/core";

function formatOptionValue(
  value: BackendConfigOption["values"][number],
  currentValue?: string,
): string {
  const label =
    value.name && value.name.toLowerCase() !== value.value.toLowerCase()
      ? `\`${value.value}\` — ${value.name}`
      : `\`${value.value}\``;
  const current = currentValue === value.value ? "（适配器默认）" : "";
  const description = value.description ? `：${value.description}` : "";
  return `- ${label}${current}${description}`;
}

export function formatDynamicOptionHelp(
  backendId: string,
  label: string,
  command: string,
  option: BackendConfigOption,
  current?: string,
): string {
  const lines = [
    `**${backendId}** 可用 ${label}（适配器实时列表）：`,
    ...option.values.map((value) =>
      formatOptionValue(value, option.currentValue),
    ),
  ];
  if (current) lines.push("", `当前会话: \`${current}\``);
  lines.push(
    "",
    `用法: \`/${command} <名称>\` | \`/${command} default\` 恢复适配器默认`,
  );
  return lines.join("\n");
}

export function formatDynamicModelHelp(
  backendId: string,
  option: BackendConfigOption,
  current?: string,
): string {
  return formatDynamicOptionHelp(backendId, "model", "model", option, current);
}

export function matchBackendConfigValue(
  option: BackendConfigOption,
  desired: string,
): string | undefined {
  const want = desired.trim().toLowerCase();
  const exactValue = option.values.find(
    (value) => value.value.toLowerCase() === want,
  );
  if (exactValue) return exactValue.value;
  const exactName = option.values.find(
    (value) => value.name?.toLowerCase() === want,
  );
  if (exactName) return exactName.value;
  const prefixes = option.values.filter((value) =>
    value.value.toLowerCase().startsWith(want),
  );
  return prefixes.length === 1 ? prefixes[0]!.value : undefined;
}
