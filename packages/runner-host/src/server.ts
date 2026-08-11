import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  AcpSessionPool,
  BackendRegistry,
  deleteAcpSession,
  loadAcpSessionHistory,
  listAcpConfigOptions,
  listAcpSessions,
  runAcpSession,
  closePiSession,
  deletePiSession,
  forkPiSession,
  listPiConfigOptions,
  listPiCommands,
  listPiSessions,
  loadCodexSessionHistory,
  loadPiSessionHistory,
  loadClaudeSessionHistory,
  runPiSession,
  type PiRunHandleRef,
  type PiSession,
  type PiSessionLifecycleResult,
  type CliSessionSummary,
  type ProviderSessionHistoryEvent,
} from "@codebridge/backends";
import type {
  AgentEvent,
  AgentAvailableCommand,
  AcpPermissionPolicy,
  AppConfig,
  BackendConfigOption,
  LocalMediaPath,
  RunContext,
  RunRequest,
} from "@codebridge/core";
import { DEFAULT_DATA_DIR, VERSION } from "@codebridge/core";
import { Hono } from "hono";
import {
  cleanupAttachments,
  materializeAttachments,
} from "./materialize-attachments.js";
import { writeFcbScript } from "./fcb-script.js";
import { inspectForeignCodexSessionOwners } from "./codex-session-ownership.js";
import { SessionLeaseStore, type SessionLease } from "./session-lease.js";

export interface RunnerHostOptions {
  token: string;
  config: AppConfig;
  maxConcurrentRuns?: number;
  dataDir?: string;
  /** Test/embedding hook; production uses the native Pi Node SDK factory. */
  piSessionFactory?: (ctx: RunContext) => Promise<PiSession>;
  /** Test/embedding hook for provider-native session fork. */
  piSessionForker?: typeof forkPiSession;
  inspectSessionOwners?: (
    sessionId: string,
    allowedProcessGroups: ReadonlySet<number>,
  ) => Promise<number[]>;
  /** Host-native directory chooser. Production uses the macOS folder panel. */
  directoryPicker?: () => Promise<string | null>;
}

interface ActiveRun {
  runId: string;
  sessionId?: string;
  aborted: boolean;
  cancel: () => void;
  steer?: (prompt: string) => Promise<unknown>;
}

interface RunLifecycle {
  started: boolean;
  cancelRequested: boolean;
  finished: Promise<void>;
  finish: () => void;
  expiry?: ReturnType<typeof setTimeout>;
}

/** prompt_feishu：权限请求等待用户回复的超时（到点自动拒绝）。需小于 noOutput 超时。 */
const PERMISSION_PROMPT_TIMEOUT_MS = 8 * 60 * 1000;
const execFileAsync = promisify(execFile);

async function pickNativeDirectory(): Promise<string | null> {
  if (process.platform !== "darwin") {
    throw new Error("当前系统不支持原生目录选择器");
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "选择要加入当前 Session 的目录")',
    ]);
    return stdout.trim() || null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("User canceled") || message.includes("-128")) return null;
    throw error;
  }
}

function resolveDoctorCwd(config: AppConfig): string {
  const home = os.homedir();
  const raw =
    config.workspaces?.default ??
    config.workspaces?.root ??
    path.join(home, "Projects");
  return raw.startsWith("~") ? path.join(home, raw.slice(1)) : raw;
}

function resolveRunCwd(raw: string): { cwd: string } | { error: string } {
  if (!path.isAbsolute(raw)) {
    return { error: `工作目录必须使用绝对路径: ${raw}` };
  }
  try {
    const cwd = fs.realpathSync(raw);
    if (!fs.statSync(cwd).isDirectory()) {
      return { error: `工作目录不是目录: ${raw}` };
    }
    return { cwd };
  } catch {
    return { error: `工作目录不存在或无法访问: ${raw}` };
  }
}

function resolveAdditionalDirectories(
  raw: string[] | undefined,
  cwd: string,
): { directories?: string[] } | { error: string } {
  if (!raw?.length) return {};
  const directories: string[] = [];
  for (const value of raw) {
    if (!path.isAbsolute(value)) {
      return { error: `附加目录必须使用绝对路径: ${value}` };
    }
    const resolved = resolveRunCwd(value);
    if ("error" in resolved) {
      return { error: `附加目录 ${value} 无效：${resolved.error}` };
    }
    if (resolved.cwd !== cwd && !directories.includes(resolved.cwd)) {
      directories.push(resolved.cwd);
    }
  }
  return directories.length ? { directories } : {};
}

