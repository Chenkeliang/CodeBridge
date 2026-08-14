import type { ConversationEvent } from "./events";

export interface AgentDiagnostic {
  stage: "detect" | "install" | "configure" | "health";
  code: string;
  message: string;
  details?: string;
  exit_code?: number;
}

export interface AgentInstallStrategy {
  id: string;
  label: string;
  command: string;
  args: string[];
  available: boolean;
  requires_confirmation: true;
}

export interface AgentSetupManifest {
  agent_id: string;
  display_name: string;
  adapter: "sdk" | "acp" | "cli";
  install_strategies: AgentInstallStrategy[];
  configuration_owner: "codebridge" | "agent";
  configuration_path?: string;
  documentation_url?: string;
  supports_managed_configuration: boolean;
}

export interface AgentSetupState {
  installation: "installed" | "missing" | "unknown";
  configuration: "configured" | "needs_configuration" | "unknown";
  runtime: "healthy" | "unavailable" | "not_started";
  version?: string;
  executable_path?: string;
  diagnostic?: AgentDiagnostic;
  can_select_default: boolean;
  can_create_session: boolean;
}

export interface AgentProfile {
  agent_id: string;
  display_name: string;
  adapter: "sdk" | "acp" | "cli";
  status: "healthy" | "unavailable" | "needs_setup";
  capabilities: string[];
  models: string[];
  session_features: string[];
  setup?: AgentSetupState;
  setup_manifest?: AgentSetupManifest;
}

export interface AgentListResponse {
  agents: AgentProfile[];
  default_agent_id: string | null;
  effective_default_agent_id: string | null;
}

export interface AgentSession {
  session_id: string;
  agent_id: string;
  provider_session_id: string | null;
  task_record_id: string | null;
  flow_id: string | null;
  model: string | null;
  effort: string | null;
  config_overrides?: Record<string, string | boolean>;
  permission_mode: string | null;
  cwd: string | null;
  additional_directories: string[];
  title: string | null;
  status: string;
  pinned_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowRecord {
  flow_id: string;
  name: string | null;
  kind: "ephemeral" | "guide" | "runbook";
  status: "draft" | "candidate" | "published" | "deprecated";
  source: string;
  definition_revision: string;
}

export interface ConfigOptionValue {
  value: string;
  name?: string;
  description?: string;
}

export interface ConfigOption {
  id: string;
  name: string;
  type: string;
  category?: string;
  currentValue?: string;
  values: ConfigOptionValue[];
}

export interface AgentCommand {
  name: string;
  description: string;
  input?: { hint: string };
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  absolutePath: string;
  kind: "directory" | "file";
}

export interface WorkspaceListing {
  ok: boolean;
  root?: string;
  path?: string;
  relativePath?: string;
  entries: WorkspaceEntry[];
  error?: string;
}

export interface MessageAttachmentInput {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export interface RunRecord {
  run_id: string;
  status: string;
}

export interface ApprovalRecord {
  id: string;
  run_id: string;
  step_id: string;
  capability_id: string;
  session_id: string;
  environment: string;
  target_resource: string;
  status: "requested" | "granted" | "revoked" | "expired" | string;
  created_at: string;
  expires_at: string | null;
}

export type SessionEvent = ConversationEvent & {
  actor?: string;
  target?: string | null;
};

export type SessionRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface SessionRuntimeView {
  active_run: RunRecord | null;
  queue_state: "ready" | "paused";
  queue_pause_reason: "failed" | "cancelled" | "interrupted" | null;
  queue: {
    turns: SessionTurnView[];
    total: number;
    next_cursor: number | null;
  };
  version: number;
  last_event_sequence: number;
}

export interface SessionTurnView {
  turn_id: string;
  queue_position: number;
  status: "queued" | "dispatched" | "cancelled";
  version: number;
  message: {
    text: string;
    attachment_ids: string[];
  };
  created_at: string;
}

export interface TimelineSegmentView {
  segment_id: string;
  segment_index: number;
  content: string;
  byte_length: number;
  sealed: boolean;
}

export interface TimelineBlockView {
  block_id: string;
  block_index: number;
  kind: "user_message" | "assistant" | "thought" | "work" | "tool" | "approval" | "error";
  status: string;
  metadata: Record<string, unknown>;
  segments: TimelineSegmentView[];
  next_segment_cursor: number | null;
}

export interface TimelineTurnView {
  timeline_index: number;
  turn_id: string;
  run_id: string;
  status: SessionRunStatus;
  blocks: TimelineBlockView[];
}

export interface SessionTimelinePage {
  turns: TimelineTurnView[];
  previous_cursor: number | null;
  truncated_block_ids: string[];
}

export interface TimelineSegmentPage {
  segments: TimelineSegmentView[];
  next_cursor: number | null;
}

export interface SessionSnapshot {
  session: AgentSession;
  runtime: SessionRuntimeView;
  timeline: SessionTimelinePage;
  commands: AgentCommand[];
}

export interface SessionCompositeSnapshot extends SessionSnapshot {
  events: SessionEvent[];
  options: ConfigOption[];
  runs: RunRecord[];
}

export interface SubmitTurnReceipt {
  acceptance: "queued" | "dispatched";
  turn: SessionTurnView;
  runtime: SessionRuntimeView;
}

export interface SessionMessageReceipt extends SubmitTurnReceipt {
  event_id: string;
  sequence: number;
}

export interface SessionCancelRunResult {
  disposition: "cancelled" | "interrupting" | "already_terminal";
  run: RunRecord;
}

export interface SendMessageInput {
  message: string;
  flowId: string | null;
  model: string | null;
  attachments: MessageAttachmentInput[];
  permissionMode: string | null;
  effort: string | null;
  idempotencyKey: string;
}

export interface PiProviderModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface PiProvider {
  baseUrl: string;
  api: string;
  apiKey?: string;
  authHeader?: boolean;
  models: PiProviderModel[];
  [key: string]: unknown;
}

export interface PiProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  models: PiProviderModel[];
}
