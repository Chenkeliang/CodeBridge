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
import { createClaudeSessionActivityMarker } from "./acp-claude-activity.js";
import { createHeadlessClientApp } from "./headless-client.js";
import { killProcessTree } from "./acp-kill.js";
import { resolveAcpSpawn } from "./acp-spawn-profiles.js";
import {
  applySessionConfigOptions,
  resolveDesiredConfig,
} from "./acp-config-options.js";
import {
  resourcesAlive,
  teardownResources,
  type AcpSessionPool,
  type AcpSessionResources,
} from "./acp-session-pool.js";

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
  /** 主轮 stop 后，本轮起过 tool 时进入 drain；这么久内无“真实后台活动”视为无后台，返回 */
  postStopProbeMs?: number;
  /** drain 确认有后台后，这么久无新的真实活动视为后台真正结束 */
  postStopQuietMs?: number;
  /** drain 阶段独立硬上限（与主轮 20min deadline 各自计时） */
  postStopMaxMs?: number;
  /** drain 总开关，默认 true */
  drainBackgroundWork?: boolean;
  /**
   * drain 磁盘活动标记（可选）：返回单调递增的数值（如会话文件合计字节数），
   * 变化即视为后台仍在工作、刷新静默计时。wire 静默但磁盘在写时避免误切。
   */
  drainActivityMarker?: () => number | undefined;
  /** prompt_feishu 权限模式：把权限请求交给外界决策（runner 的 broker 注入） */
  requestDecision?: (info: { title: string }) => Promise<boolean>;
  /**
   * 带外事件源（可选）：每个轮询 tick 取一批插入事件流。权限请求这类发生在
   * 连接回调里的事件没法直接 yield，经它汇入 SSE。
   */
  pollOutOfBandEvents?: () => AgentEvent[];
  /**
   * 长驻会话池（可选）：命中即复用适配器进程，省每轮 spawn+initialize+resume。
   * 未传 = 每轮 spawn/杀（旧行为）。
   */
  sessionPool?: AcpSessionPool;
  /**
   * 跨轮接力的 nextUpdate waiter（池模式必传池条目的 carrier）：SDK 队列 FIFO 且
   * waiter 无法注销，被抛弃的 waiter 会吞掉下一条消息，必须原样接力。
   */
  updateCarrier?: { pending: Promise<ActiveSessionMessage> | null };
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

/** 防止 ACP prompt 永不结束导致 Runner SSE / 飞书会话队列假死；可经 config 覆盖 */
const ACP_PROMPT_TIMEOUT_MS = 40 * 60 * 1000;
/** 从发 prompt 起这么久仍无任何输出，视为卡住（常见于 session/load 或看图）；可经 config 覆盖 */
const ACP_NO_OUTPUT_TIMEOUT_MS = 10 * 60 * 1000;
/** 已有输出后这么久没有新事件，视为 mid-turn 卡死（如 tool 调用卡死）；可经 config 覆盖 */
const ACP_STALL_TIMEOUT_MS = 30 * 60 * 1000;
const ACP_INIT_TIMEOUT_MS = 30_000;
// 后台子 agent（run_in_background）的 Task 工具在“启动即返回”时就 completed，stop 时并无
// 未闭合 tool_call；后台工作作为独立任务在 stop 之后继续产出 session_update。因此靠“探测”
// 判定是否真有后台：主轮起过 tool 才进 drain，probe 短窗内出现真实活动则切 quiet 长窗直到静默。
// 实测：首个后台事件约在 stop 后 +0.8s；后台过程内可静默十几秒（如 sub-agent 跑 sleep）。
const ACP_POST_STOP_PROBE_MS = 8 * 1000;
const ACP_POST_STOP_QUIET_MS = 75 * 1000;
const ACP_POST_STOP_MAX_MS = 20 * 60 * 1000;

