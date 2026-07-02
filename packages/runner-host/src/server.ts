import { spawn, type ChildProcess } from "node:child_process";
import {
  BackendRegistry,
  listSessionsForBackend,
  type CliSessionSummary,
} from "@feishu-code-bridge/backends";
import type {
  AgentEvent,
  AppConfig,
  RunContext,
  RunRequest,
} from "@feishu-code-bridge/core";
import { VERSION } from "@feishu-code-bridge/core";
import { Hono } from "hono";

export interface RunnerHostOptions {
  token: string;
  config: AppConfig;
  maxConcurrentRuns?: number;
}

interface ActiveRun {
  runId: string;
  child: ChildProcess;
  aborted: boolean;
}

export class RunnerHost {
  private readonly registry = new BackendRegistry();
  private readonly active = new Map<string, ActiveRun>();
  private readonly maxConcurrent: number;

  constructor(private readonly options: RunnerHostOptions) {
    this.maxConcurrent = options.maxConcurrentRuns ?? 4;
    for (const [id, profile] of Object.entries(options.config.backends)) {
      this.registry.register(id, profile);
    }
  }

  get registryIds(): string[] {
    return this.registry.ids();
  }

  async doctor() {
    const backend = await this.registry.doctor();
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
    run.child.kill("SIGTERM");
    setTimeout(() => {
      if (!run.child.killed) run.child.kill("SIGKILL");
    }, 2000);
    this.active.delete(runId);
    return true;
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

  async *executeRun(request: RunRequest): AsyncGenerator<AgentEvent> {
    while (this.active.size >= this.maxConcurrent) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const backendId = request.sessionKey.backendId;
    const backend = this.registry.get(backendId);
    if (!backend) {
      yield {
        type: "error",
        message: `Unknown backend: ${backendId}`,
        fatal: true,
      };
      yield { type: "done", exitCode: 1 };
      return;
    }

    const ctx: RunContext = {
      runId: request.runId,
      cwd: request.sessionKey.cwd,
      prompt: request.prompt,
      resumeSessionId: request.resumeSessionId,
      backendConfig: this.options.config.backends[backendId]!,
      model: request.model,
      effort: request.effort,
    };

    const argv = backend.buildArgv(ctx);
    const command = argv[0]!;
    const args = argv.slice(1);

    const child = spawn(command, args, {
      cwd: ctx.cwd,
      shell: true,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const activeRun: ActiveRun = {
      runId: request.runId,
      child,
      aborted: false,
    };
    this.active.set(request.runId, activeRun);

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
      exitCode = await waitForClose(child);
      if (stderr && exitCode !== 0) {
        yield { type: "error", message: stderr.trim(), fatal: false };
      }
    } catch (err) {
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        fatal: true,
      };
      exitCode = 1;
    } finally {
      this.active.delete(request.runId);
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

  app.post("/runs/:id/cancel", (c) => {
    const ok = host.cancel(c.req.param("id"));
    return c.json({ ok });
  });

  app.post("/runs", async (c) => {
    const body = (await c.req.json()) as RunRequest;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
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
        }
        controller.close();
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

  return app;
}
