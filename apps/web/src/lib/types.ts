import type { SessionEventWire } from "@codebridge/core/session-event-wire";

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
  flow_definition_revision: string | null;
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

export interface FlowInputRecord {
  id: string;
  type: string;
  source: string;
  required: boolean;
  default?: unknown;
  description?: string | null;
}

export interface FlowStepRecord {
  id: string;
  capability: string | null;
  purpose: string | null;
  depends_on: string[];
  mode: string | null;
  approval: "none" | "required";
  branches: Array<{ when: string; next: string }>;
  retry: { max_attempts: number; delay_ms: number } | null;
  success_when: string | null;
}

export interface FlowRecord {
  flow_id: string;
  name: string | null;
  description: string | null;
  kind: "ephemeral" | "guide" | "runbook";
  status: "draft" | "candidate" | "published" | "deprecated";
  source: string;
  definition_revision: string;
  plan_ir_hash: string | null;
  inputs: FlowInputRecord[];
  steps: FlowStepRecord[];
  review_status: string | null;
  git_revision: string | null;
  validation_issues: string[];
  lineage_root_flow_id: string;
  parent_flow_id: string | null;
  provenance: FlowProvenance | null;
  publication_sequence: number;
  created_at: string;
  updated_at: string;
}

export interface FlowProvenance {
  source_run_id: string;
  source_session_id: string;
  source_flow_id: string;
  source_definition_revision: string;
  source_request_id?: string;
}

export interface FlowSaveRequest {
  request_id: string;
  session_id: string;
  request_turn_id: string;
  request_run_id: string;
  source_turn_id: string;
  source_run_id: string;
  source: "agent_intent" | "turn_action";
  user_message: string;
  intent_summary: string | null;
  name_hint: string | null;
  source_imported: boolean;
  created_at: string;
}

export type FlowSaveRequestState =
  | { state: "requested"; request: FlowSaveRequest }
  | { state: "dismissed"; request: FlowSaveRequest }
  | {
      state: "completed";
      request: FlowSaveRequest;
      flow_id: string;
      definition_revision: string;
    }
  | { state: "failed"; request: FlowSaveRequest; code: string };

export interface FlowSaveConfirmResult {
  state: "completed";
  request: FlowSaveRequest;
  flow: FlowRecord;
}

export interface FlowEvidence {
  run_id: string;
  session_id: string | null;
  status: "succeeded";
  definition_revision: string;
  plan_ir_hash: string;
  created_at: string;
  updated_at: string;
}

export interface FlowSemanticDiff {
  name_changed: boolean;
  description_changed: boolean;
  inputs: { added: string[]; removed: string[]; changed: string[] };
  steps: { added: string[]; removed: string[]; changed: string[]; reordered: boolean };
}

export interface FlowHistoryEntry {
  id: number;
  flow_id: string;
  definition_revision: string;
  action: "created" | "definition_updated" | "review_approved" | "review_rejected" | "deprecated";
  snapshot: FlowRecord;
  created_at: string;
}

export interface FlowReviewContext {
  flow: FlowRecord;
  base: FlowRecord | null;
  diff: FlowSemanticDiff;
  provenance: FlowProvenance | null;
  evidence: FlowEvidence[];
  history: FlowHistoryEntry[];
}

export interface FlowCapability {
  id: string;
  adapter: string;
  risk: "read_only" | "workspace_write" | "git_write" | "production_write";
  description: string | null;
  side_effects: boolean | null;
}

