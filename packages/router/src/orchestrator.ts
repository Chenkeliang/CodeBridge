import path from "node:path";
import { appendJsonl } from "@feishu-code-bridge/core";
import type { AgentEvent, AppConfig, RunRequest } from "@feishu-code-bridge/core";
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
    { runId: string; controller: AbortController }
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
  ): AsyncGenerator<AgentEvent> {
    await this.cancelActiveForChat(chatId, topicId);

    const sessionKey = this.router.buildSessionKey(chatId, topicId);
    const existing = this.router.getSessionRecord(sessionKey);
    const runOpts = this.router.resolveRunOptions(
      chatId,
      topicId,
      this.options.config,
    );
    const runId = this.router.newRunId();
    const chatKey = this.chatRunKey(chatId, topicId);
    const controller = new AbortController();
    this.activeChatRuns.set(chatKey, { runId, controller });

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
      resumeSessionId: existing?.cliSessionId,
      model: runOpts.model,
      effort: runOpts.effort,
    };

    let cliSessionId = existing?.cliSessionId;
    let stopped = false;

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
          cliSessionId = event.sessionId;
        }
        yield event;
        if (event.type === "done") break;
      }
    } catch (err) {
      if (controller.signal.aborted) {
        stopped = true;
      } else {
        throw err;
      }
    } finally {
      this.activeChatRuns.delete(chatKey);
    }

    if (stopped) {
      yield { type: "error", message: "任务已停止", fatal: false };
      yield { type: "done", exitCode: 130 };
    }

    this.router.saveSessionRecord(sessionKey, {
      cliSessionId,
      lastRunAt: new Date().toISOString(),
      lastRunId: runId,
    });

    appendJsonl(logPath, {
      event: "done",
      runId,
      cliSessionId,
      stopped: controller.signal.aborted,
      ts: new Date().toISOString(),
    });
  }

  async doctor() {
    return this.client.doctor();
  }

  async health() {
    return this.client.health();
  }

  async listCliSessions(
    chatId: string,
    topicId?: string,
    options?: { all?: boolean; limit?: number },
  ): Promise<CliSessionSummary[]> {
    const key = this.router.buildSessionKey(chatId, topicId);
    const result = await this.client.listSessions(
      key.backendId,
      key.cwd,
      options,
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
    this.router.bindCliSession(chatId, cliSessionId, topicId);
  }
}

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

/** 飞书流式展示：折叠密集 tool 事件，避免刷屏像「死循环」 */
export function createFeishuStreamFormatter() {
  let toolStarts = 0;
  return (event: AgentEvent): string => {
    switch (event.type) {
      case "text_delta":
        return event.text;
      case "tool_start":
        toolStarts++;
        if (toolStarts <= 2 || toolStarts % 8 === 0) {
          return `\n🔧 工具调用 ×${toolStarts}（\`${event.name}\`）…\n`;
        }
        return "";
      case "tool_end":
        return "";
      case "error":
        return `\n❌ ${event.message}\n`;
      case "done":
        if (toolStarts > 0 && event.exitCode === 0) {
          return `\n✅ 完成（共 ${toolStarts} 次工具调用）\n`;
        }
        return event.exitCode === 0 ? "" : `\n（退出码 ${event.exitCode}）\n`;
      default:
        return "";
    }
  };
}
