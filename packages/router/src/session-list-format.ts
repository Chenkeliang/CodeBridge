import path from "node:path";
import type { CliSessionSummary } from "@feishu-code-bridge/runner-client";

export function isNoisePreview(text: string): boolean {
  const t = text.trim();
  if (!t || t === "(no preview)") return true;
  if (/^\d+$/.test(t)) return true;
  if (t.startsWith("Caveat: The messages below")) return true;
  if (t.startsWith("<local-command")) return true;
  return false;
}

export function cleanSessionPreview(preview: string, max = 64): string {
  const one = preview.replace(/\s+/g, " ").trim();
  if (isNoisePreview(one)) return "（无有效预览）";
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

/** 列表里显示项目名：优先最后 1–2 段有意义路径 */
export function compactProjectPath(cwd: string): string {
  const parts = path.resolve(cwd).split(path.sep).filter(Boolean);
  if (parts.length === 0) return cwd;
  if (parts.length <= 2) return parts.join(path.sep);

  const last = parts[parts.length - 1]!;
  const prev = parts[parts.length - 2]!;
  if (prev === "com" || prev.includes(".")) {
    return last;
  }
  return `${prev}${path.sep}${last}`;
}

export function formatWhenShort(iso: string): string {
  try {
    const d = new Date(iso);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const hour = String(d.getHours()).padStart(2, "0");
    const minute = String(d.getMinutes()).padStart(2, "0");
    return `${month}/${day} ${hour}:${minute}`;
  } catch {
    return iso;
  }
}

export interface SessionListFormatOptions {
  backendId: string;
  scopeCwd: string;
  listAll: boolean;
  total: number;
  showCwd: boolean;
  displayLimit?: number;
}

export function formatSessionListHeader(
  options: SessionListFormatOptions,
): string {
  const scope = compactProjectPath(options.scopeCwd);
  const scopeLabel = options.listAll
    ? "全部目录"
    : `\`${scope}\` 及子目录`;
  const countNote =
    options.total > (options.displayLimit ?? options.total)
      ? `（显示最近 ${options.displayLimit} / 共 ${options.total} 条）`
      : `（共 ${options.total} 条）`;
  return [
    `**${options.backendId}** 本地 session ${countNote}`,
    `范围：${scopeLabel}`,
  ].join("\n");
}

export function formatSessionLine(
  session: CliSessionSummary,
  index: number,
  showCwd: boolean,
): string {
  const id = session.id.slice(0, 8);
  const when = formatWhenShort(session.updatedAt);
  const preview = cleanSessionPreview(session.preview);

  if (!showCwd) {
    return [`**${index + 1}.** \`${id}\` · ${when}`, `　${preview}`].join(
      "\n",
    );
  }

  const project = compactProjectPath(session.cwd);
  return [
    `**${index + 1}.** \`${id}\` · ${when} · ${project}`,
    `　${preview}`,
  ].join("\n");
}

export function formatSessionListFooter(boundSessionId?: string): string {
  const lines = [
    "---",
    "回复 `/resume <序号>` 绑定 · `/resume last` 选最近一条",
  ];
  if (boundSessionId) {
    lines.push(`当前已绑定：\`${boundSessionId.slice(0, 8)}…\``);
  }
  return lines.join("\n");
}
