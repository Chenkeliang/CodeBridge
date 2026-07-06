import fs from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import {
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ActiveSession,
  type ActiveSessionMessage,
  type ClientConnection,
  type ContentBlock,
} from "@agentclientprotocol/sdk";
import type {
  AgentEvent,
  AcpPermissionPolicy,
  RunContext,
} from "@feishu-code-bridge/core";
import { mapSessionUpdate } from "./acp-event-mapper.js";
import { openActiveSession } from "./acp-active-session.js";
import { raceWithAbort } from "./acp-race.js";
import { createHeadlessClientApp } from "./headless-client.js";
import { resolveAcpSpawn } from "./acp-spawn-profiles.js";

export interface AcpRunHandle {
  child: ChildProcess;
  cancel: () => void;
}

export interface AcpRunOptions {
  permissionPolicy: AcpPermissionPolicy;
  isAborted: () => boolean;
  /** 子进程 stderr 快照，用于超时/失败时给出真实原因 */
  readStderr?: () => string;
  /** 测试用：覆盖下方三个超时常量 */
  promptTimeoutMs?: number;
  noOutputTimeoutMs?: number;
  stallTimeoutMs?: number;
}

async function buildPromptBlocks(ctx: RunContext): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (const att of ctx.attachments ?? []) {
    const data = await fs.readFile(att.path, { encoding: "base64" });
    blocks.push({
      type: "image",
      mimeType: att.mimeType ?? "image/png",
      data,
      uri: att.path,
    });
  }
  blocks.push({ type: "text", text: ctx.prompt });
  return blocks;
}

function childToStream(child: ChildProcess) {
  if (!child.stdin || !child.stdout) {
    throw new Error("ACP agent stdio pipes unavailable");
  }
  return ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
}

