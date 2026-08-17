import path from "node:path";
import { appendJsonl } from "@codebridge/core";
import type {
  ActiveRunStatus,
  AgentEvent,
  AppConfig,
  BackendConfigOption,
  RunAttachment,
  RunRequest,
} from "@codebridge/core";
import {
  RunnerClient,
  type CliSessionSummary,
} from "@codebridge/runner-client";
import { SessionRouter } from "./session-router.js";

export interface OrchestratorOptions {
  dataDir: string;
  config: AppConfig;
  onEvent?: (runId: string, event: AgentEvent) => void;
}

export class RunOrchestrator {
  readonly router: SessionRouter;
  private readonly client: RunnerClient;
  private readonly activeChatRuns = new Map<
    string,
    {
      runId: string;
      controller: AbortController;
      startedAt: number;
      lastActivityAt: number;
      currentPhase: string;
      lastCheckpoint?: string;
      checkpointText?: string;
      checkpointMessageId?: string;
      finished?: Promise<void>;
    }
  >();

  constructor(private readonly options: OrchestratorOptions) {
    this.router = new SessionRouter(options.dataDir);
    this.router.initFromConfig(options.config);
    this.client = new RunnerClient({
      baseUrl: options.config.runner.url,
      token: options.config.runner.token,
    });
  }

  updateConfig(config: AppConfig) {
    this.options.config = config;
    this.router.initFromConfig(config);
  }

  private chatRunKey(chatId: string, topicId?: string): string {
    return `${chatId}|${topicId ?? ""}`;
  }

  hasActiveRun(chatId: string, topicId?: string): boolean {
    return this.activeChatRuns.has(this.chatRunKey(chatId, topicId));
  }

  /** 活跃任务已运行的毫秒数；无活跃任务时返回 undefined */
  activeRunElapsedMs(chatId: string, topicId?: string): number | undefined {
    const active = this.activeChatRuns.get(this.chatRunKey(chatId, topicId));
    return active ? Date.now() - active.startedAt : undefined;
  }

  activeRunStatus(
    chatId: string,
    topicId?: string,
  ): ActiveRunStatus | undefined {
    const active = this.activeChatRuns.get(this.chatRunKey(chatId, topicId));
    if (!active) return undefined;
    return {
      runId: active.runId,
      startedAt: active.startedAt,
      lastActivityAt: active.lastActivityAt,
      currentPhase: active.currentPhase,
      ...(active.lastCheckpoint
        ? { lastCheckpoint: active.lastCheckpoint }
        : {}),
    };
  }

  async cancelActiveForChat(
    chatId: string,
    topicId?: string,
  ): Promise<boolean> {
    const key = this.chatRunKey(chatId, topicId);
    const active = this.activeChatRuns.get(key);
    if (!active) return false;
    active.controller.abort();
    await this.client.cancel(active.runId).catch(() => {});
    await active.finished;
    return true;
  }

  async steerActiveForChat(
    chatId: string,
    topicId: string | undefined,
    prompt: string,
  ): Promise<{ ok: boolean; outcome?: string; error?: string }> {
    const active = this.activeChatRuns.get(this.chatRunKey(chatId, topicId));
    if (!active) return { ok: false, error: "当前没有正在运行的任务" };
    return this.client.steer(active.runId, prompt);
  }