export interface FlowRecommendation {
  recommendation_id: string;
  session_id: string;
  run_id: string;
  flow_id: string;
  definition_revision: string;
  reason: string;
  extracted_inputs: Record<string, unknown>;
  status: "pending" | "dismissed" | "accepted" | "stale";
  created_at: string;
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

export type SkillAgentId = "codex" | "claude" | "cursor" | "opencode" | "pi";
export type SkillSourceKind = "shared" | "disabled" | "adopted" | "agent_native";
export type SkillGlobalState = "enabled" | "disabled" | "split_brain" | "external" | "invalid";
export type SkillDeliveryMode = "shared_native" | "symlink_projection";
export type SkillOwnership = "codebridge_managed" | "external_observed" | "native_managed";
export type SkillProjectionState = "follows_global" | "linked" | "absent" | "conflict" | "broken";
export type SkillAssignmentAction = "create_link" | "remove_link" | "noop" | "conflict";

export interface SkillTargetView {
  agent_id: SkillAgentId;
  delivery_mode: SkillDeliveryMode;
  target_path: string;
  state: SkillProjectionState;
  mutable: boolean;
  detail: string | null;
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string | null;
  source_path: string;
  source_kind: SkillSourceKind;
  package_revision: string;
  revision: string;
  global_state: SkillGlobalState;
  ownership: SkillOwnership;
  can_apply: boolean;
  tags: string[];
  updated_at: string;
  targets: SkillTargetView[];
}

export interface SkillTargetDefinition {
  agent_id: SkillAgentId;
  display_name: string;
  root_path: string;
  delivery_mode: SkillDeliveryMode;
}

export interface SkillCatalogSnapshot {
  skills: SkillCatalogEntry[];
  targets: SkillTargetDefinition[];
  summary: { total: number; sources: number; linked: number; issues: number; recovery_required?: number };
  scanned_at: string;
}

export interface SkillAssignmentInput {
  skill_id: string;
  agent_id: SkillAgentId;
  enabled: boolean;
}

export interface SkillAssignmentPreview {
  skill_id: string;
  skill_name: string;
  agent_id: SkillAgentId;
  enabled: boolean;
  source_path: string;
  target_path: string;
  current_state: SkillProjectionState;
  action: SkillAssignmentAction;
  detail: string | null;
  can_apply: boolean;
}

export interface SkillAssignmentResult extends SkillAssignmentPreview {
  state: SkillProjectionState;
}

export type SkillMutationKind = "adopt" | "global_state" | "assignment" | "unmanage";

export interface SkillMutationStep {
  action: "move" | "create_link" | "remove_link" | "set_ownership" | "set_assignment";
  source_path?: string;
  target_path?: string;
  detail: string;
}

export interface SkillMutationPlan {
  plan_id: string;
  kind: SkillMutationKind;
  skill_id: string;
  package_revision: string;
  source_path: string;
  target_path: string;
  expires_at: string;
  steps: SkillMutationStep[];
  can_apply: boolean;
  detail: string | null;
  request: { enabled?: boolean; agent_id?: SkillAgentId };
}

export interface SkillMutationResult {
  plan_id: string;
  transaction_id: string;
  snapshot: SkillCatalogSnapshot;
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

export type SessionEvent = SessionEventWire;

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
  queue_pause_reason: "failed" | "cancelled" | "interrupted" | "stale" | null;
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
  kind: "user_message" | "assistant" | "thought" | "work" | "tool" | "approval" | "error" | "flow_param" | "flow_step" | "flow_run" | "flow_failure" | "flow_batch" | "flow_save_request";
  status: string;
  metadata: Record<string, unknown>;
  segments: TimelineSegmentView[];
  next_segment_cursor: number | null;
}

export interface FlowBatchIssue {
  code: "missing" | "ambiguous" | "invalid_type" | "invalid_value" | "duplicate" | "conflict";
  field: string | null;
  message: string;
  blocking: boolean;
}

export interface FlowBatchEvidence {
  source: "user" | "agent_extracted" | "context" | "default";
  evidence_ref: string;
  inferred: boolean;
}

export interface FlowBatchDraftItem {
  item_id: string;
  ordinal: number;
  label: string | null;
  inputs: Record<string, unknown>;
  evidence: Record<string, FlowBatchEvidence>;
  issues: FlowBatchIssue[];
}

export interface FlowBatchDraft {
  schema_version: 1;
  draft_id: string;
  session_id: string;
  source_run_id: string;
  flow_id: string;
  definition_revision: string;
  status: "needs_input" | "ready" | "confirmed" | "stale" | "cancelled";
  revision: number;
  global_inputs: Record<string, unknown>;
  items: FlowBatchDraftItem[];
  source_refs: string[];
  created_at: string;
  updated_at: string;
}

export interface FlowBatchItemSnapshot {
  item_id: string;
  ordinal: number;
  attempt: number;
  run_id: string;
  input_hash: string;
  inputs: Record<string, unknown>;
  status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "interrupted";
  terminal_reason: string | null;
  supersedes_run_id: string | null;
}

export interface FlowBatchSnapshot {
  batch_id: string;
  draft_id: string;
  session_id: string;
  flow_id: string;
  definition_revision: string;
  plan_ir_hash: string;
  concurrency: number;
  failure_policy: "continue";
  cancel_requested_at: string | null;
  status: "queued" | "running" | "succeeded" | "partial_succeeded" | "failed" | "cancelled";
  counts: Record<FlowBatchItemSnapshot["status"] | "total", number>;
  items: FlowBatchItemSnapshot[];
  created_at: string;
  updated_at: string;
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

export interface ProviderHistoryPreview {
  providerSessionId: string;
  importedPosition: number;
  providerPosition: number;
  importableEvents: number;
  nextDigest: string;
}

export interface ProviderHistoryImportResult {
  importedEvents: number;
  importedTurns: number;
  lastEventSequence: number;
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
  flowId?: string | null;
  definitionRevision?: string;
  model: string | null;
  attachments: MessageAttachmentInput[];
  permissionMode: string | null;
  effort: string | null;
  idempotencyKey: string;
  inputs?: Record<string, unknown>;
  dryRun?: boolean;
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
