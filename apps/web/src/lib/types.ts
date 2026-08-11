import type { ConversationEvent } from "./events";

export interface AgentProfile {
  agent_id: string;
  display_name: string;
  adapter: "sdk" | "acp" | "cli";
  status: "healthy" | "unavailable" | "needs_setup";
  capabilities: string[];
  models: string[];
  session_features: string[];
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