export class RunnerHost {
  private readonly registry = new BackendRegistry();
  private readonly active = new Map<string, ActiveRun>();
  private readonly runLifecycles = new Map<string, RunLifecycle>();
  private readonly maxConcurrent: number;
  private readonly dataDir: string;
  private readonly acpPermissionPolicy: AcpPermissionPolicy;
  private readonly acpRunOptions: {
    promptTimeoutMs?: number;
    noOutputTimeoutMs?: number;
    stallTimeoutMs?: number;
    drainBackgroundWork?: boolean;
    postStopProbeMs?: number;
    postStopQuietMs?: number;
    postStopMaxMs?: number;
  };
  private readonly fcbBinDir: Promise<string | undefined>;
  private readonly sessionLeases: SessionLeaseStore;
  private readonly inspectSessionOwners: NonNullable<
    RunnerHostOptions["inspectSessionOwners"]
  >;
  /** 长驻 ACP 会话池：同会话消息复用适配器进程（kill switch: runnerHost.acpSessionPool） */
  private readonly sessionPool: AcpSessionPool;
  /**
   * prompt_feishu：每个 run 的挂起权限请求队列（FIFO）。claude 通常一次只挂一个，
   * 但并行工具可能并发请求——用队列而非单槽，避免互相覆盖、/approve 只回给最早的那个。
   */
  private readonly pendingPermissions = new Map<
    string,
    Array<{ requestId: string; resolve: (approve: boolean) => void }>
  >();

  constructor(private readonly options: RunnerHostOptions) {
    this.maxConcurrent = options.maxConcurrentRuns ?? 4;
    this.dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
    this.acpPermissionPolicy =
      options.config.runnerHost?.acpPermissionPolicy ?? "auto_allow";
    const rh = options.config.runnerHost;
    this.acpRunOptions = {
      promptTimeoutMs: rh?.acpPromptTimeoutMs,
      noOutputTimeoutMs: rh?.acpNoOutputTimeoutMs,
      stallTimeoutMs: rh?.acpStallTimeoutMs,
      drainBackgroundWork: rh?.acpDrainBackgroundWork,
      postStopProbeMs: rh?.acpPostStopProbeMs,
      postStopQuietMs: rh?.acpPostStopQuietMs,
      postStopMaxMs: rh?.acpPostStopMaxMs,
    };
    this.sessionPool = new AcpSessionPool({
      enabled: rh?.acpSessionPool ?? true,
      idleMs: rh?.acpSessionIdleMs ?? 10 * 60_000,
      maxPooled: rh?.acpSessionPoolMax ?? 4,
    });
    this.sessionLeases = new SessionLeaseStore(this.dataDir);
    this.inspectSessionOwners =
      options.inspectSessionOwners ?? inspectForeignCodexSessionOwners;
    for (const [id, profile] of Object.entries(options.config.backends)) {
      this.registry.register(id, profile);
    }
    // fcb 写失败不阻塞 Runner 启动，只是 Agent 内没有 fcb 可用
    this.fcbBinDir = writeFcbScript(this.dataDir).catch(() => undefined);
  }

  /** Agent 子进程环境：fcb 出站 API 凭据 + 把 fcb 挂到 PATH */
  private async buildAgentEnv(
    request: RunRequest,
  ): Promise<Record<string, string>> {
    const env: Record<string, string> = {
      FCB_CHAT_ID: request.sessionKey.chatId,
      FCB_API: `http://127.0.0.1:${this.options.config.bridge?.apiPort ?? 19790}`,
      FCB_TOKEN: this.options.token,
    };
    if (request.sessionKey.topicId) {
      env.FCB_TOPIC_ID = request.sessionKey.topicId;
    }
    const binDir = await this.fcbBinDir;
    if (binDir) {
      env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    }
    return env;
  }

  get registryIds(): string[] {
    return this.registry.ids();
  }

