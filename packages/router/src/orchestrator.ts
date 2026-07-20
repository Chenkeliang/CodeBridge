import path from "node:path";
import { appendJsonl } from "@feishu-code-bridge/core";
import type { AgentEvent, AppConfig, BackendConfigOption, BackendTransport, RunAttachment, RunRequest, SessionRecord } from "@feishu-code-bridge/core";
import {
  RunnerClient,
  type CliSessionSummary,
} from "@feishu-code-bridge/runner-client";
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
    { runId: string; controller: AbortController; startedAt: number }
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

  async cancelActiveForChat(
    chatId: string,
    topicId?: string,
  ): Promise<boolean> {
    const key = this.chatRunKey(chatId, topicId);
    const active = this.activeChatRuns.get(key);
    if (!active) return false;
    active.controller.abort();
    await this.client.cancel(active.runId).catch(() => {});
    this.activeChatRuns.delete(key);
    return true;
  }

  async *runAgent(
    chatId: string,
    topicId: string | undefined,
    prompt: string,
    attachments?: RunAttachment[],
  ): AsyncGenerator<AgentEvent> {
    await this.cancelActiveForChat(chatId, topicId);

    const sessionKey = this.router.buildSessionKey(chatId, topicId);
    const existing = this.router.getSessionRecord(sessionKey);
    const runOpts = this.router.resolveRunOptions(
      chatId,
      topicId,
      this.options.config,
    );
    const resumeSessionId = this.resumeSessionId(existing, runOpts.transport);
    const runId = this.router.newRunId();
    const chatKey = this.chatRunKey(chatId, topicId);
    const controller = new AbortController();
    this.activeChatRuns.set(chatKey, { runId, controller, startedAt: Date.now() });

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
      claudePermissionMode: runOpts.claudePermissionMode,
      transport: runOpts.transport,
    };

    let cliSessionId = resumeSessionId ?? existing?.cliSessionId;
    let stopped = false;
    let loggedDone = false;

    const logDone = () => {
      if (loggedDone) return;
      loggedDone = true;
      appendJsonl(logPath, {
        event: "done",
        runId,
        cliSessionId,
        stopped: controller.signal.aborted || stopped,
        ts: new Date().toISOString(),
      });
    };

    const persistSession = (id?: string) => {
      if (!id) return;
      cliSessionId = id;
      this.router.saveSessionRecord(sessionKey, {
        cliSessionId: id,
        transport: runOpts.transport,
        lastRunAt: new Date().toISOString(),
        lastRunId: runId,
      });
    };

    try {
      for await (const event of this.client.run(request, {
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) {
          stopped = true;
          break;
        }
        this.options.onEvent?.(runId, event);
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
    } finally {
      this.activeChatRuns.delete(chatKey);
      logDone();
    }

    if (stopped) {
      yield { type: "error", message: "任务已停止", fatal: false };
      yield { type: "done", exitCode: 130 };
    }

    this.router.saveSessionRecord(sessionKey, {
      cliSessionId,
      transport: runOpts.transport,
      lastRunAt: new Date().toISOString(),
      lastRunId: runId,
    });
  }

  async doctor() {
    return this.client.doctor();
  }

  async health() {
    return this.client.health();
  }

  /** CLI 与 ACP 的 sessionId 不互通；无 transport 标记的旧记录按 CLI 处理 */
  private resumeSessionId(
    existing: SessionRecord | undefined,
    transport: BackendTransport,
  ): string | undefined {
    if (!existing?.cliSessionId) return undefined;
    const recorded = existing.transport ?? "cli";
    return recorded === transport ? existing.cliSessionId : undefined;
  }

  async listCliSessions(
    chatId: string,
    topicId?: string,
    options?: { all?: boolean; limit?: number },
  ): Promise<CliSessionSummary[]> {
    const key = this.router.buildSessionKey(chatId, topicId);
    const runOpts = this.router.resolveRunOptions(
      chatId,
      topicId,
      this.options.config,
    );
    const result = await this.client.listSessions(
      key.backendId,
      key.cwd,
      { ...options, transport: runOpts.transport },
    );
    if (result.error) {
      throw new Error(result.error);
    }
    return result.sessions;
  }

  bindCliSession(
    chatId: string,
    topicId: string | undefined,
    cliSessionId: string,
  ): void {
    const runOpts = this.router.resolveRunOptions(
      chatId,
      topicId,
      this.options.config,
    );
    this.router.bindCliSession(chatId, cliSessionId, runOpts.transport, topicId);
  }

  /** /model 动态列表：适配器 advertise 的配置项，按 backend|cwd 缓存（拉一次要短暂 spawn 适配器） */
  private readonly configOptionsCache = new Map<
    string,
    { at: number; options: BackendConfigOption[] }
  >();

  async listConfigOptions(
    chatId: string,
    topicId?: string,
  ): Promise<BackendConfigOption[]> {
    const key = this.router.buildSessionKey(chatId, topicId);
    const runOpts = this.router.resolveRunOptions(
      chatId,
      topicId,
      this.options.config,
    );
    if (runOpts.transport !== "acp") return [];
    const cacheKey = `${key.backendId}|${key.cwd}`;
    const cached = this.configOptionsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CONFIG_OPTIONS_CACHE_MS) {
      return cached.options;
    }
    const result = await this.client.listConfigOptions(key.backendId, key.cwd, {
      transport: runOpts.transport,
    });
    if (result.error) throw new Error(result.error);
    // 空结果不缓存：多半是适配器未就绪/超时，下次 /model 再试
    if (result.options.length > 0) {
      this.configOptionsCache.set(cacheKey, {
        at: Date.now(),
        options: result.options,
      });
    }
    return result.options;
  }
}

const CONFIG_OPTIONS_CACHE_MS = 10 * 60 * 1000;

export function agentEventToMarkdown(event: AgentEvent): string {
  switch (event.type) {
    case "text_delta":
      return event.text;
    case "tool_start":
      return `\n🔧 \`${event.name}\` …\n`;
    case "tool_end":
      return `\n✓ \`${event.name}\`\n`;
    case "error":
      return `\n❌ ${event.message}\n`;
    case "done":
      return event.exitCode === 0 ? "" : `\n（退出码 ${event.exitCode}）\n`;
    default:
      return "";
  }
}