  async *runAgent(
    chatId: string,
    topicId: string | undefined,
    prompt: string,
    attachments?: RunAttachment[],
  ): AsyncGenerator<AgentEvent> {
    await this.cancelActiveForChat(chatId, topicId);

    const sessionKey = this.router.buildSessionKey(chatId, topicId);
    const runOpts = this.router.resolveRunOptions(
      chatId,
      topicId,
      this.options.config,
    );
    // 不再从 sessions.json 读取续聊 session（Task 12）。
    const resumeSessionId = undefined;
    const runId = this.router.newRunId();
    const chatKey = this.chatRunKey(chatId, topicId);
    const controller = new AbortController();
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const startedAt = Date.now();
    this.activeChatRuns.set(chatKey, {
      runId,
      controller,
      startedAt,
      lastActivityAt: startedAt,
      currentPhase: "任务启动",
      finished,
    });

    const logPath = path.join(
      this.options.dataDir,
      "logs",
      `${new Date().toISOString().slice(0, 10)}.jsonl`,
    );

    appendJsonl(logPath, {
      event: "intake",
      runId,
      chatId,
      topicId,
      prompt: prompt.slice(0, 200),
      ts: new Date().toISOString(),
    });

    const request: RunRequest = {
      runId,
      sessionKey,
      prompt,
      attachments,
      resumeSessionId,
      model: runOpts.model,
      effort: runOpts.effort,
      mode: runOpts.mode,
      claudePermissionMode: runOpts.claudePermissionMode,
      additionalDirectories: runOpts.additionalDirectories,
      acpConfig: runOpts.acpConfig,
    };

    let sessionId: string | undefined;
    let stopped = false;
    let loggedDone = false;

    const logDone = () => {
      if (loggedDone) return;
      loggedDone = true;
      appendJsonl(logPath, {
        event: "done",
        runId,
        sessionId,
        stopped: controller.signal.aborted || stopped,
        ts: new Date().toISOString(),
      });
    };

    const persistSession = (id?: string) => {
      if (!id) return;
      sessionId = id;
    };

    try {
      try {
        for await (const event of this.client.run(request, {
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) {
            stopped = true;
            break;
          }
          this.options.onEvent?.(runId, event);
          const active = this.activeChatRuns.get(chatKey);
          if (active?.runId === runId) {
            let phase: string | undefined;
            switch (event.type) {
              case "text_delta":
                phase =
                  event.phase === "commentary" ? "任务检查点" : "生成回复";
                if (event.phase === "commentary") {
                  const sameMessage =
                    Boolean(event.messageId) &&
                    active.checkpointMessageId === event.messageId;
                  active.checkpointText = sameMessage
                    ? `${active.checkpointText ?? ""}${event.text}`
                    : event.text;
                  active.checkpointMessageId = event.messageId;
                  const checkpoint = active.checkpointText
                    .replace(/\s+/g, " ")
                    .trim();
                  if (checkpoint) {
                    active.lastCheckpoint =
                      checkpoint.length > 240
                        ? `${checkpoint.slice(0, 239)}…`
                        : checkpoint;
                  }
                }
                break;
              case "thought_delta":
                phase = "分析任务";
                break;
              case "tool_start":
                phase = `工具执行：${event.name}`;
                break;
              case "tool_update":
                phase = event.name
                  ? `工具执行：${event.name}`
                  : active.currentPhase;
                break;
              case "tool_end":
                phase = event.name ? `工具完成：${event.name}` : "工具完成";
                break;
              case "plan":
              case "plan_update":
              case "plan_removed":
                phase = "更新计划";
                break;
              case "permission_request":
                phase = "等待权限确认";
                break;
              default:
                break;
            }
            if (phase) {
              active.lastActivityAt = Date.now();
              active.currentPhase = phase;
            }
          }
          if (event.type === "session") {
            persistSession(event.sessionId);
          }
          yield event;
          if (event.type === "done") break;
        }
      } catch (err) {
        if (controller.signal.aborted) {
          stopped = true;
        } else {
          const message =
            err instanceof Error ? err.message : String(err);
          yield { type: "error", message, fatal: true };
          yield { type: "done", exitCode: 1 };
        }
      }

      // 不再写 sessions.json（Task 12）；session 绑定由 Catalog 权威。
      if (stopped) {
        yield { type: "error", message: "任务已停止", fatal: false };
        yield { type: "done", exitCode: 130 };
      }
    } finally {
      if (this.activeChatRuns.get(chatKey)?.runId === runId) {
        this.activeChatRuns.delete(chatKey);
      }
      logDone();
      resolveFinished();
    }
  }

  async doctor() {
    return this.client.doctor();
  }

  async health() {
    return this.client.health();
  }

  async authorizeDirectory(directory: string) {
    return this.client.authorizeDirectory(directory);
  }

  async listSessions(
    chatId: string,
    topicId?: string,
    options?: { all?: boolean; limit?: number },
  ): Promise<CliSessionSummary[]> {
    const key = this.router.buildSessionKey(chatId, topicId);
    const result = await this.client.listSessions(key.backendId, key.cwd, options);
    if (result.error) {
      throw new Error(result.error);
    }
    return result.sessions;
  }

  /** prompt_feishu：把 /approve /deny 转给当前 run 挂起的权限请求 */
  async resolveActivePermission(
    chatId: string,
    topicId: string | undefined,
    approve: boolean,
  ): Promise<boolean> {
    const active = this.activeChatRuns.get(this.chatRunKey(chatId, topicId));
    if (!active) return false;
    return this.client.resolvePermission(active.runId, approve);
  }

  async listConfigOptions(
    chatId: string,
    topicId?: string,
  ): Promise<BackendConfigOption[]> {
    const key = this.router.buildSessionKey(chatId, topicId);
    const result = await this.client.listConfigOptions(key.backendId, key.cwd);
    if (result.error) throw new Error(result.error);
    return result.options;
  }

  async closeSession(
    chatId: string,
    topicId: string | undefined,
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.manageSession("close", chatId, topicId, sessionId);
  }

  async deleteSession(
    chatId: string,
    topicId: string | undefined,
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.manageSession("delete", chatId, topicId, sessionId);
  }

  private async manageSession(
    action: "close" | "delete",
    chatId: string,
    topicId: string | undefined,
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const key = this.router.buildSessionKey(chatId, topicId);
    // 不再用 sessions.json 判断「当前槽位 session 是否运行中」（Task 12）；
    // 运行中保护由 provider lease + runner 侧处理。
    const result =
      action === "close"
        ? await this.client.closeSession(key.backendId, key.cwd, sessionId)
        : await this.client.deleteSession(key.backendId, key.cwd, sessionId);
    return result;
  }
}

export function agentEventToMarkdown(event: AgentEvent): string {
  switch (event.type) {
    case "text_delta":
      return event.text;
    case "tool_start":
      return `\n🔧 \`${event.name}\` …\n`;
    case "tool_update":
      return `\n↳ \`${event.name ?? "tool"}\`${event.status ? ` (${event.status})` : ""}\n`;
    case "tool_end":
      return `\n✓ \`${event.name ?? "tool"}\`\n`;
    case "error":
      return `\n❌ ${event.message}\n`;
    case "done":
      return event.exitCode === 0 ? "" : `\n（退出码 ${event.exitCode}）\n`;
    default:
      return "";
  }
}
