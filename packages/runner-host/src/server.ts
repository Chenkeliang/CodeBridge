import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  BackendRegistry,
  getBackendTransport,
  killProcessTree,
  listAcpConfigOptions,
  listAcpSessions,
  listSessionsForBackend,
  runAcpSession,
  type CliSessionSummary,
} from "@feishu-code-bridge/backends";
import type {
  AgentEvent,
  AcpPermissionPolicy,
  AppConfig,
  BackendConfigOption,
  RunContext,
  RunRequest,
} from "@feishu-code-bridge/core";
import { DEFAULT_DATA_DIR, VERSION } from "@feishu-code-bridge/core";
import { Hono } from "hono";
import {
  cleanupAttachments,
  materializeAttachments,
} from "./materialize-attachments.js";
import { writeFcbScript } from "./fcb-script.js";

export interface RunnerHostOptions {
  token: string;
  config: AppConfig;
  maxConcurrentRuns?: number;
  dataDir?: string;
}

interface ActiveRun {
  runId: string;
  aborted: boolean;
  cancel: () => void;
}

/** prompt_feishu：权限请求等待用户回复的超时（到点自动拒绝）。需小于 noOutput 超时。 */
const PERMISSION_PROMPT_TIMEOUT_MS = 8 * 60 * 1000;

function resolveDoctorCwd(config: AppConfig): string {
  const home = os.homedir();
  const raw =
    config.workspaces?.default ??
    config.workspaces?.root ??
    path.join(home, "Projects");
  return raw.startsWith("~") ? path.join(home, raw.slice(1)) : raw;
}

