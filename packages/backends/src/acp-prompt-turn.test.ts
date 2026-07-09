import { describe, expect, it } from "vitest";
import type { ActiveSession, ActiveSessionMessage } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@feishu-code-bridge/core";
import type { RunContext } from "@feishu-code-bridge/core";
import {
  buildAcpChildEnv,
  runActivePromptTurn,
} from "./acp/acp-session-runner.js";

/** 复刻 SDK AsyncQueue 语义：enqueue 交给最早注册的 waiter（FIFO） */
class FakeUpdateQueue {
  private values: ActiveSessionMessage[] = [];
  private waiters: Array<{
    resolve: (m: ActiveSessionMessage) => void;
    reject: (e: unknown) => void;
  }> = [];

  enqueue(message: ActiveSessionMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(message);
    else this.values.push(message);
  }

  reject(error: unknown): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<ActiveSessionMessage> {
    const value = this.values.shift();
    if (value) return Promise.resolve(value);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

function fakeActiveSession(queue: FakeUpdateQueue): ActiveSession {
  return {
    prompt: () => new Promise(() => {}),
    nextUpdate: () => queue.next(),
  } as unknown as ActiveSession;
}

function textChunk(text: string): ActiveSessionMessage {
  return {
    kind: "session_update",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  } as ActiveSessionMessage;
}

const stopMessage = {
  kind: "stop",
  stopReason: "end_turn",
  response: { stopReason: "end_turn" },
} as unknown as ActiveSessionMessage;

/** 一次 tool 调用的 session_update（映射为 tool_start，并把本轮标记为“起过 tool”） */
const toolCall = {
  kind: "session_update",
  update: { sessionUpdate: "tool_call", title: "bg", kind: "think" },
} as unknown as ActiveSessionMessage;

/** 后台工具的进行中进度 ping：映射为空事件，但 drain 期应算作活动、刷新静默计时 */
const toolProgress = {
  kind: "session_update",
  update: { sessionUpdate: "tool_call_update", status: "in_progress" },
} as unknown as ActiveSessionMessage;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function collect(
  gen: AsyncGenerator<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe("runActivePromptTurn", () => {
  it("delivers updates that arrive after quiet gaps longer than the poll tick", async () => {
    const queue = new FakeUpdateQueue();
    const gen = runActivePromptTurn(fakeActiveSession(queue), [], {
      permissionPolicy: "auto_allow",
      isAborted: () => false,
    });
    const done = collect(gen);

    // 每个事件之间留 >40ms 的静默期；旧实现每 40ms 泄漏一个 waiter，
    // 之后的事件会被僵尸 waiter 吞掉，这里一个都收不到。
    await sleep(120);
    queue.enqueue(textChunk("hello"));
    await sleep(120);
    queue.enqueue(textChunk(" world"));
    await sleep(120);
    queue.enqueue(stopMessage);

    const events = await done;
    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "text_delta", text: " world" },
    ]);
  });

  it("ends the turn when the stop message arrives", async () => {
    const queue = new FakeUpdateQueue();
    queue.enqueue(stopMessage);
    const events = await collect(
      runActivePromptTurn(fakeActiveSession(queue), [], {
        permissionPolicy: "auto_allow",
        isAborted: () => false,
      }),
    );
    expect(events).toEqual([]);
  });

  it("surfaces prompt failures instead of waiting for the watchdog", async () => {
    const queue = new FakeUpdateQueue();
    const gen = runActivePromptTurn(fakeActiveSession(queue), [], {
      permissionPolicy: "auto_allow",
      isAborted: () => false,
    });
    const done = collect(gen);
    await sleep(60);
    queue.reject(new Error("auth required"));
    await expect(done).rejects.toThrow("auth required");
  });

  it("stops promptly when aborted", async () => {
    let aborted = false;
    const queue = new FakeUpdateQueue();
    const gen = runActivePromptTurn(fakeActiveSession(queue), [], {
      permissionPolicy: "auto_allow",
      isAborted: () => aborted,
    });
    const done = collect(gen);
    await sleep(60);
    aborted = true;
    expect(await done).toEqual([]);
  });

  it("fires a fatal stall error when output goes silent mid-turn", async () => {
    const queue = new FakeUpdateQueue();
    const gen = runActivePromptTurn(fakeActiveSession(queue), [], {
      permissionPolicy: "auto_allow",
      isAborted: () => false,
      noOutputTimeoutMs: 10_000,
      stallTimeoutMs: 100,
    });
    const done = collect(gen);

    queue.enqueue(textChunk("hello"));
    // 之后再不 enqueue 任何事件，模拟 tool 调用卡死

    const events = await done;
    expect(events[0]).toEqual({ type: "text_delta", text: "hello" });
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: "error", fatal: true });
    expect((last as { message: string }).message).toMatch(/无新事件|stall/);
  });

  it("does not drain when the turn had no tool call (stop returns immediately)", async () => {
    const queue = new FakeUpdateQueue();
    queue.enqueue(textChunk("hi"));
    queue.enqueue(stopMessage);
    const start = Date.now();
    const events = await collect(
      runActivePromptTurn(fakeActiveSession(queue), [], {
        permissionPolicy: "auto_allow",
        isAborted: () => false,
        // 大 probe 窗；若错误地进入 drain 会明显拖慢
        postStopProbeMs: 5_000,
      }),
    );
    expect(events).toEqual([{ type: "text_delta", text: "hi" }]);
    expect(Date.now() - start).toBeLessThan(400);
  });

  it("drains past stop and delivers background events after a tool call", async () => {
    const queue = new FakeUpdateQueue();
    const gen = runActivePromptTurn(fakeActiveSession(queue), [], {
      permissionPolicy: "auto_allow",
      isAborted: () => false,
      postStopProbeMs: 1_000,
      postStopQuietMs: 200,
      postStopMaxMs: 60_000,
    });
    const done = collect(gen);

    queue.enqueue(toolCall); // 主轮起过 tool
    await sleep(20);
    queue.enqueue(stopMessage); // 主轮结束 → 进 drain
    await sleep(60);
    queue.enqueue(textChunk("bg result")); // stop 后的后台活动，probe 内确认
    // 之后静默；quiet 200ms 到点收尾

    const events = await done;
    expect(events.some((e) => e.type === "tool_start" && e.name === "bg")).toBe(
      true,
    );
    expect(
      events.some((e) => e.type === "text_delta" && e.text === "bg result"),
    ).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("returns cleanly when a tool-using turn has no background (probe expires, no error)", async () => {
    const queue = new FakeUpdateQueue();
    const gen = runActivePromptTurn(fakeActiveSession(queue), [], {
      permissionPolicy: "auto_allow",
      isAborted: () => false,
      postStopProbeMs: 150,
    });
    const done = collect(gen);

    queue.enqueue(toolCall);
    await sleep(20);
    queue.enqueue(stopMessage); // 进 drain，但之后无任何后台活动
    // probe 150ms 到点 → 干净返回

    const events = await done;
    expect(events.some((e) => e.type === "tool_start")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("force-ends drain with a non-fatal error at the hard cap", async () => {
    const queue = new FakeUpdateQueue();
    const gen = runActivePromptTurn(fakeActiveSession(queue), [], {
      permissionPolicy: "auto_allow",
      isAborted: () => false,
      postStopProbeMs: 1_000,
      postStopQuietMs: 5_000, // quiet 不会触发
      postStopMaxMs: 120, // 独立硬上限先到点
    });
    const done = collect(gen);

    queue.enqueue(toolCall);
    await sleep(20);
    queue.enqueue(stopMessage);
    await sleep(30);
    queue.enqueue(textChunk("bg")); // 确认 drain

    const events = await done;
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: "error", fatal: false });
  });

  it("aborts promptly during drain", async () => {
    let aborted = false;
    const queue = new FakeUpdateQueue();
    const gen = runActivePromptTurn(fakeActiveSession(queue), [], {
      permissionPolicy: "auto_allow",
      isAborted: () => aborted,
      postStopProbeMs: 5_000,
      postStopQuietMs: 5_000,
    });
    const done = collect(gen);

    queue.enqueue(toolCall);
    await sleep(20);
    queue.enqueue(stopMessage);
    await sleep(30);
    queue.enqueue(textChunk("bg")); // 确认 drain，进入长 quiet 窗
    await sleep(30);
    aborted = true; // drain 中途 abort

    const start = Date.now();
    const events = await done;
    expect(Date.now() - start).toBeLessThan(400); // 不等满 5s quiet
    expect(events.some((e) => e.type === "text_delta" && e.text === "bg")).toBe(
      true,
    );
  });

  it("keeps draining when in-progress tool_call_update pings arrive (refreshes quiet)", async () => {
    const queue = new FakeUpdateQueue();
    const gen = runActivePromptTurn(fakeActiveSession(queue), [], {
      permissionPolicy: "auto_allow",
      isAborted: () => false,
      postStopProbeMs: 1_000, // probe 宽松，不参与本用例竞争
      postStopQuietMs: 250,
      postStopMaxMs: 60_000,
    });
    const done = collect(gen);

    queue.enqueue(toolCall); // 主轮起过 tool
    await sleep(20);
    queue.enqueue(stopMessage); // → drain
    await sleep(20);
    queue.enqueue(textChunk("bg1")); // 确认 drain，起算静默
    await sleep(150); // < quiet(250)，仍存活
    queue.enqueue(toolProgress); // 进行中进度：须刷新静默，否则下面 bg2 会被 quiet 切掉
    await sleep(200); // 距 bg1 已 >quiet，但距 toolProgress 仍 <quiet
    queue.enqueue(textChunk("bg2"));
    // 之后静默；quiet 250ms 到点收尾

    const events = await done;
    const texts = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text);
    expect(texts).toContain("bg1");
    // 若 in-progress tool_call_update 不算活动，bg2 会在 quiet 到点后丢失
    expect(texts).toContain("bg2");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("buildAcpChildEnv", () => {
  const ctx = (over: Partial<RunContext>): RunContext =>
    ({
      runId: "r",
      cwd: "/x",
      prompt: "p",
      backendConfig: { type: "claude-code" },
      ...over,
    }) as unknown as RunContext;

  it("ctx.model 优先", () => {
    const env = buildAcpChildEnv(
      ctx({
        model: "sonnet",
        backendConfig: { type: "claude-code", model: "opus" } as never,
      }),
    );
    expect(env.ANTHROPIC_MODEL).toBe("sonnet");
  });

  it("回退到 backendConfig.model", () => {
    const env = buildAcpChildEnv(
      ctx({ backendConfig: { type: "claude-code", model: "opus" } as never }),
    );
    expect(env.ANTHROPIC_MODEL).toBe("opus");
  });

  it("两者都无则不设 ANTHROPIC_MODEL", () => {
    const env = buildAcpChildEnv(
      ctx({ backendConfig: { type: "claude-code" } as never }),
    );
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
  });

  it("非 claude 后端不注入 ANTHROPIC_MODEL", () => {
    const env = buildAcpChildEnv(
      ctx({
        model: "sonnet",
        backendConfig: { type: "cursor-cli", model: "composer-2.5" } as never,
      }),
    );
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
  });

  it("extraEnv 可覆盖", () => {
    const env = buildAcpChildEnv(
      ctx({ model: "sonnet", extraEnv: { ANTHROPIC_MODEL: "haiku" } }),
    );
    expect(env.ANTHROPIC_MODEL).toBe("haiku");
  });
});
