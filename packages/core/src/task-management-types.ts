export type TaskNotificationMode = "result" | "errors" | "progress";
export interface AgentTaskTarget { channel: "local" | "feishu" | "telegram"; chatId?: string; topicId?: string }
export interface AgentTaskDraft {
  name: string;
  prompt: string;
  agentId: string;
  cwd: string;
  skills: string[];
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  schedule: string;
  timezone: string;
  catchUp: "once" | "skip";
  notification: TaskNotificationMode;
  target: AgentTaskTarget;
  enabled: boolean;
}
export type AgentTaskSchedule =
  | { kind: "once"; at: string; label: string }
  | { kind: "interval"; minutes: number; label: string }
  | { kind: "cron"; expression: string; label: string };
export interface AgentTaskDefinition extends AgentTaskDraft {
  id: string; version: number; createdAt: string; updatedAt: string;
  parsedSchedule: AgentTaskSchedule;
  nextRunAt: string | null; activeAttemptId: string | null;
  lastRunAt: string | null; pausedReason: string | null;
}
export type AgentTaskAttemptStatus = "claimed" | "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "interrupted" | "skipped";
export type TaskNoticeState = "sending" | "sent" | "failed" | "unknown" | "acknowledged";
export interface TaskNotice {
  id: string; attemptId: string; kind: "start" | "progress" | "approval" | "result" | "resend" | "acknowledgement";
  state: TaskNoticeState; text: string; error: string | null; messageId: string | null;
  createdAt: string; finishedAt: string | null;
}
export interface AgentTaskAttempt {
  id: string; taskId: string; trigger: "scheduled" | "manual" | "retry";
  scheduledAt: string; startedAt: string; finishedAt: string | null;
  status: AgentTaskAttemptStatus; reason: string | null; outcomeUncertain: boolean;
  sessionId: string; runId: string | null; turnId: string | null; workItemId: string | null;
  definition: AgentTaskDraft;
  retryOf: string | null;
  result: string;
  deliveryState: "pending" | "sent" | "failed" | "unknown" | "suppressed" | "local" | "acknowledged";
}
export interface TaskFile {
  id: string; attemptId: string; name: string; path: string; size: number; sha256: string; createdAt: string; deliveryOwner: "task" | "agent";
}
export interface AgentTaskAttemptDetail {
  attempt: AgentTaskAttempt; notices: TaskNotice[]; files: TaskFile[]; sessionAvailable: boolean;
  events: Array<{ sequence: number; type: string; at: string; summary: string }>;
  eventsTruncated: boolean;
}
export interface TaskPreflight {
  valid: boolean;
  checks: Array<{ name: string; ok: boolean; message: string }>;
  schedule: AgentTaskSchedule;
  nextRuns: string[];
}
export interface AgentTaskOptions {
  agents: Array<{ id: string; name: string; ready: boolean }>;
  skills: Array<{ id: string; name: string; description: string; agentIds: string[] }>;
  targets: Array<{ label: string; target: AgentTaskTarget }>;
  defaultCwd: string;
  timezone: string;
}
export interface TaskAttentionItem {
  id: string; kind: "runtime_approval" | "agent_permission" | "paused_queue" | "failed_run" | "task_delivery";
  title: string; summary: string; sessionId: string | null; agentId: string | null;
  runId: string | null; taskId?: string; attemptId?: string;
  updatedAt: string; approvalId?: string; expiresAt?: string | null;
}
export interface AlertIncidentView {
  id: string; chatId: string; status: string; summary: string; content: string;
  senderAppId: string; firstSeenAt: string; lastSeenAt: string;
  repeatCount: number; sourceMessageIds: string[];
  responsibleOpenIds: string[]; approverOpenIds: string[];
  sessionId: string | null;
  dismissal: { reason: string; at: string } | null;
}