function isActivityEvent(event: AgentEvent): boolean {
  return (
    event.type === "text_delta" ||
    event.type === "thought_delta" ||
    event.type === "tool_start" ||
    event.type === "tool_end" ||
    // 等用户 /approve 期间 wire 必然静默，权限请求本身算活动，免得 watchdog 误杀
    event.type === "permission_request"
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
  // 池模式跨轮接力同一个 carrier；非池模式局部（行为与旧版一致）
  const carrier = options.updateCarrier ?? {
    pending: null as Promise<ActiveSessionMessage> | null,
  };

  // 池复用：发新 prompt 之前先排干队列里已排队的消息——上一轮 drain 退出后仍到达的
  // 后台产出（内容合法，照常 yield）与可能残留的陈旧 stop（丢弃，否则会被误判为新轮结束）。
  if (options.updateCarrier) {
    for (;;) {
      carrier.pending ??= active.nextUpdate();
      const got = await Promise.race([
        carrier.pending.then(
          (message) => ({ message }) as const,
          () => "failed" as const,
        ),
        new Promise<"empty">((r) => setTimeout(() => r("empty"), 15)),
      ]);
      if (got === "empty") break;
      carrier.pending = null;
      if (got === "failed") break; // 队列已失效，让主循环去暴露真实错误
      if (got.message.kind === "session_update") {
        for (const event of mapSessionUpdate(got.message.update)) {
          yield event;
        }
      }
      // kind === "stop"：陈旧的上一轮结束信号，丢弃
    }
  }

  void active.prompt(blocks);

  const promptTimeoutMs = options.promptTimeoutMs ?? ACP_PROMPT_TIMEOUT_MS;
  const noOutputTimeoutMs = options.noOutputTimeoutMs ?? ACP_NO_OUTPUT_TIMEOUT_MS;
  const stallTimeoutMs = options.stallTimeoutMs ?? ACP_STALL_TIMEOUT_MS;
  const postStopProbeMs = options.postStopProbeMs ?? ACP_POST_STOP_PROBE_MS;
  const postStopQuietMs = options.postStopQuietMs ?? ACP_POST_STOP_QUIET_MS;
  const postStopMaxMs = options.postStopMaxMs ?? ACP_POST_STOP_MAX_MS;
  const drainEnabled = options.drainBackgroundWork ?? true;

  let sawOutput = false;
  const promptStartedAt = Date.now();
  let lastActivityAt = promptStartedAt;
  const noOutputTimeout = (): boolean =>
    !sawOutput && Date.now() - promptStartedAt >= noOutputTimeoutMs;
  // sawOutput 之后 120s watchdog 就不再生效，需要单独的 mid-turn 卡死检测
  const stallTimeout = (): boolean =>
    sawOutput && Date.now() - lastActivityAt >= stallTimeoutMs;

  // "main" = 主 prompt 轮；"drain" = 主轮 stop 后续读后台子 agent 的 between-turn 输出。
  // 只有本轮起过 tool（后台必经 Task 工具）才在 stop 后进 drain；纯对话轮 stop 即返回、零延迟。
  let phase: "main" | "drain" = "main";
  let sawToolCall = false;
  let drainStartAt = 0;
  let lastDrainActivityAt = 0;
  let drainConfirmed = false;
  // 磁盘活动标记：节流读取（stat 很便宜但没必要每 40ms 一次）
  let lastMarkerValue: number | undefined;
  let lastMarkerCheckAt = 0;
  const DRAIN_MARKER_INTERVAL_MS = 500;
  let mainDeadline = promptStartedAt + promptTimeoutMs;

  while (!options.isAborted()) {
    // 带外事件（如权限请求）：发生在连接回调里，经队列汇入本事件流
    for (const oob of options.pollOutOfBandEvents?.() ?? []) {
      if (isActivityEvent(oob)) {
        sawOutput = true;
        lastActivityAt = Date.now();
      }
      if (oob.type === "permission_request") {
        // 等人回复不该撞总超时：至少留出比权限超时（8 分钟）更长的余量
        mainDeadline = Math.max(mainDeadline, Date.now() + 10 * 60 * 1000);
      }
      yield oob;
    }
    if (phase === "main") {
      if (Date.now() > mainDeadline) {
        yield {
          type: "error",
          message: withStderr(
            `ACP 响应超时（${Math.round(promptTimeoutMs / 60000)} 分钟无结束信号）`,
            options,
          ),
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
            `ACP 超过 ${Math.round(stallTimeoutMs / 60000)} 分钟无新事件（可能 tool 调用卡死）`,
            options,
          ),
          fatal: true,
        };
        break;
      }
    } else {
      // drain 阶段：未确认前用 probe 短窗探后台；确认后用 quiet 长窗等静默；独立硬上限兜底。
      // stall/noOutput 这类主轮 watchdog 不进入 drain：drain 期的静默是预期的（如 sub-agent 跑 sleep）。
      // 磁盘活动标记：后台子 agent 写盘但 wire 静默时（transcript 在长、事件没来），
      // 标记增长同样算活动——既能在 probe 窗内确认后台，也能刷新 quiet 计时防误切。
      if (
        options.drainActivityMarker &&
        Date.now() - lastMarkerCheckAt >= DRAIN_MARKER_INTERVAL_MS
      ) {
        lastMarkerCheckAt = Date.now();
        const marker = options.drainActivityMarker();
        if (marker !== undefined && marker !== lastMarkerValue) {
          if (lastMarkerValue !== undefined) {
            drainConfirmed = true;
            lastDrainActivityAt = Date.now();
          }
          lastMarkerValue = marker;
        }
      }
      if (!drainConfirmed && Date.now() - drainStartAt >= postStopProbeMs) {
        break; // 探不到真实后台活动 → 本轮无后台，干净返回
      }
      if (drainConfirmed && Date.now() - lastDrainActivityAt >= postStopQuietMs) {
        break; // 后台真正静默 → 结束
      }
      if (Date.now() - drainStartAt >= postStopMaxMs) {
        yield {
          type: "error",
          message: withStderr(
            "ACP 后台任务超过 20 分钟仍未结束，已停止跟踪并终止该会话进程。",
            options,
          ),
          fatal: false, // 主答已成功，这里只是停止跟踪，不算失败
        };
        break;
      }
    }

    // 必须跨迭代复用同一个 nextUpdate()：每次调用都会在 SDK AsyncQueue 里注册一个
    // waiter，被 race 抛弃的 waiter 仍排在 FIFO 前面，会把后续事件全部吞掉。
    carrier.pending ??= active.nextUpdate();
    const next = await Promise.race([
      carrier.pending.then((message) => ({ message })),
      waitMs(40, options.isAborted).then(() => null),
    ]);
    if (!next) continue;
    carrier.pending = null;

    if (next.message.kind === "session_update") {
      const update = next.message.update;
      if (update.sessionUpdate === "tool_call") sawToolCall = true;
      const events = mapSessionUpdate(update);
      // drain 活动信号：映射出真实事件，或后台工具的进行中进度（in-progress tool_call_update
      // 映射为空却代表后台工具仍在跑，须刷新静默计时，否则单个长工具会被 quiet 窗误切）。
      // session_info_update / usage_update 这类噪音仍不算，避免普通轮次被尾随噪音误判为有后台。
      const isDrainActivity =
        events.length > 0 || update.sessionUpdate === "tool_call_update";
      if (phase === "drain" && isDrainActivity) {
        drainConfirmed = true;
        lastDrainActivityAt = Date.now();
      }
      for (const event of events) {
        if (isActivityEvent(event)) {
          sawOutput = true;
          lastActivityAt = Date.now();
        }
        yield event;
      }
    } else if (next.message.kind === "stop") {
      if (phase !== "main") break; // drain 期再遇 stop → 结束
      if (drainEnabled && sawToolCall) {
        phase = "drain";
        drainStartAt = Date.now();
        lastDrainActivityAt = drainStartAt;
        drainConfirmed = false;
        // 不 break，继续循环续读后台事件
      } else {
        break; // 无 tool（不可能有后台）或 drain 关闭 → 今天的即时返回行为
      }
    }
  }

  if (!options.updateCarrier) {
    // 非池模式：进程即将被杀，pending 稍后因 dispose() reject，防御性吞掉。
    // 池模式绝不能走到这：pending 已存在共享 carrier 上，由下一轮接力消费。
    carrier.pending?.catch(() => {});
  }
}

