import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  JsonMapStore,
  serializeSessionKey,
  type AppConfig,
  type BackendProfile,
  type SessionKey,
  type SessionRecord,
} from "@feishu-code-bridge/core";

export interface ChatBinding {
  backendId: string;
  cwd: string;
  topicId?: string;
  model?: string;
  effort?: string;
}

export interface ResolvedRunOptions {
  model?: string;
  effort?: string;
}

export class SessionRouter {
  private readonly sessions: JsonMapStore<SessionRecord>;
  private readonly workspaces: JsonMapStore<string>;
  private readonly bindings: JsonMapStore<ChatBinding>;

  constructor(dataDir: string) {
    this.sessions = new JsonMapStore<SessionRecord>(
      path.join(dataDir, "sessions.json"),
    );
    this.workspaces = new JsonMapStore<string>(
      path.join(dataDir, "workspaces.json"),
    );
    this.bindings = new JsonMapStore<ChatBinding>(
      path.join(dataDir, "chat-bindings.json"),
    );
  }

  private bindingKey(chatId: string, topicId?: string): string {
    return `${chatId}|${topicId ?? ""}`;
  }

  getBinding(chatId: string, topicId?: string): ChatBinding {
    const key = this.bindingKey(chatId, topicId);
    const stored = this.bindings.read()[key];
    if (stored) return { ...stored };
    const config: ChatBinding = {
      backendId: this.config?.defaultBackend ?? "cursor",
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
    return {
      model: rawModel,
      effort: rawEffort,
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

  getSessionRecord(key: SessionKey): SessionRecord | undefined {
    return this.sessions.read()[serializeSessionKey(key)];
  }

  saveSessionRecord(key: SessionKey, record: SessionRecord): void {
    const id = serializeSessionKey(key);
    this.sessions.update((all) => ({ ...all, [id]: record }));
  }

  bindCliSession(
    chatId: string,
    cliSessionId: string,
    topicId?: string,
  ): void {
    const key = this.buildSessionKey(chatId, topicId);
    const existing = this.getSessionRecord(key);
    this.saveSessionRecord(key, {
      cliSessionId,
      lastRunAt: existing?.lastRunAt ?? new Date().toISOString(),
      lastRunId: existing?.lastRunId,
    });
  }

  clearSession(chatId: string, topicId?: string): void {
    const key = this.buildSessionKey(chatId, topicId);
    const id = serializeSessionKey(key);
    this.sessions.update((all) => {
      const next = { ...all };
      delete next[id];
      return next;
    });
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