  async doctor() {
    const backend = await this.registry.doctor(resolveDoctorCwd(this.options.config));
    return {
      version: VERSION,
      backends: this.registry.ids(),
      ...backend,
    };
  }

  cancel(runId: string): boolean {
    const run = this.active.get(runId);
    if (!run) return false;
    const lifecycle = this.runLifecycles.get(runId);
    if (lifecycle) lifecycle.cancelRequested = true;
    run.aborted = true;
    run.cancel();
    return true;
  }

  async cancelAndWait(runId: string): Promise<boolean> {
    const lifecycle = this.runLifecycles.get(runId) ?? this.createRunLifecycle(runId);
    lifecycle.cancelRequested = true;
    this.cancel(runId);
    if (!lifecycle.started) {
      lifecycle.expiry = setTimeout(() => {
        if (this.runLifecycles.get(runId) === lifecycle && !lifecycle.started) {
          this.runLifecycles.delete(runId);
        }
      }, 60_000);
      lifecycle.expiry.unref();
      return true;
    }
    await lifecycle.finished;
    return true;
  }

  private createRunLifecycle(runId: string): RunLifecycle {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const lifecycle: RunLifecycle = {
      started: false,
      cancelRequested: false,
      finished,
      finish,
    };
    this.runLifecycles.set(runId, lifecycle);
    return lifecycle;
  }

