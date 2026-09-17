import type { BackendProfile } from "@codebridge/core";

/**
 * ACP 适配器认证失败时常见的错误文案（大小写不敏感匹配）。命中即视为「需要在宿主机重新登录」，
 * 而非普通运行时错误——原始文案仍保留作为 detail，不吞掉。
 */
const AUTH_ERROR_PATTERNS: RegExp[] = [
  /oauth session expired/i,
  /could not be refreshed/i,
  /not logged in/i,
  /please run \/login/i,
];

/** 各后端在宿主机上真正可用的登录命令；未知/不确定的一律不给具体命令，只给通用提示。 */
const LOGIN_HINT_BY_BACKEND: Partial<
  Record<BackendProfile["type"], { displayName: string; command: string }>
> = {
  "claude-code": { displayName: "Claude Code", command: "claude auth login" },
  codex: { displayName: "Codex", command: "codex login" },
  "cursor-cli": { displayName: "Cursor", command: "agent login" },
};

export function isAuthErrorMessage(message: string): boolean {
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * 把已知的认证失败错误文案，映射成「哪个后端 + 在宿主机上具体该跑什么命令」的可操作提示。
 * 命中才改写；不命中原样返回。原始 message 始终作为 detail 附在提示之后，不丢弃。
 */
export function friendlyAuthErrorMessage(
  backendType: BackendProfile["type"],
  message: string,
): string {
  if (!isAuthErrorMessage(message)) return message;
  const hint = LOGIN_HINT_BY_BACKEND[backendType];
  const action = hint
    ? `请在宿主机上运行 \`${hint.command}\`（${hint.displayName}）重新登录后再试。`
    : `请在宿主机上为该 Agent 重新完成登录后再试。`;
  return `认证失败：${action}\n\n详情：${message}`;
}