export class RunnerHost {
  private readonly registry = new BackendRegistry();
  private readonly active = new Map<string, ActiveRun>();
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
    run.aborted = true;
    run.cancel();
    this.active.delete(runId);
    return true;
  }

  async listSessions(
    backendId: string,
    cwd: string,
    options?: { limit?: number; all?: boolean },
    requestTransport?: RunRequest["transport"],
  ): Promise<{ sessions: CliSessionSummary[]; error?: string }> {
    const profile = this.options.config.backends[backendId];
    if (!profile) {
      return { sessions: [], error: `Unknown backend: ${backendId}` };
    }

    const transport = this.effectiveTransport(backendId, requestTransport);

    if (transport === "acp") {
      const sessions = await listAcpSessions(backendId, profile, cwd, {
        limit: options?.limit ?? 20,
        all: options?.all ?? false,
      });
      return { sessions };
    }

    const discoveryId =
      profile.type === "cursor-cli"
        ? "cursor"
        : profile.type === "claude-code"
          ? "claude"
          : profile.type === "codex"
            ? "codex"
            : backendId;
    const sessions = listSessionsForBackend(discoveryId, cwd, {
      limit: options?.limit ?? 20,
      all: options?.all ?? false,
      cursorCommand: profile.command,
    });
    return { sessions };
  }

  /** /model 动态列表：拉取 ACP 适配器 advertise 的会话配置项（cli transport 返回空，走静态提示） */
  async listConfigOptions(
    backendId: string,
    cwd: string,
    requestTransport?: RunRequest["transport"],
  ): Promise<{ options: BackendConfigOption[]; error?: string }> {
    const profile = this.options.config.backends[backendId];
    if (!profile) {
      return { options: [], error: `Unknown backend: ${backendId}` };
    }
    const transport = this.effectiveTransport(backendId, requestTransport);
    if (transport !== "acp") {
      return { options: [] };
    }
    return { options: await listAcpConfigOptions(profile, cwd) };
  }

  private effectiveTransport(
    backendId: string,
    requestTransport?: RunRequest["transport"],
  ): "acp" | "cli" {
    const profile = this.options.config.backends[backendId];
    if (!profile) return "acp";
    return requestTransport ?? getBackendTransport(profile);
  }

  async *executeRun(request: RunRequest): AsyncGenerator<AgentEvent> {
    while (this.active.size >= this.maxConcurrent) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const backendId = request.sessionKey.backendId;
    const backend = this.registry.get(backendId);
    const profile = this.options.config.backends[backendId];
    if (!backend || !profile) {
      yield {
        type: "error",
        message: `Unknown backend: ${backendId}`,
        fatal: true,
      };
      yield { type: "done", exitCode: 1 };
      return;
    }

    const localAttachments = await materializeAttachments(
      this.dataDir,
      request.runId,
      request.attachments,
    );

    const transport =
      request.transport ?? getBackendTransport(profile);

    const ctx: RunContext = {
      runId: request.runId,
      cwd: request.sessionKey.cwd,
      prompt: request.prompt,
      attachments: localAttachments.length ? localAttachments : undefined,
      resumeSessionId: request.resumeSessionId,
      backendConfig: profile,
      model: request.model,
      effort: request.effort,
      claudePermissionMode: request.claudePermissionMode,
      extraEnv: await this.buildAgentEnv(request),
    };

    try {
      if (transport === "acp") {
        yield* this.executeAcpRun(request.runId, ctx);
        return;
      }

      yield* this.executeCliRun(request.runId, ctx, backend);
    } finally {
      if (localAttachments.length > 0) {
        await cleanupAttachments(this.dataDir, request.runId);
      }
    }
  }

  private async *executeAcpRun(
    runId: string,
    ctx: RunContext,
  ): AsyncGenerator<AgentEvent> {
    const handleRef: { current?: { child: ChildProcess; cancel: () => void } } =
      {};
    const activeRun: ActiveRun = {
      runId,
      aborted: false,
      // handleRef 在 runAcpSession 生成器体起始处赋值（首次 next() 即可用）
      cancel: () => handleRef.current?.cancel(),
    };
    this.active.set(runId, activeRun);

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
          requestDecision,
          pollOutOfBandEvents: () => oobEvents.splice(0),
        },
        handleRef,
      )) {
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
      // run 结束仍挂着的权限请求：全部解除阻塞（按拒绝处理），避免 handler 悬挂
      for (const pending of [...(this.pendingPermissions.get(runId) ?? [])]) {
        pending.resolve(false);
      }
      this.pendingPermissions.delete(runId);
      this.active.delete(runId);
      yield { type: "done", exitCode };
    }
  }

  /** /approve /deny：回应当前 run 最早挂起的权限请求（FIFO） */
  resolvePermission(runId: string, approve: boolean): boolean {
    const pending = this.pendingPermissions.get(runId)?.[0];
    if (!pending) return false;
    pending.resolve(approve);
    return true;
  }

  private async *executeCliRun(
    runId: string,
    ctx: RunContext,
    backend: NonNullable<ReturnType<BackendRegistry["get"]>>,
  ): AsyncGenerator<AgentEvent> {
    const argv = backend.buildArgv(ctx);
    const command = argv[0]!;
    const args = argv.slice(1);

    const child = spawn(command, args, {
      cwd: ctx.cwd,
      env: { ...process.env, ...ctx.extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // 自成进程组：SIGKILL 兜底时连 agent 的孙进程一起杀，不留孤儿
    });

    // 必须在 spawn 后同步挂上 close/error 监听：spawn 失败（如 ENOENT）时
    // 无监听的 'error' 事件会以 uncaught exception 炸掉整个 Runner 进程
    let spawnError = "";
    child.on("error", (err) => {
      spawnError = err.message;
    });
    const closed = waitForClose(child);

    const childAlive = () =>
      child.exitCode === null && child.signalCode === null;
    const activeRun: ActiveRun = {
      runId,
      aborted: false,
      cancel: () => {
        if (childAlive()) killProcessTree(child, "SIGTERM");
        setTimeout(() => {
          if (childAlive()) killProcessTree(child, "SIGKILL");
        }, 2000).unref();
      },
    };
    this.active.set(runId, activeRun);

    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    const lineReader = readLines(child.stdout!);
    let exitCode = 0;

    try {
      for await (const line of lineReader) {
        if (activeRun.aborted) break;
        for (const event of backend.parseLine(line)) {
          yield event;
        }
      }
      exitCode = await closed;
      const failReason = spawnError || stderr.trim();
      if (failReason && exitCode !== 0) {
        yield { type: "error", message: failReason, fatal: false };
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
}

async function* readLines(
  stream: NodeJS.ReadableStream,
): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      yield line;
    }
  }
  if (buffer.trim()) yield buffer;
}

function waitForClose(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
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

  app.post("/runs/:id/cancel", (c) => {
    const ok = host.cancel(c.req.param("id"));
    return c.json({ ok });
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
    const transportRaw = c.req.query("transport");
    const transport =
      transportRaw === "acp" || transportRaw === "cli"
        ? transportRaw
        : undefined;
    if (!backend || !cwd) {
      return c.json({ error: "backend and cwd are required" }, 400);
    }
    const result = await host.listSessions(backend, cwd, {
      all,
      limit: Number.isFinite(limit) ? limit : 20,
    }, transport);
    return c.json(result);
  });

  app.get("/config-options", async (c) => {
    const backend = c.req.query("backend");
    const cwd = c.req.query("cwd");
    const transportRaw = c.req.query("transport");
    const transport =
      transportRaw === "acp" || transportRaw === "cli"
        ? transportRaw
        : undefined;
    if (!backend || !cwd) {
      return c.json({ error: "backend and cwd are required" }, 400);
    }
    const result = await host.listConfigOptions(backend, cwd, transport);
    return c.json(result);
  });

  return app;
}
