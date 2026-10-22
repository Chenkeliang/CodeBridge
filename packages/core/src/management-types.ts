export interface ManagedChannelConnection {
  state: "unconfigured" | "unknown" | "connected" | "disconnected" | "pending" | "applying" | "error";
  canApply: boolean; environmentManaged: boolean; appId?: string; identity?: string;
  message?: string; blockedReason?: string;
}
export interface ChannelVerification { valid: true; identity: string; message: string }
/** Public contracts only. Values are loaded from private per-host runtime configuration. */
export interface ManagedChannel {
  channel: "feishu" | "telegram"; configured: boolean; connected: boolean | null; credentialSource: string;
  administrators: string[]; allowedUsers: string[]; allowedChats: string[];
  connection?: ManagedChannelConnection;
  dmMode?: string; dmAllowlist?: string[]; requireMention?: boolean;
  scenarios?: Array<{ name: string; chats: string[]; requireMention?: boolean; enabled?: boolean }>;
}
export interface ManagedChat { id: string; name: string }
/** The sample is a recent message, not a verified bot display name. */
export interface ManagedAlertSource { id: string; preview: string }
export interface ManagedAlert {
  channel?: "feishu";
  chatId: string; name?: string; senderAppIds: string[]; approverOpenIds: string[]; responsibleOpenIds?: string[];
  runbookPath?: string; enabled: boolean; pollIntervalMs: number;
}
export interface ManagedPublisher { label: string; chatId: string; topicId?: string; routes: string[] }
export interface ManagedCalendar { Hour?: number; Minute?: number; Weekday?: number; Day?: number; Month?: number }
export interface ManagedLocalTask {
  id: string; name: string; source: string; label: string; command: string; calendar: ManagedCalendar[];
  interval: number | null; loaded: boolean; running: boolean; lastExitCode: number | null; revision: string;
}
export interface ManagementSnapshot {
  revision: string; backup?: string; channels: ManagedChannel[]; alerts: ManagedAlert[]; publishers: ManagedPublisher[];
  local: { tasks: ManagedLocalTask[]; issues: Array<{ id: string; name: string; message: string }>; supported: boolean };
}
export interface ManagedRule {
  root: string; entry: string; name: string; description: string; files: string[];
  relative: string; content: string; revision: string; issues?: string[];
}
