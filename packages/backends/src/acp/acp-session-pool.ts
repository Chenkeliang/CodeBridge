import type { ChildProcess } from "node:child_process";
import type {
  ActiveSession,
  ActiveSessionMessage,
  ClientConnection,
} from "@agentclientprotocol/sdk";
import { killProcessTree } from "./acp-kill.js";

/** 每轮由 runner 重绑的会话运行时：per-run 闭包绝不能跨轮沿用（否则第二轮权限请求会调到第一轮的死闭包） */
export interface AcpSessionRuntime {
  requestDecision?: (info: { title: string }) => Promise<boolean>;
}

/**
 * 一个长驻 ACP 会话的全部资源。池命中时整个对象跨轮复用——尤其 `active` 与 `carrier`：
 * 同一连接上对同一 sessionId 再 attach 会造成双队列重复投递（SDK SessionUpdateRouter 是
 * Set 追加），被抛弃的 nextUpdate waiter 会吞掉下一条消息（FIFO 且无注销 API），
 * 所以 ActiveSession 对象与挂起的 waiter 都必须原样接力，绝不能重建或丢弃。
 */
export interface AcpSessionResources {
  sessionId: string;
  child: ChildProcess;
  connection: ClientConnection;
  active: ActiveSession;
  /** 复用匹配键：cwd/spawn 命令/env 任一变了都不能复用（进程启动时已冻结） */
  cwd: string;
  spawnKey: string;
  envKey: string;
  /** stderr 尾部缓冲，跨轮累积 */
  readStderr: () => string;
  /** 跨轮接力的 nextUpdate waiter */
  carrier: { pending: Promise<ActiveSessionMessage> | null };
  runtime: AcpSessionRuntime;
}

export interface AcpSessionPoolOptions {
  enabled: boolean;
  /** 空闲这么久后回收（ms） */
  idleMs: number;
  /** 池内最多保留多少个空闲会话进程 */
  maxPooled: number;
}

const SWEEP_INTERVAL_MS = 60_000;

export function resourcesAlive(r: AcpSessionResources): boolean {
  return r.child.exitCode === null && r.child.signalCode === null;
}

/** 完整拆除一个会话：dispose 路由、关连接、杀整棵进程树（2s 后 SIGKILL 兜底） */
export function teardownResources(r: AcpSessionResources): void {
  try {
    r.active.dispose();
  } catch {
    // 已 dispose / 连接已死
  }
  try {
    r.connection.close();
  } catch {
    // 已关闭
  }
  killProcessTree(r.child, "SIGTERM");
  const child = r.child;
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      killProcessTree(child, "SIGKILL");
    }
  }, 2000).unref();
}

/**
 * 长驻 ACP 会话池（check-out/check-in 模型）：
 * - acquire 命中即把条目从池里取走（运行期不在池内）——同一 sessionId 的并发第二个
 *   认领者（/resume 可让两个会话绑同一 id）自然 miss、走独立冷启动，无需 busy 锁；
 * - release 在健康轮末把资源放回（池满先淘汰最久未用的）；
 * - 出错/中断/超时一律不归还（由调用方 teardown），池只保留干净收尾的会话；
 * - idle sweep 回收长时间没人用的进程；shutdown 必须在 runner 退出前调用
 *  （子进程 detached，不会随 runner 死）。
 */
export class AcpSessionPool {
  private readonly idle = new Map<
    string,
    { resources: AcpSessionResources; lastUsedAt: number }
  >();
  private readonly sweepTimer?: NodeJS.Timeout;

  constructor(private readonly options: AcpSessionPoolOptions) {
    if (options.enabled) {
      this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
      this.sweepTimer.unref();
    }
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  size(): number {
    return this.idle.size;
  }

  acquire(
    sessionId: string,
    match: { cwd: string; spawnKey: string; envKey: string },
  ): AcpSessionResources | null {
    if (!this.options.enabled) return null;
    const entry = this.idle.get(sessionId);
    if (!entry) return null;
    this.idle.delete(sessionId);
    const r = entry.resources;
    if (
      !resourcesAlive(r) ||
      r.cwd !== match.cwd ||
      r.spawnKey !== match.spawnKey ||
      r.envKey !== match.envKey
    ) {
      teardownResources(r);
      return null;
    }
    return r;
  }

  release(r: AcpSessionResources): void {
    if (!this.options.enabled || !resourcesAlive(r)) {
      teardownResources(r);
      return;
    }
    // 并发认领的旁路进程后到：同 id 已有空闲条目时不覆盖（否则先到者被泄漏），拆掉后来的
    if (this.idle.has(r.sessionId)) {
      teardownResources(r);
      return;
    }
    while (this.idle.size >= this.options.maxPooled) {
      let oldestId: string | undefined;
      let oldestAt = Infinity;
      for (const [id, entry] of this.idle) {
        if (entry.lastUsedAt < oldestAt) {
          oldestAt = entry.lastUsedAt;
          oldestId = id;
        }
      }
      if (oldestId === undefined) break;
      const evicted = this.idle.get(oldestId)!;
      this.idle.delete(oldestId);
      teardownResources(evicted.resources);
    }
    this.idle.set(r.sessionId, { resources: r, lastUsedAt: Date.now() });
  }

  sweep(now = Date.now()): void {
    for (const [id, entry] of [...this.idle.entries()]) {
      if (
        !resourcesAlive(entry.resources) ||
        now - entry.lastUsedAt >= this.options.idleMs
      ) {
        this.idle.delete(id);
        teardownResources(entry.resources);
      }
    }
  }

  shutdown(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const [id, entry] of [...this.idle.entries()]) {
      this.idle.delete(id);
      teardownResources(entry.resources);
    }
  }
}
