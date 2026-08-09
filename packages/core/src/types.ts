/** 唯一标识一次「飞书对话面」 */
export interface SessionKey {
  chatId: string;
  topicId?: string;
  backendId: string;
  cwd: string;
}

export interface SessionRecord {
  sessionId?: string;
  lastRunAt: string;
  lastRunId?: string;
}

export interface LocalMediaPath {
  path: string;
  mimeType?: string;
  name?: string;
}

/** Bridge → Runner：图片以 base64 传输，Runner 落盘后再交给 ACP Agent */
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
  mode?: string;
  claudePermissionMode?: ClaudePermissionMode;
  additionalDirectories?: string[];
  acpConfig?: Record<string, string | boolean>;
}

export type RunStatus = "queued" | "running" | "done" | "failed" | "stopped";

export type AgentMessagePhase = "commentary" | "final_answer";

export interface ActiveRunStatus {
  runId: string;
  startedAt: number;
  lastActivityAt: number;
  currentPhase: string;
  lastCheckpoint?: string;
}

export interface RunState {
  runId: string;
  status: RunStatus;
  startedAt: string;
  error?: string;
  sessionKey?: SessionKey;
  prompt?: string;
}

export interface AgentPlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface AgentToolLocation {
  path: string;
  line?: number | null;
}

export interface AgentAvailableCommand {
  name: string;
  description: string;
  input?: { hint: string } | null;
}

export type AgentEvent =
  | {
      type: "text_delta";
      text: string;
      messageId?: string;
      phase?: AgentMessagePhase;
    }
  | { type: "thought_delta"; text: string; messageId?: string }
  | {
      type: "tool_start";
      toolCallId?: string;
      name: string;
      kind?: string;
      status?: string;
      input?: unknown;
      content?: unknown[];
      locations?: AgentToolLocation[];
    }
  | {
      type: "tool_update";
      toolCallId: string;
      name?: string;
      status?: string;
      content?: unknown[];
      locations?: AgentToolLocation[];
      output?: unknown;
    }
  | {
      type: "tool_end";
      toolCallId?: string;
      name?: string;
      status?: string;
      content?: unknown[];
      locations?: AgentToolLocation[];
      output?: unknown;
    }
  | { type: "plan"; entries: AgentPlanEntry[] }
  | { type: "plan_update"; plan: unknown }
  | { type: "plan_removed"; planId: string }
  | {
      type: "available_commands_update";
      availableCommands: AgentAvailableCommand[];
    }
  | { type: "current_mode_update"; currentModeId: string }
  | { type: "config_option_update"; configOptions: BackendConfigOption[] }
  | {
      type: "session_info_update";
      title?: string | null;
      updatedAt?: string | null;
    }
  | {
      type: "usage_update";
      used: number;
      size: number;
      cost?: { amount: number; currency: string } | null;
    }
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
  mode?: string;
  claudePermissionMode?: ClaudePermissionMode;
  additionalDirectories?: string[];
  acpConfig?: Record<string, string | boolean>;
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
  type?: "select" | "boolean";
  category?: string;
  /** 适配器当前默认选中的值 */
  currentValue?: string;
  values: BackendConfigOptionValue[];
}

export interface BackendProfile {
  type: "cursor-cli" | "claude-code" | "codex" | "generic-spawn";
  /** ACP spawn 命令；已知 backend type 有内置默认值 */
  acpCommand?: string;
  acpArgs?: string[];
  model?: string;
  effort?: string;
  /** Claude ACP mode 的兼容默认值；飞书非交互场景建议 bypassPermissions */
  claudePermissionMode?: ClaudePermissionMode;
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

export const DEFAULT_DATA_DIR = `${process.env.HOME ?? ""}/.codebridge`;

export const VERSION = "0.1.0";
