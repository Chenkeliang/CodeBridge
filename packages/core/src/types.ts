/** 唯一标识一次「飞书对话面」 */
export interface SessionKey {
  chatId: string;
  topicId?: string;
  backendId: string;
  cwd: string;
}

export interface SessionRecord {
  cliSessionId?: string;
  lastRunAt: string;
  lastRunId?: string;
}

export interface LocalMediaPath {
  path: string;
  mimeType?: string;
  name?: string;
}

export interface RunRequest {
  runId: string;
  sessionKey: SessionKey;
  prompt: string;
  attachments?: LocalMediaPath[];
  resumeSessionId?: string;
  model?: string;
  effort?: string;
}

export type RunStatus = "queued" | "running" | "done" | "failed" | "stopped";

export interface RunState {
  runId: string;
  status: RunStatus;
  startedAt: string;
  error?: string;
  sessionKey?: SessionKey;
  prompt?: string;
}

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string; input?: unknown }
  | { type: "tool_end"; name: string; output?: unknown }
  | { type: "session"; sessionId: string }
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "done"; exitCode: number };

export interface DoctorResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; message?: string }>;
}

export interface RunContext {
  runId: string;
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  backendConfig: BackendProfile;
  model?: string;
  effort?: string;
}

export interface BackendProfile {
  type: "cursor-cli" | "claude-code" | "codex" | "generic-spawn";
  command: string;
  args?: string[];
  model?: string;
  effort?: string;
  allowBypassApprovals?: boolean;
  allowBypassApprovalsViaConfig?: boolean;
  claudeArgsOption?: string;
  /** Claude --permission-mode；飞书非交互场景建议 bypassPermissions */
  claudePermissionMode?:
    | "acceptEdits"
    | "auto"
    | "bypassPermissions"
    | "default"
    | "dontAsk"
    | "plan";
  codexArgsOption?: string;
}

export function serializeSessionKey(key: SessionKey): string {
  const cwd = key.cwd.replace(/\\/g, "/");
  const topic = key.topicId ?? "";
  return `${key.chatId}|${topic}|${key.backendId}|${cwd}`;
}

export function parseSessionKey(raw: string): SessionKey {
  const parts = raw.split("|");
  if (parts.length < 4) {
    throw new Error(`Invalid session key: ${raw}`);
  }
  const [chatId, topicId, backendId, ...cwdParts] = parts;
  return {
    chatId: chatId!,
    topicId: topicId || undefined,
    backendId: backendId!,
    cwd: cwdParts.join("|"),
  };
}

export const DEFAULT_DATA_DIR = `${process.env.HOME ?? ""}/.feishu-code-bridge`;

export const VERSION = "0.1.0";
