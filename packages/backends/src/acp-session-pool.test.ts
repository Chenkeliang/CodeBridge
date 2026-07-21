import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  AcpSessionPool,
  resourcesAlive,
  type AcpSessionResources,
} from "./acp/acp-session-pool.js";

interface FakeHandles {
  resources: AcpSessionResources;
  disposed: () => boolean;
  closed: () => boolean;
  markDead: () => void;
}

function fakeResources(sessionId: string, over?: Partial<AcpSessionResources>): FakeHandles {
  let disposed = false;
  let closed = false;
  const state = { exitCode: null as number | null, signalCode: null as string | null };
  // pid undefined → killProcessTree 直接返回，测试里不真发信号
  const child = {
    get exitCode() {
      return state.exitCode;
    },
    get signalCode() {
      return state.signalCode;
    },
    pid: undefined,
    kill: () => true,
  } as unknown as ChildProcess;
  const resources: AcpSessionResources = {
    sessionId,
    child,
    connection: {
      close: () => {
        closed = true;
      },
    } as unknown as AcpSessionResources["connection"],
    active: {
      dispose: () => {
        disposed = true;
      },
    } as unknown as AcpSessionResources["active"],
    cwd: "/w",
    spawnKey: "npx adapter",
    envKey: "chat|topic",
    readStderr: () => "",
    carrier: { pending: null },
    runtime: {},
    ...over,
  };
  return {
    resources,
    disposed: () => disposed,
    closed: () => closed,
    markDead: () => {
      state.exitCode = 0;
    },
  };
}

const MATCH = { cwd: "/w", spawnKey: "npx adapter", envKey: "chat|topic" };

describe("AcpSessionPool", () => {
  it("release 后 acquire 命中同一对象；检出期间再 acquire 落空（并发认领走旁路）", () => {
    const pool = new AcpSessionPool({ enabled: true, idleMs: 60_000, maxPooled: 4 });
    const a = fakeResources("s1");
    pool.release(a.resources);
    expect(pool.size()).toBe(1);
    const hit = pool.acquire("s1", MATCH);
    expect(hit).toBe(a.resources);
    expect(pool.size()).toBe(0);
    expect(pool.acquire("s1", MATCH)).toBeNull(); // 已检出
    pool.shutdown();
  });

  it("匹配键不一致（cwd/spawnKey/envKey）→ 拆掉旧条目并返回 null", () => {
    const pool = new AcpSessionPool({ enabled: true, idleMs: 60_000, maxPooled: 4 });
    const a = fakeResources("s1");
    pool.release(a.resources);
    expect(pool.acquire("s1", { ...MATCH, cwd: "/other" })).toBeNull();
    expect(a.disposed()).toBe(true);
    expect(a.closed()).toBe(true);
    expect(pool.size()).toBe(0);
    pool.shutdown();
  });

  it("死进程条目 acquire 时被剔除", () => {
    const pool = new AcpSessionPool({ enabled: true, idleMs: 60_000, maxPooled: 4 });
    const a = fakeResources("s1");
    pool.release(a.resources);
    a.markDead();
    expect(resourcesAlive(a.resources)).toBe(false);
    expect(pool.acquire("s1", MATCH)).toBeNull();
    expect(a.disposed()).toBe(true);
    pool.shutdown();
  });

  it("池满 LRU 淘汰最久未用的", () => {
    const pool = new AcpSessionPool({ enabled: true, idleMs: 60_000, maxPooled: 2 });
    const a = fakeResources("s1");
    const b = fakeResources("s2");
    const c = fakeResources("s3");
    pool.release(a.resources);
    pool.release(b.resources);
    pool.release(c.resources);
    expect(pool.size()).toBe(2);
    expect(a.disposed()).toBe(true); // 最老的被淘汰
    expect(b.disposed()).toBe(false);
    expect(c.disposed()).toBe(false);
    pool.shutdown();
  });

  it("同 id 重复 release：后到的被拆掉，先到的保留（旁路进程不覆盖）", () => {
    const pool = new AcpSessionPool({ enabled: true, idleMs: 60_000, maxPooled: 4 });
    const first = fakeResources("s1");
    const second = fakeResources("s1");
    pool.release(first.resources);
    pool.release(second.resources);
    expect(pool.size()).toBe(1);
    expect(second.disposed()).toBe(true);
    expect(first.disposed()).toBe(false);
    expect(pool.acquire("s1", MATCH)).toBe(first.resources);
    pool.shutdown();
  });

  it("idle sweep 回收超时条目，保留新鲜条目", () => {
    const pool = new AcpSessionPool({ enabled: true, idleMs: 1_000, maxPooled: 4 });
    const a = fakeResources("s1");
    pool.release(a.resources);
    pool.sweep(Date.now() + 500);
    expect(pool.size()).toBe(1);
    pool.sweep(Date.now() + 2_000);
    expect(pool.size()).toBe(0);
    expect(a.disposed()).toBe(true);
    pool.shutdown();
  });

  it("shutdown 清空并拆除全部条目", () => {
    const pool = new AcpSessionPool({ enabled: true, idleMs: 60_000, maxPooled: 4 });
    const a = fakeResources("s1");
    const b = fakeResources("s2");
    pool.release(a.resources);
    pool.release(b.resources);
    pool.shutdown();
    expect(pool.size()).toBe(0);
    expect(a.disposed()).toBe(true);
    expect(b.disposed()).toBe(true);
  });

  it("disabled：acquire 恒 null，release 直接拆除（kill switch 行为=旧版）", () => {
    const pool = new AcpSessionPool({ enabled: false, idleMs: 60_000, maxPooled: 4 });
    const a = fakeResources("s1");
    pool.release(a.resources);
    expect(a.disposed()).toBe(true);
    expect(pool.size()).toBe(0);
    expect(pool.acquire("s1", MATCH)).toBeNull();
    pool.shutdown();
  });
});
