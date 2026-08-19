import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  JsonMapStore,
  canonicalWorkspaceKey,
  resolveDefaultAgentId,
  serializeSessionKey,
  type AppConfig,
  type BackendProfile,
  type ClaudePermissionMode,
  type SessionKey,
} from "@codebridge/core";

export interface ChatBinding {
  backendId: string;
  cwd: string;
  topicId?: string;
  model?: string;
  effort?: string;
  mode?: string;
  claudePermissionMode?: ClaudePermissionMode;
  additionalDirectories?: string[];
  acpConfig?: Record<string, string | boolean>;
  /** 卡片是否展示思考/工具过程；缺省=true（显示）。纯展示偏好，切 backend 不清除 */
  showThinking?: boolean;
}

export interface ResolvedRunOptions {
  model?: string;
  effort?: string;
  mode?: string;
  claudePermissionMode?: ClaudePermissionMode;
  additionalDirectories?: string[];
  acpConfig?: Record<string, string | boolean>;
}

export class SessionRouter {
  private readonly workspaces: JsonMapStore<string>;
  private readonly bindings: JsonMapStore<ChatBinding>;
  private readonly generations: JsonMapStore<number>;

  constructor(dataDir: string) {
    this.workspaces = new JsonMapStore<string>(
      path.join(dataDir, "workspaces.json"),
    );
    this.bindings = new JsonMapStore<ChatBinding>(
      path.join(dataDir, "chat-bindings.json"),
    );
    this.generations = new JsonMapStore<number>(
      path.join(dataDir, "slot-generations.json"),
    );
  }

  private bindingKey(chatId: string, topicId?: string): string {
    return `${chatId}|${topicId ?? ""}`;
  }

  private slotKey(chatId: string, topicId?: string): string {
    const binding = this.getBinding(chatId, topicId);
    return serializeSessionKey({
      chatId,
      topicId,
      backendId: binding.backendId,
      cwd: canonicalWorkspaceKey(binding.cwd).key,
    });
  }

  /** 当前槽位（backend+cwd）指向第几代 Session，默认 0。 */
  getSlotGeneration(chatId: string, topicId?: string): number {
    return this.generations.read()[this.slotKey(chatId, topicId)] ?? 0;
  }

  /** /new 对当前槽位 +1，返回新 generation。 */
  incrementSlotGeneration(chatId: string, topicId?: string): number {
    const key = this.slotKey(chatId, topicId);
    const next = (this.generations.read()[key] ?? 0) + 1;
    this.generations.update((all) => ({ ...all, [key]: next }));
    return next;
  }

  /** 供 bridge 组装 ingress 消息的槽位描述（agent/cwd 已规范化）。 */
  buildSlot(chatId: string, topicId?: string): {
    agentId: string;
    workspaceKey: string;
    generation: number;
  } {
    const binding = this.getBinding(chatId, topicId);
    return {
      agentId: binding.backendId,
      workspaceKey: canonicalWorkspaceKey(binding.cwd).key,
      generation: this.getSlotGeneration(chatId, topicId),
    };
  }

  getBinding(chatId: string, topicId?: string): ChatBinding {
    const key = this.bindingKey(chatId, topicId);
    const stored = this.bindings.read()[key];
    if (stored) return { ...stored };
    // 话题级绑定缺省时继承所在会话的绑定（backend/cwd/model 等）；
    // 不落盘，话题内显式 setBinding 时才写入话题级覆盖
    if (topicId) return this.getBinding(chatId);
    const config: ChatBinding = {
      backendId: this.config
        ? resolveDefaultAgentId(this.config)
        : "cursor",
      cwd: this.defaultCwd,
    };
    this.bindings.update((all) => ({ ...all, [key]: config }));
    return { ...config };
  }

  setBinding(chatId: string, binding: Partial<ChatBinding>, topicId?: string) {
    const key = this.bindingKey(chatId, topicId);
    const current = this.getBinding(chatId, topicId);
    const next: ChatBinding = { ...current, ...binding };
    this.bindings.update((all) => ({ ...all, [key]: next }));
  }

  clearModel(chatId: string, topicId?: string): void {
    const key = this.bindingKey(chatId, topicId);
    this.bindings.update((all) => {
      const current = all[key];
      if (!current) return all;
      const next = { ...current };
      delete next.model;
      return { ...all, [key]: next };
    });
  }

  clearEffort(chatId: string, topicId?: string): void {
    const key = this.bindingKey(chatId, topicId);
    this.bindings.update((all) => {
      const current = all[key];
      if (!current) return all;
      const next = { ...current };
      delete next.effort;
      return { ...all, [key]: next };
    });
  }

  clearClaudePermissionMode(chatId: string, topicId?: string): void {
    const key = this.bindingKey(chatId, topicId);
    this.bindings.update((all) => {
      const current = all[key];
      if (!current) return all;
      const next = { ...current };
      delete next.claudePermissionMode;
      return { ...all, [key]: next };
    });
  }

  clearMode(chatId: string, topicId?: string): void {
    const key = this.bindingKey(chatId, topicId);
    this.bindings.update((all) => {
      const current = all[key];
      if (!current) return all;
      const next = { ...current };
      delete next.mode;
      return { ...all, [key]: next };
    });
  }

  clearAcpConfig(chatId: string, topicId?: string): void {
    const key = this.bindingKey(chatId, topicId);
    this.bindings.update((all) => {
      const current = all[key];
      if (!current) return all;
      const next = { ...current };
      delete next.acpConfig;
      return { ...all, [key]: next };
    });
  }

  /** 切换 backend 时清除 model/effort/permission 会话覆盖 */
  clearRunOverrides(chatId: string, topicId?: string): void {
    this.clearModel(chatId, topicId);
    this.clearEffort(chatId, topicId);
    this.clearMode(chatId, topicId);
    this.clearClaudePermissionMode(chatId, topicId);
    this.clearAcpConfig(chatId, topicId);
  }

  resolveRunOptions(
    chatId: string,
    topicId: string | undefined,
    config: AppConfig,
  ): ResolvedRunOptions {
    const binding = this.getBinding(chatId, topicId);
    const profile: BackendProfile | undefined =
      config.backends[binding.backendId];
    const rawModel = binding.model ?? profile?.model;
    const rawEffort = binding.effort ?? profile?.effort;
    const rawPermission =
      binding.claudePermissionMode ?? profile?.claudePermissionMode;
    return {
      model: rawModel,
      effort: rawEffort,
      mode: binding.mode ?? rawPermission,
      claudePermissionMode: rawPermission,
      additionalDirectories: binding.additionalDirectories,
      acpConfig: binding.acpConfig,
    };
  }

  private defaultCwd = process.cwd();
  private config!: AppConfig;

  initFromConfig(config: AppConfig) {
    const cwd =
      config.workspaces?.default ??
      config.workspaces?.root ??
      process.cwd();
    this.defaultCwd = cwd;
    this.config = config;
  }

  buildSessionKey(chatId: string, topicId?: string): SessionKey {
    const b = this.getBinding(chatId, topicId);
    return {
      chatId,
      topicId,
      backendId: b.backendId,
      cwd: b.cwd,
    };
  }

  listWorkspaceNames(): Record<string, string> {
    return this.workspaces.read();
  }

  saveWorkspace(name: string, cwd: string): void {
    this.workspaces.update((all) => ({ ...all, [name]: cwd }));
  }

  removeWorkspace(name: string): void {
    this.workspaces.update((all) => {
      const next = { ...all };
      delete next[name];
      return next;
    });
  }

  newRunId(): string {
    return randomUUID();
  }
}