  async steer(
    runId: string,
    prompt: string,
  ): Promise<{ ok: boolean; outcome?: string; error?: string }> {
    const run = this.active.get(runId);
    if (!run) return { ok: false, error: "当前没有正在运行的任务" };
    if (!run.steer) return { ok: false, error: "当前 ACP Agent 未声明 steering 支持" };
    try {
      const response = await run.steer(prompt);
      const outcome =
        response &&
        typeof response === "object" &&
        "outcome" in response &&
        typeof response.outcome === "string"
          ? response.outcome
          : "accepted";
      return { ok: true, outcome };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listSessions(
    backendId: string,
    cwd: string,
    options?: { limit?: number; all?: boolean },
  ): Promise<{ sessions: CliSessionSummary[]; error?: string }> {
    const profile = this.options.config.backends[backendId];
    if (!profile) {
      return { sessions: [], error: `Unknown backend: ${backendId}` };
    }

    const resolvedCwd = resolveRunCwd(cwd);
    if ("error" in resolvedCwd) {
      return { sessions: [], error: resolvedCwd.error };
    }
    cwd = resolvedCwd.cwd;

    try {
      const sessions = profile.type === "pi-sdk"
        ? await listPiSessions(backendId, cwd, {
            limit: options?.limit ?? 20,
          })
        : await listAcpSessions(backendId, profile, cwd, {
            limit: options?.limit ?? 20,
            all: options?.all ?? false,
          });
      return { sessions };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        sessions: [],
        error: `${profile.type === "pi-sdk" ? "Pi session/list" : "ACP session/list"} failed for ${backendId}: ${message}`,
      };
    }
  }

  async loadSessionHistory(
    backendId: string,
    rawCwd: string,
    sessionId: string,
    additionalDirectories?: string[],
  ): Promise<ProviderSessionHistoryEvent[]> {
    const profile = this.options.config.backends[backendId];
    if (!profile) throw new Error(`Unknown backend: ${backendId}`);
    const resolvedCwd = resolveRunCwd(rawCwd);
    if ("error" in resolvedCwd) throw new Error(resolvedCwd.error);
    const resolvedDirectories = resolveAdditionalDirectories(additionalDirectories, resolvedCwd.cwd);
    if ("error" in resolvedDirectories) throw new Error(resolvedDirectories.error);
    if (profile.type === "pi-sdk") {
      return loadPiSessionHistory(resolvedCwd.cwd, sessionId);
    }
    if (profile.type === "codex") {
      return loadCodexSessionHistory(sessionId);
    }
    try {
      const history = await loadAcpSessionHistory(backendId, profile, resolvedCwd.cwd, sessionId, {
        additionalDirectories: resolvedDirectories.directories,
      });
      if (history.length || profile.type !== "claude-code") return history;
    } catch (error) {
      if (profile.type !== "claude-code") throw error;
    }
    return loadClaudeSessionHistory(resolvedCwd.cwd, sessionId);
  }

  async authorizeDirectory(
    rawPath: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (!path.isAbsolute(rawPath)) {
      return { ok: false, error: `工作目录必须使用绝对路径: ${rawPath}` };
    }
    const candidate = path.resolve(rawPath);
    try {
      const handle = await fs.promises.opendir(candidate);
      await handle.close();
      return { ok: true, path: await fs.promises.realpath(candidate) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        return {
          ok: false,
          path: candidate,
          error: `Runner 尚未获得目录访问权限：${candidate}`,
        };
      }
      return {
        ok: false,
        error: `Runner 无法访问目录 ${candidate}：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async pickDirectory(): Promise<{
    ok: boolean;
    path?: string;
    cancelled?: boolean;
    error?: string;
  }> {
    try {
      const selected = await (this.options.directoryPicker ?? pickNativeDirectory)();
      if (!selected) return { ok: true, cancelled: true };
      return this.authorizeDirectory(selected);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async closeSession(
    backendId: string,
    cwd: string,
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.manageSession("close", backendId, cwd, sessionId);
  }

  async deleteSession(
    backendId: string,
    cwd: string,
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.manageSession("delete", backendId, cwd, sessionId);
  }

  async forkSession(
    backendId: string,
    cwd: string,
    sessionId: string,
    targetCwd: string,
  ): Promise<PiSessionLifecycleResult> {
    if ([...this.active.values()].some((run) => run.sessionId === sessionId)) {
      return { ok: false, error: `Session ${sessionId} 正在运行，请先停止后重试` };
    }
    const profile = this.options.config.backends[backendId];
    if (!profile) return { ok: false, error: `Unknown backend: ${backendId}` };
    const source = resolveRunCwd(cwd);
    if ("error" in source) return { ok: false, error: source.error };
    const target = resolveRunCwd(targetCwd);
    if ("error" in target) return { ok: false, error: target.error };
    if (profile.type !== "pi-sdk") {
      return { ok: false, error: `${backendId} 未声明 Session fork 能力` };
    }
    try {
      return await (this.options.piSessionForker ?? forkPiSession)(
        source.cwd,
        sessionId,
        target.cwd,
      );
    } catch (error) {
      return {
        ok: false,
        error: `Pi session/fork failed for ${backendId}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async manageSession(
    action: "close" | "delete",
    backendId: string,
    cwd: string,
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if ([...this.active.values()].some((run) => run.sessionId === sessionId)) {
      return {
        ok: false,
        error: `ACP session ${sessionId} 正在运行，请先 /stop 后重试`,
      };
    }
    const profile = this.options.config.backends[backendId];
    if (!profile) return { ok: false, error: `Unknown backend: ${backendId}` };
    const resolvedCwd = resolveRunCwd(cwd);
    if ("error" in resolvedCwd) return { ok: false, error: resolvedCwd.error };
    try {
      if (action === "close") {
        if (profile.type === "pi-sdk") {
          return closePiSession(resolvedCwd.cwd, sessionId);
        }
        const result = await this.sessionPool.close(sessionId);
        if (result.error === "not_owned") {
          return {
            ok: false,
            error: "Runner 当前未持有该 ACP session；历史 session 请使用 /session delete",
          };
        }
        if (!result.ok) {
          return {
            ok: false,
            error: `ACP session/close failed for ${backendId}: ${result.error ?? "未知错误"}`,
          };
        }
        return result;
      }
      if (profile.type === "pi-sdk") {
        return deletePiSession(resolvedCwd.cwd, sessionId);
      }
      await deleteAcpSession(profile, resolvedCwd.cwd, sessionId);
      this.sessionPool.remove(sessionId);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `${profile.type === "pi-sdk" ? "Pi session" : "ACP session"}/${action} failed for ${backendId}: ${message}`,
      };
    }
  }

  /** /model 动态列表：拉取 ACP 适配器 advertise 的会话配置项 */
  async listConfigOptions(
    backendId: string,
    cwd: string,
  ): Promise<{ options: BackendConfigOption[]; error?: string }> {
    const profile = this.options.config.backends[backendId];
    if (!profile) {
      return { options: [], error: `Unknown backend: ${backendId}` };
    }
    const resolvedCwd = resolveRunCwd(cwd);
    if ("error" in resolvedCwd) {
      return { options: [], error: resolvedCwd.error };
    }
    cwd = resolvedCwd.cwd;
    try {
      if (profile.type === "pi-sdk") {
        return { options: await listPiConfigOptions() };
      }
      return { options: await listAcpConfigOptions(profile, cwd) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        options: [],
        error: `ACP config options failed for ${backendId}: ${message}`,
      };
    }
  }

  async listCommands(
    backendId: string,
    cwd: string,
  ): Promise<{ commands: AgentAvailableCommand[]; error?: string }> {
    const profile = this.options.config.backends[backendId];
    if (!profile) return { commands: [], error: `Unknown backend: ${backendId}` };
    const resolvedCwd = resolveRunCwd(cwd);
    if ("error" in resolvedCwd) return { commands: [], error: resolvedCwd.error };
    if (profile.type !== "pi-sdk") return { commands: [] };
    try {
      return { commands: await listPiCommands(resolvedCwd.cwd) };
    } catch (error) {
      return {
        commands: [],
        error: `Pi commands failed for ${backendId}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async *executeRun(request: RunRequest): AsyncGenerator<AgentEvent> {
    const lifecycle =
      this.runLifecycles.get(request.runId) ?? this.createRunLifecycle(request.runId);
    lifecycle.started = true;
    if (lifecycle.expiry) clearTimeout(lifecycle.expiry);
    try {
      if (lifecycle.cancelRequested) return;
      yield* this.executeRunInner(request, lifecycle);
    } finally {
      lifecycle.finish();
      if (this.runLifecycles.get(request.runId) === lifecycle) {
        this.runLifecycles.delete(request.runId);
      }
    }
  }

  private async *executeRunInner(
    request: RunRequest,
    lifecycle: RunLifecycle,
  ): AsyncGenerator<AgentEvent> {
    while (this.active.size >= this.maxConcurrent) {
      if (lifecycle.cancelRequested) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (lifecycle.cancelRequested) return;

    const backendId = request.sessionKey.backendId;
    const profile = this.options.config.backends[backendId];
    if (!profile) {
      yield {
        type: "error",
        message: `Unknown backend: ${backendId}`,
        fatal: true,
      };
      yield { type: "done", exitCode: 1 };
      return;
    }

    const resolvedCwd = resolveRunCwd(request.sessionKey.cwd);
    if ("error" in resolvedCwd) {
      yield { type: "error", message: resolvedCwd.error, fatal: true };
      yield { type: "done", exitCode: 1 };
      return;
    }

    const resolvedAdditional = resolveAdditionalDirectories(
      request.additionalDirectories,
      resolvedCwd.cwd,
    );
    if ("error" in resolvedAdditional) {
      yield { type: "error", message: resolvedAdditional.error, fatal: true };
      yield { type: "done", exitCode: 1 };
      return;
    }

    let sessionLease: SessionLease | null = null;
    if (request.resumeSessionId) {
      const sessionId = request.resumeSessionId;
      if ([...this.active.values()].some((run) => run.sessionId === sessionId)) {
        yield {
          type: "error",
          message: `ACP session ${sessionId} 正在运行；请等待当前任务结束或先 /stop`,
          fatal: true,
        };
        yield { type: "done", exitCode: 1 };
        return;
      }
      sessionLease = await this.sessionLeases.acquire(sessionId, request.runId);
      if (!sessionLease) {
        yield {
          type: "error",
          message: `ACP session ${sessionId} 已被另一个 Runner 任务占用`,
          fatal: true,
        };
        yield { type: "done", exitCode: 1 };
        return;
      }
    }

    let localAttachments: LocalMediaPath[] = [];
    try {
      if (lifecycle.cancelRequested) return;
      if (backendId === "codex" && request.resumeSessionId) {
        const ownerGroup = this.sessionPool.ownerProcessGroupId(
          request.resumeSessionId,
        );
        const owners = await this.inspectSessionOwners(
          request.resumeSessionId,
          new Set(ownerGroup === undefined ? [] : [ownerGroup]),
        );
        if (owners.length > 0) {
          yield {
            type: "error",
            message: `Codex session ${request.resumeSessionId} 正被桌面端/TUI 占用（PID: ${owners.join(", ")}）；请先在原客户端停止该任务`,
            fatal: true,
          };
          yield { type: "done", exitCode: 1 };
          return;
        }
      }
      if (lifecycle.cancelRequested) return;

      localAttachments = await materializeAttachments(
        this.dataDir,
        request.runId,
        request.attachments,
      );
      if (lifecycle.cancelRequested) return;
      const ctx: RunContext = {
        runId: request.runId,
        cwd: resolvedCwd.cwd,
        prompt: request.prompt,
        additionalDirectories: resolvedAdditional.directories,
        attachments: localAttachments.length ? localAttachments : undefined,
        resumeSessionId: request.resumeSessionId,
        backendConfig: profile,
        model: request.model,
        effort: request.effort,
        mode: request.mode,
        claudePermissionMode: request.claudePermissionMode,
        acpConfig: request.acpConfig,
        extraEnv: await this.buildAgentEnv(request),
      };
      if (lifecycle.cancelRequested) return;
      if (profile.type === "pi-sdk") {
        yield* this.executePiRun(request.runId, ctx);
      } else {
        yield* this.executeAcpRun(request.runId, ctx, sessionLease?.lost);
      }
    } finally {
      if (localAttachments.length > 0) {
        await cleanupAttachments(this.dataDir, request.runId);
      }
      await sessionLease?.release();
    }
  }

  private async *executeAcpRun(
    runId: string,
    ctx: RunContext,
    sessionLockLost?: Promise<Error>,
  ): AsyncGenerator<AgentEvent> {
    const handleRef: Parameters<typeof runAcpSession>[2] = {};
    const activeRun: ActiveRun = {
      runId,
      sessionId: ctx.resumeSessionId,
      aborted: false,
      // handleRef 在 runAcpSession 生成器体起始处赋值（首次 next() 即可用）
      cancel: () => handleRef.current?.cancel(),
      steer: async (prompt: string) => {
        const steer = handleRef.current?.steer;
        if (!steer) throw new Error("当前 ACP Agent 未声明 steering 支持或仍在初始化");
        return steer(prompt);
      },
    };
    this.active.set(runId, activeRun);
    let lockLostError: Error | undefined;
    let runFinished = false;
    void sessionLockLost?.then((error) => {
      if (runFinished) return;
      lockLostError = error;
      activeRun.aborted = true;
      activeRun.cancel();
    });

    // prompt_feishu 权限模式：权限请求经带外队列进 SSE，等 /approve /deny 或超时拒绝
    const oobEvents: AgentEvent[] = [];
    const removePending = (requestId: string) => {
      const queue = this.pendingPermissions.get(runId);
      if (!queue) return;
      const idx = queue.findIndex((p) => p.requestId === requestId);
      if (idx >= 0) queue.splice(idx, 1);
      if (queue.length === 0) this.pendingPermissions.delete(runId);
    };
    const requestDecision =
      this.acpPermissionPolicy === "prompt_feishu"
        ? (info: { title: string }) =>
            new Promise<boolean>((resolve) => {
              const requestId = crypto.randomUUID();
              const timer = setTimeout(() => {
                removePending(requestId); // 只摘自己，不动同 run 的其它挂起请求
                oobEvents.push({
                  type: "error",
                  message: `权限请求「${info.title}」超过 ${Math.round(PERMISSION_PROMPT_TIMEOUT_MS / 60000)} 分钟未回复，已自动拒绝。`,
                  fatal: false,
                });
                resolve(false);
              }, PERMISSION_PROMPT_TIMEOUT_MS);
              timer.unref();
              const queue = this.pendingPermissions.get(runId) ?? [];
              queue.push({
                requestId,
                resolve: (approve: boolean) => {
                  clearTimeout(timer);
                  removePending(requestId);
                  resolve(approve);
                },
              });
              this.pendingPermissions.set(runId, queue);
              oobEvents.push({
                type: "permission_request",
                requestId,
                title: info.title,
              });
            })
        : undefined;

    let exitCode = 0;
    try {
      for await (const event of runAcpSession(
        ctx,
        {
          permissionPolicy: this.acpPermissionPolicy,
          isAborted: () => activeRun.aborted,
          ...this.acpRunOptions,
          sessionPool: this.sessionPool,
          requestDecision,
          pollOutOfBandEvents: () => oobEvents.splice(0),
        },
        handleRef,
      )) {
        if (event.type === "session") activeRun.sessionId = event.sessionId;
        if (event.type === "error" && event.fatal) exitCode = 1;
        yield event;
      }
    } catch (err) {
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        fatal: true,
      };
      exitCode = 1;
    } finally {
      runFinished = true;
      // run 结束仍挂着的权限请求：全部解除阻塞（按拒绝处理），避免 handler 悬挂
      for (const pending of [...(this.pendingPermissions.get(runId) ?? [])]) {
        pending.resolve(false);
      }
      this.pendingPermissions.delete(runId);
      this.active.delete(runId);
      if (lockLostError) {
        yield {
          type: "error",
          message: `ACP session 锁异常丢失，任务已立即停止：${lockLostError.message}`,
          fatal: true,
        };
        exitCode = 1;
      }
      yield { type: "done", exitCode };
    }
  }

  private async *executePiRun(
    runId: string,
    ctx: RunContext,
  ): AsyncGenerator<AgentEvent> {
    const handleRef: PiRunHandleRef = {};
    const activeRun: ActiveRun = {
      runId,
      sessionId: ctx.resumeSessionId,
      aborted: false,
      cancel: () => {
        void handleRef.current?.cancel();
      },
      steer: async (prompt: string) => {
        const steer = handleRef.current?.steer;
        if (!steer) throw new Error("当前 Pi Agent 尚未初始化或不支持 steering");
        return steer(prompt);
      },
    };
    this.active.set(runId, activeRun);
    let exitCode = 0;
    try {
      for await (const event of runPiSession(ctx, {
        isAborted: () => activeRun.aborted,
        handleRef,
        ...(this.options.piSessionFactory
          ? { createSession: this.options.piSessionFactory }
          : {}),
      })) {
        if (event.type === "session") activeRun.sessionId = event.sessionId;
        if (event.type === "error" && event.fatal) exitCode = 1;
        yield event;
      }
    } catch (err) {
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        fatal: true,
      };
      exitCode = 1;
    } finally {
      this.active.delete(runId);
      yield { type: "done", exitCode };
    }
  }

  /** runner 退出前清场：杀池内空闲进程 + 取消在飞 run（子进程 detached，不清就孤儿） */
  shutdown(): void {
    this.sessionPool.shutdown();
    for (const run of [...this.active.values()]) {
      run.aborted = true;
      try {
        run.cancel();
      } catch {
        // 尽力而为
      }
    }
    this.active.clear();
    for (const lifecycle of this.runLifecycles.values()) {
      if (lifecycle.expiry) clearTimeout(lifecycle.expiry);
    }
    this.runLifecycles.clear();
  }

  /** /approve /deny：回应当前 run 最早挂起的权限请求（FIFO） */
  resolvePermission(runId: string, approve: boolean): boolean {
    const pending = this.pendingPermissions.get(runId)?.[0];
    if (!pending) return false;
    pending.resolve(approve);
    return true;
  }

}

export function createRunnerApp(host: RunnerHost, token: string) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization");
    if (auth !== `Bearer ${token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/health", (c) =>
    c.json({ ok: true, version: VERSION, backends: host.registryIds }),
  );

  app.get("/doctor", async (c) => c.json(await host.doctor()));

  app.post("/runs/:id/permission", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      approve?: boolean;
    };
    if (typeof body.approve !== "boolean") {
      return c.json({ error: "approve (boolean) is required" }, 400);
    }
    const resolved = host.resolvePermission(c.req.param("id"), body.approve);
    return c.json({ resolved });
  });

  app.post("/runs/:id/cancel", async (c) => {
    const ok = await host.cancelAndWait(c.req.param("id"));
    return c.json({ ok });
  });

  app.post("/runs/:id/steer", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { prompt?: string };
    if (!body.prompt?.trim()) {
      return c.json({ error: "prompt is required" }, 400);
    }
    const result = await host.steer(c.req.param("id"), body.prompt.trim());
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post("/runs", async (c) => {
    const body = (await c.req.json()) as RunRequest;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const keepalive = encoder.encode(": keepalive\n\n");
        controller.enqueue(keepalive);
        const timer = setInterval(() => {
          try {
            controller.enqueue(keepalive);
          } catch {
            clearInterval(timer);
          }
        }, 15_000);

        const send = (event: AgentEvent) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        };
        try {
          for await (const event of host.executeRun(body)) {
            send(event);
          }
        } catch (err) {
          send({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
            fatal: true,
          });
          send({ type: "done", exitCode: 1 });
        } finally {
          clearInterval(timer);
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  app.get("/sessions", async (c) => {
    const backend = c.req.query("backend");
    const cwd = c.req.query("cwd");
    const all = c.req.query("all") === "true";
    const limit = Number(c.req.query("limit") ?? "20");
    if (!backend || !cwd) {
      return c.json({ error: "backend and cwd are required" }, 400);
    }
    const result = await host.listSessions(backend, cwd, {
      all,
      limit: Number.isFinite(limit) ? limit : 20,
    });
    return c.json(result);
  });

  app.get("/sessions/:id/history", async (c) => {
    const backend = c.req.query("backend");
    const cwd = c.req.query("cwd");
    if (!backend || !cwd) {
      return c.json({ error: "backend and cwd are required" }, 400);
    }
    try {
      const encodedDirectories = c.req.query("additional_directories");
      const additionalDirectories = encodedDirectories
        ? JSON.parse(encodedDirectories) as unknown
        : undefined;
      if (additionalDirectories !== undefined && (
        !Array.isArray(additionalDirectories) ||
        !additionalDirectories.every((directory) => typeof directory === "string")
      )) {
        return c.json({ error: "additional_directories must be a string array" }, 400);
      }
      const events = await host.loadSessionHistory(
        backend,
        cwd,
        c.req.param("id"),
        additionalDirectories,
      );
      return c.json({ events });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        409,
      );
    }
  });

  app.post("/directories/authorize", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { path?: string } | null;
    if (!body?.path) return c.json({ ok: false, error: "path 必填" }, 400);
    const result = await host.authorizeDirectory(body.path);
    return c.json(result, result.ok ? 200 : 403);
  });

  app.post("/directories/pick", async (c) => {
    const result = await host.pickDirectory();
    return c.json(result, result.ok ? 200 : 503);
  });

  app.post("/sessions/:id/close", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      backend?: string;
      cwd?: string;
    };
    if (!body.backend || !body.cwd) {
      return c.json({ error: "backend and cwd are required" }, 400);
    }
    const result = await host.closeSession(body.backend, body.cwd, c.req.param("id"));
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post("/sessions/:id/fork", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      backend?: string;
      cwd?: string;
      targetCwd?: string;
    };
    if (!body.backend || !body.cwd || !body.targetCwd) {
      return c.json({ error: "backend, cwd and targetCwd are required" }, 400);
    }
    const result = await host.forkSession(
      body.backend,
      body.cwd,
      c.req.param("id"),
      body.targetCwd,
    );
    return c.json(result, result.ok ? 201 : 409);
  });

  app.delete("/sessions/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      backend?: string;
      cwd?: string;
    };
    if (!body.backend || !body.cwd) {
      return c.json({ error: "backend and cwd are required" }, 400);
    }
    const result = await host.deleteSession(body.backend, body.cwd, c.req.param("id"));
    return c.json(result, result.ok ? 200 : 409);
  });

  app.get("/config-options", async (c) => {
    const backend = c.req.query("backend");
    const cwd = c.req.query("cwd");
    if (!backend || !cwd) {
      return c.json({ error: "backend and cwd are required" }, 400);
    }
    const result = await host.listConfigOptions(backend, cwd);
    return c.json(result);
  });

  app.get("/commands", async (c) => {
    const backend = c.req.query("backend");
    const cwd = c.req.query("cwd");
    if (!backend || !cwd) {
      return c.json({ error: "backend and cwd are required" }, 400);
    }
    return c.json(await host.listCommands(backend, cwd));
  });

  return app;
}