async function waitMs(ms: number, isAborted: () => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (isAborted()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 防止 ACP prompt 永不结束导致 Runner SSE / 飞书会话队列假死 */
const ACP_PROMPT_TIMEOUT_MS = 20 * 60 * 1000;
/** 从发 prompt 起这么久仍无任何输出，视为卡住（常见于 session/load 或看图） */
const ACP_NO_OUTPUT_TIMEOUT_MS = 120 * 1000;
/** 已有输出后这么久没有新事件，视为 mid-turn 卡死（如 tool 调用卡死） */
const ACP_STALL_TIMEOUT_MS = 10 * 60 * 1000;
const ACP_INIT_TIMEOUT_MS = 30_000;

function isActivityEvent(event: AgentEvent): boolean {
  return (
    event.type === "text_delta" ||
    event.type === "thought_delta" ||
    event.type === "tool_start" ||
    event.type === "tool_end"
  );
}

function withStderr(message: string, options: AcpRunOptions): string {
  const stderr = options.readStderr?.().trim();
  return stderr ? `${message}\n\n${stderr}` : message;
}

export async function* runActivePromptTurn(
  active: ActiveSession,
  blocks: ContentBlock[],
  options: AcpRunOptions,
): AsyncGenerator<AgentEvent> {
  void active.prompt(blocks);

  const promptTimeoutMs = options.promptTimeoutMs ?? ACP_PROMPT_TIMEOUT_MS;
  const noOutputTimeoutMs = options.noOutputTimeoutMs ?? ACP_NO_OUTPUT_TIMEOUT_MS;
  const stallTimeoutMs = options.stallTimeoutMs ?? ACP_STALL_TIMEOUT_MS;

  let sawOutput = false;
  const promptStartedAt = Date.now();
  let lastActivityAt = promptStartedAt;
  const noOutputTimeout = (): boolean =>
    !sawOutput && Date.now() - promptStartedAt >= noOutputTimeoutMs;
  // sawOutput 之后 120s watchdog 就不再生效，需要单独的 mid-turn 卡死检测
  const stallTimeout = (): boolean =>
    sawOutput && Date.now() - lastActivityAt >= stallTimeoutMs;

  let sawStop = false;
  const deadline = Date.now() + promptTimeoutMs;
  // 必须跨迭代复用同一个 nextUpdate()：每次调用都会在 SDK AsyncQueue 里注册一个
  // waiter，被 race 抛弃的 waiter 仍排在 FIFO 前面，会把后续事件全部吞掉。
  let pending: Promise<ActiveSessionMessage> | null = null;

  while (!options.isAborted() && !sawStop) {
    if (Date.now() > deadline) {
      yield {
        type: "error",
        message: withStderr("ACP 响应超时（20 分钟无结束信号）", options),
        fatal: true,
      };
      break;
    }
    if (noOutputTimeout()) {
      yield {
        type: "error",
        message: withStderr(
          "ACP 长时间无任何输出（可能 agent 未登录、模型不可用或看图任务过慢）。",
          options,
        ),
        fatal: true,
      };
      break;
    }
    if (stallTimeout()) {
      yield {
        type: "error",
        message: withStderr(
          "ACP 超过 10 分钟无新事件（可能 tool 调用卡死）",
          options,
        ),
        fatal: true,
      };
      break;
    }

    pending ??= active.nextUpdate();
    const next = await Promise.race([
      pending.then((message) => ({ message })),
      waitMs(40, options.isAborted).then(() => null),
    ]);
    if (!next) continue;
    pending = null;

    if (next.message.kind === "session_update") {
      for (const event of mapSessionUpdate(next.message.update)) {
        if (isActivityEvent(event)) {
          sawOutput = true;
          lastActivityAt = Date.now();
        }
        yield event;
      }
    } else if (next.message.kind === "stop") {
      sawStop = true;
    }
  }
}

export async function* runAcpSession(
  ctx: RunContext,
  options: AcpRunOptions,
  outHandle: { current?: AcpRunHandle },
): AsyncGenerator<AgentEvent> {
  const spawnProfile = resolveAcpSpawn(ctx.backendConfig);
  const child = spawn(spawnProfile.command, spawnProfile.args, {
    cwd: ctx.cwd,
    env: { ...process.env, ...ctx.extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  // 长时间任务下 stderr 会无界增长，只保留末尾 8 KiB 用于排障
  const appendStderr = (chunk: string): void => {
    stderr += chunk;
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  };
  // 未监听 'error' 事件时 spawn 失败（如 ENOENT）会以 uncaught exception 炸掉整个进程
  child.on("error", (err) => {
    appendStderr(`${err.message}\n`);
  });
  child.stderr?.on("data", (d) => {
    appendStderr(d.toString());
  });

  const childAlive = () =>
    child.exitCode === null && child.signalCode === null;
  const killChild = () => {
    if (childAlive()) child.kill("SIGTERM");
    setTimeout(() => {
      if (childAlive()) child.kill("SIGKILL");
    }, 2000).unref();
  };

  let sessionId = "";
  let connection: ClientConnection | undefined;
  let active: ActiveSession | undefined;

  const handle: AcpRunHandle = {
    child,
    cancel: () => {
      if (sessionId && connection) {
        void connection.agent
          .notify(methods.agent.session.cancel, { sessionId })
          .catch(() => {});
      }
      killChild();
    },
  };
  outHandle.current = handle;

  try {
    const app = createHeadlessClientApp({
      permissionPolicy: options.permissionPolicy,
    });

    const stream = childToStream(child);
    connection = app.connect(stream);

    await raceWithAbort(
      connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
        clientInfo: {
          name: "feishu-code-bridge",
          version: "0.1.0",
        },
      }),
      options.isAborted,
      ACP_INIT_TIMEOUT_MS,
      "ACP initialize 超时",
    );

    let resumeFallbackReason: string | undefined;
    active = await openActiveSession(connection, ctx, ctx.backendConfig, {
      isAborted: options.isAborted,
      onResumeFallback: (reason) => {
        resumeFallbackReason = reason;
      },
    });
    sessionId = active.sessionId;

    yield { type: "session", sessionId };
    if (resumeFallbackReason) {
      yield {
        type: "error",
        message: `ACP 续聊原会话失败，已自动新建会话：${resumeFallbackReason}`,
        fatal: false,
      };
    }

    const blocks = await buildPromptBlocks(ctx);
    yield* runActivePromptTurn(active, blocks, {
      ...options,
      readStderr: () => stderr,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = stderr.trim();
    yield {
      type: "error",
      message: detail ? `${message}\n\n${detail}` : message,
      fatal: true,
    };
    handle.cancel();
  } finally {
    active?.dispose();
    connection?.close();
    killChild();
  }
}