/** 复用匹配键：spawn 命令与关键 env 在进程启动时冻结，任一变化都不能复用 */
export function buildSessionMatchKeys(ctx: RunContext): {
  spawnKey: string;
  envKey: string;
} {
  const profile = resolveAcpSpawn(ctx.backendConfig);
  return {
    spawnKey: `${profile.command} ${profile.args.join(" ")}`,
    envKey: `${ctx.extraEnv?.FCB_CHAT_ID ?? ""}|${ctx.extraEnv?.FCB_TOPIC_ID ?? ""}`,
  };
}

/**
 * 冷启动一个 ACP 会话的全部资源：spawn 适配器 → 连接 → initialize → 建/续会话。
 * 权限决策器经 runtime 盒子间接读取——连接上的 handler 无法换装，而 requestDecision
 * 是 per-run 闭包，必须每轮重绑（否则池复用后第二轮权限请求会调到第一轮的死闭包）。
 * 失败时自行清理（杀进程/关连接）并把 stderr 摘要附在错误里抛出。
 */
async function openAcpSessionResources(
  ctx: RunContext,
  options: AcpRunOptions,
  onSpawn: (child: ChildProcess, kill: () => void) => void,
): Promise<{
  resources: AcpSessionResources;
  resumeFallbackReason?: string;
}> {
  const spawnProfile = resolveAcpSpawn(ctx.backendConfig);
  const { spawnKey, envKey } = buildSessionMatchKeys(ctx);
  const child = spawn(spawnProfile.command, spawnProfile.args, {
    cwd: ctx.cwd,
    env: { ...process.env, ...ctx.extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true, // 自成进程组，killProcessTree 可 -pid 全组兜底（SIGKILL 不转发）
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
    if (childAlive()) killProcessTree(child, "SIGTERM");
    setTimeout(() => {
      if (childAlive()) killProcessTree(child, "SIGKILL");
    }, 2000).unref();
  };
  onSpawn(child, killChild);

  let connection: ClientConnection | undefined;
  try {
    const runtime: AcpSessionResources["runtime"] = {
      requestDecision: options.requestDecision,
    };
    const app = createHeadlessClientApp({
      permissionPolicy: options.permissionPolicy,
      requestDecision: (info) =>
        runtime.requestDecision
          ? runtime.requestDecision(info)
          : Promise.resolve(false),
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
    const active = await openActiveSession(connection, ctx, ctx.backendConfig, {
      isAborted: options.isAborted,
      onResumeFallback: (reason) => {
        resumeFallbackReason = reason;
      },
    });

    const resources: AcpSessionResources = {
      sessionId: active.sessionId,
      child,
      connection,
      active,
      cwd: ctx.cwd,
      spawnKey,
      envKey,
      readStderr: () => stderr,
      carrier: { pending: null },
      runtime,
    };
    return { resources, resumeFallbackReason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = stderr.trim();
    try {
      connection?.close();
    } catch {
      // 已关闭
    }
    killChild();
    throw new Error(detail ? `${message}\n\n${detail}` : message);
  }
}

export async function* runAcpSession(
  ctx: RunContext,
  options: AcpRunOptions,
  outHandle: { current?: AcpRunHandle },
): AsyncGenerator<AgentEvent> {
  const pool = options.sessionPool;
  const { spawnKey, envKey } = buildSessionMatchKeys(ctx);

  let resources: AcpSessionResources | undefined;
  if (pool?.enabled && ctx.resumeSessionId) {
    resources =
      pool.acquire(ctx.resumeSessionId, { cwd: ctx.cwd, spawnKey, envKey }) ??
      undefined;
  }
  const reused = resources !== undefined;

  // healthy 只在轮子完整走完且无 fatal/abort 时为真；其余一律拆除（不归还池）
  let healthy = false;
  let resumeFallbackReason: string | undefined;

  try {
    if (!resources) {
      const opened = await openAcpSessionResources(ctx, options, (child, kill) => {
        // spawn 后立刻可取消（initialize/续聊阶段 /stop 也要能杀掉）
        outHandle.current = { child, cancel: kill };
      });
      resources = opened.resources;
      resumeFallbackReason = opened.resumeFallbackReason;
    }
    const r = resources;

    outHandle.current = {
      child: r.child,
      cancel: () => {
        void r.connection.agent
          .notify(methods.agent.session.cancel, { sessionId: r.sessionId })
          .catch(() => {});
        // 中断即弃进程（含池条目语义：本轮资源已检出，不会再归还）
        teardownResources(r);
      },
    };

    yield { type: "session", sessionId: r.sessionId };
    if (resumeFallbackReason) {
      yield {
        type: "error",
        message: `ACP 续聊原会话失败，已自动新建会话：${resumeFallbackReason}`,
        fatal: false,
      };
    }

    // 每轮重绑权限决策器（per-run 闭包；池复用时旧闭包已随上一轮失效）
    r.runtime.requestDecision = options.requestDecision;

    // 用 ACP 标准 session/set_config_option 应用 model/effort/permission（Zed 同款机制）。
    // 每轮都重设：/model 等命令可在两轮之间改变绑定，池内进程的 currentValue 需要跟上。
    const desired = resolveDesiredConfig(ctx, options.permissionPolicy);
    const { warnings } = await applySessionConfigOptions(
      r.connection.agent,
      r.sessionId,
      r.active.newSessionResponse.configOptions ?? [],
      desired,
    );
    for (const warning of warnings) {
      yield { type: "error", message: warning, fatal: false };
    }

    const blocks = await buildPromptBlocks(ctx);
    let sawFatal = false;
    for await (const event of runActivePromptTurn(r.active, blocks, {
      ...options,
      readStderr: r.readStderr,
      // 池模式跨轮接力 pending waiter；复用轮先排干队列残留
      updateCarrier: pool?.enabled ? r.carrier : undefined,
      // claude 的后台子 agent 写盘不走 wire，用会话文件增长作 drain 的补充活动信号
      drainActivityMarker:
        options.drainActivityMarker ??
        (ctx.backendConfig.type === "claude-code"
          ? createClaudeSessionActivityMarker(ctx.cwd, r.sessionId)
          : undefined),
    })) {
      if (event.type === "error" && event.fatal) sawFatal = true;
      yield event;
    }
    healthy = !sawFatal && !options.isAborted() && resourcesAlive(r);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = resources?.readStderr().trim() ?? "";
    yield {
      type: "error",
      message:
        detail && !message.includes(detail)
          ? `${message}\n\n${detail}`
          : message,
      fatal: true,
    };
  } finally {
    if (resources) {
      // 防跨轮死闭包：轮末即解绑，池空闲期的权限请求直接按拒绝处理
      resources.runtime.requestDecision = undefined;
      if (healthy && pool?.enabled) {
        pool.release(resources);
      } else {
        teardownResources(resources);
      }
    }
  }
  // reused 变量供将来遥测（冷/热轮次统计），当前无消费者
  void reused;
}
