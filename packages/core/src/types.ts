/** 唯一标识一次「飞书对话面」 */
export interface SessionKey {
  chatId: string;
  topicId?: string;
  backendId: string;
  cwd: string;
}

export interface SessionRecord {
  cliSessionId?: string;
  /** 创建该 session 时使用的 transport；CLI 与 ACP 的 sessionId 不互通 */
  transport?: BackendTransport;
  lastRunAt: string;
  lastRunId?: string;
}

export interface LocalMediaPath {
  path: string;
  mimeType?: string;
  name?: string;
}

/** Bridge → Runner：图片以 base64 传输，Runner 落盘后再交给 CLI */
export interface RunAttachment {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export interface RunRequest {
  runId: string;
  sessionKey: SessionKey;
  prompt: string;
  attachments?: RunAttachment[];
  resumeSessionId?: string;
  model?: string;
  effort?: string;
  claudePermissionMode?: ClaudePermissionMode;
  /** 会话级 transport 覆盖，优先于 config.backends[].transport */
  transport?: BackendTransport;
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
  | { type: "thought_delta"; text: string }
  | { type: "tool_start"; name: string; input?: unknown }
  | { type: "tool_end"; name: string; output?: unknown }
  | { type: "session"; sessionId: string }
  | { type: "error"; message: string; fatal?: boolean }
  /** prompt_feishu 权限模式：agent 请求权限，等待用户 /approve 或 /deny */
  | { type: "permission_request"; requestId: string; title: string }
  | { type: "done"; exitCode: number };

export interface DoctorResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; message?: string }>;
}

export interface RunContext {
  runId: string;
  cwd: string;
  prompt: string;
  attachments?: LocalMediaPath[];
  resumeSessionId?: string;
  backendConfig: BackendProfile;
  model?: string;
  effort?: string;
  claudePermissionMode?: ClaudePermissionMode;
  /** 注入 Agent 子进程的额外环境变量（如 FCB_* 出站 API 凭据） */
  extraEnv?: Record<string, string>;
}

export type ClaudePermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan";

export type BackendTransport = "acp" | "cli";
export type AcpPermissionPolicy =
  | "auto_allow"
  | "prompt_deny"
  /** 危险操作在飞书里等 /approve；超时自动拒绝 */
  | "prompt_feishu";

/** ACP 适配器 advertise 的会话配置项里的一个可选值（select 分组已展平） */
export interface BackendConfigOptionValue {
  value: string;
  name?: string;
  description?: string;
}

/**
 * ACP 适配器 advertise 的一个会话配置项（session/new 响应 configOptions 的精简形态）。
 * category: "model" | "thought_level" | "mode" 等；/model 动态列表取 category === "model"。
 */
export interface BackendConfigOption {
  id: string;
  name: string;
  category?: string;
  /** 适配器当前默认选中的值 */
  currentValue?: string;
  values: BackendConfigOptionValue[];
}

export interface BackendProfile {
  type: "cursor-cli" | "claude-code" | "codex" | "generic-spawn";
  /** Agent 传输：acp（默认）或 cli（stream-json spawn 回退） */
  transport?: BackendTransport;
  command: string;
  args?: string[];
  /** ACP spawn 命令，默认同 command 或由 type 推断 */
  acpCommand?: string;
  acpArgs?: string[];
  model?: string;
  effort?: string;
  allowBypassApprovals?: boolean;
  allowBypassApprovalsViaConfig?: boolean;
  claudeArgsOption?: string;
  /** Claude --permission-mode；飞书非交互场景建议 bypassPermissions */
  claudePermissionMode?: ClaudePermissionMode;
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
