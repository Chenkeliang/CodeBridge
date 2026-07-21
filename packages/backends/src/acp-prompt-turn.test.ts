import { describe, expect, it } from "vitest";
import type { ActiveSession, ActiveSessionMessage } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@feishu-code-bridge/core";
import { runActivePromptTurn } from "./acp/acp-session-runner.js";

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

  it("drain hard-cap marks the session unpoolable", async () => {
    let unpoolable = false;
    const queue = new FakeUpdateQueue();
    const gen = runActivePromptTurn(fakeActiveSession(queue), [], {
      permissionPolicy: "auto_allow",
      isAborted: () => false,
      postStopProbeMs: 1_000,
      postStopQuietMs: 5_000,
      postStopMaxMs: 120,
      markUnpoolable: () => {
        unpoolable = true;
      },
    });
    const done = collect(gen);
    queue.enqueue(toolCall);
    await sleep(20);
    queue.enqueue(stopMessage);
    await sleep(30);
    queue.enqueue(textChunk("bg")); // 确认 drain，等硬上限到点
    const events = await done;
    expect(events[events.length - 1]).toMatchObject({
      type: "error",
      fatal: false,
    });
    expect(unpoolable).toBe(true);
  });

  it("pre-drain has a hard deadline and stays interruptible by /stop", async () => {
    // 场景 1：残余后台以 <15ms 间隔持续产出，1.5s 时限后仍要把新 prompt 发出去
    {
      const queue = new FakeUpdateQueue();
      let promptCalled = false;
      const active = {
        prompt: () => {
          promptCalled = true;
          return new Promise(() => {});
        },
        nextUpdate: () => queue.next(),
      } as unknown as ActiveSession;
      const feed = setInterval(() => queue.enqueue(textChunk("x")), 8);
      const gen = runActivePromptTurn(active, [], {
        permissionPolicy: "auto_allow",
        isAborted: () => false,
        updateCarrier: { pending: null },
        noOutputTimeoutMs: 60_000,
      });
      const done = collect(gen);
      await sleep(2_000); // > 1.5s 预排干时限
      clearInterval(feed);
      expect(promptCalled).toBe(true);
      queue.enqueue(stopMessage);
      await done;
    }
    // 场景 2：/stop 能打断预排干（旧实现里打不断）
    {
      const queue = new FakeUpdateQueue();
      let aborted = false;
      let promptCalled = false;
      const active = {
        prompt: () => {
          promptCalled = true;
          return new Promise(() => {});
        },
        nextUpdate: () => queue.next(),
      } as unknown as ActiveSession;
      const feed = setInterval(() => queue.enqueue(textChunk("x")), 8);
      const gen = runActivePromptTurn(active, [], {
        permissionPolicy: "auto_allow",
        isAborted: () => aborted,
        updateCarrier: { pending: null },
      });
      const done = collect(gen);
      await sleep(200);
      aborted = true;
      const start = Date.now();
      await done;
      clearInterval(feed);
      expect(Date.now() - start).toBeLessThan(400);
      expect(promptCalled).toBe(false); // 中止后不再发新 prompt
    }
  });

  it("pre-drain with carrier: stale queued stop is dropped, stale content is yielded, new turn runs to its own end", async () => {
    const queue = new FakeUpdateQueue();
    // 上一轮 drain 退出后残留在队列里的：迟到后台内容 + 陈旧 stop
    queue.enqueue(textChunk("late bg"));
    queue.enqueue(stopMessage);
    const carrier = { pending: null };
    const gen = runActivePromptTurn(fakeActiveSession(queue), [], {
      permissionPolicy: "auto_allow",
      isAborted: () => false,
      updateCarrier: carrier,
    });
    const done = collect(gen);
    await sleep(80); // 预排干完成、prompt 已发
    queue.enqueue(textChunk("turn2 answer"));
    queue.enqueue(stopMessage); // 本轮真正的结束
    const events = await done;
    const texts = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text);
    // 陈旧内容照常送达，陈旧 stop 没有把新轮秒终结（否则收不到 turn2 answer）
    expect(texts).toEqual(["late bg", "turn2 answer"]);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("carrier relays the leftover waiter across turns (no swallowed message)", async () => {
    const queue = new FakeUpdateQueue();
    const carrier = { pending: null };
    // 轮 1：起过 tool → drain，probe 到点静默返回；返回时留下一个挂起的 waiter
    const gen1 = runActivePromptTurn(fakeActiveSession(queue), [], {
      permissionPolicy: "auto_allow",
      isAborted: () => false,
      postStopProbeMs: 120,
      updateCarrier: carrier,
    });
    const done1 = collect(gen1);
    await sleep(40); // 让预排干先空转结束（15ms 空窗），事件才进主循环
    queue.enqueue(toolCall);
    await sleep(20);
    queue.enqueue(stopMessage);
    await done1; // probe 120ms 到点返回
    expect(carrier.pending).not.toBeNull(); // 挂起 waiter 已接力到 carrier

    // 轮 2：同一 carrier 续用。若 waiter 被抛弃（旧行为），下一条消息会被僵尸 waiter 吞掉
    const gen2 = runActivePromptTurn(fakeActiveSession(queue), [], {
      permissionPolicy: "auto_allow",
      isAborted: () => false,
      updateCarrier: carrier,
    });
    const done2 = collect(gen2);
    await sleep(60);
    queue.enqueue(textChunk("turn2"));
    queue.enqueue(stopMessage);
    const events2 = await done2;
    expect(
      events2.some((e) => e.type === "text_delta" && e.text === "turn2"),
    ).toBe(true);
  });

  it("yields out-of-band events (permission_request) and counts them as activity", async () => {
    const queue = new FakeUpdateQueue();
    const oob: AgentEvent[] = [
      { type: "permission_request", requestId: "r1", title: "Bash: rm x" },
    ];
    const gen = runActivePromptTurn(fakeActiveSession(queue), [], {
      permissionPolicy: "auto_allow",
      isAborted: () => false,
      // 无输出超时设很短：若 permission_request 不算活动，会先炸 no-output fatal
      noOutputTimeoutMs: 150,
      pollOutOfBandEvents: () => oob.splice(0),
    });
    const done = collect(gen);
    await sleep(400); // 远超 noOutputTimeoutMs，靠 oob 活动撑住
    queue.enqueue(textChunk("ok"));
    queue.enqueue(stopMessage);
    const events = await done;
    expect(events[0]).toEqual({
      type: "permission_request",
      requestId: "r1",
      title: "Bash: rm x",
    });
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "text_delta" && e.text === "ok")).toBe(
      true,
    );
  });

  it("disk-activity marker growth keeps drain alive while the wire is silent", async () => {
    let marker = 100;
    const queue = new FakeUpdateQueue();
    const gen = runActivePromptTurn(fakeActiveSession(queue), [], {
      permissionPolicy: "auto_allow",
      isAborted: () => false,
      postStopProbeMs: 5_000, // probe 不参与本用例
      postStopQuietMs: 900,
      postStopMaxMs: 60_000,
      drainActivityMarker: () => marker,
    });
    const done = collect(gen);

    queue.enqueue(toolCall);
    await sleep(20);
    queue.enqueue(stopMessage); // → drain；首读只记基线
    // wire 全程静默，但磁盘每 600ms 在长（< quiet 900ms 就刷新一次）
    const grow = setInterval(() => {
      marker += 50;
    }, 600);
    await sleep(2200); // 若磁盘增长不算活动，quiet 900ms 早就到点了
    clearInterval(grow);
    queue.enqueue(textChunk("late bg result")); // 后台最终结果此刻才走 wire
    const events = await done;
    expect(
      events.some((e) => e.type === "text_delta" && e.text === "late bg result"),
    ).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("unchanged disk marker does not keep drain alive (quiet expires normally)", async () => {
    const queue = new FakeUpdateQueue();
    const start = Date.now();
    const gen = runActivePromptTurn(fakeActiveSession(queue), [], {
      permissionPolicy: "auto_allow",
      isAborted: () => false,
      postStopProbeMs: 300,
      postStopQuietMs: 5_000,
      postStopMaxMs: 60_000,
      drainActivityMarker: () => 42, // 恒定：不该确认 drain、也不该刷新
    });
    const done = collect(gen);
    queue.enqueue(toolCall);
    await sleep(20);
    queue.enqueue(stopMessage);
    const events = await done;
    // probe 300ms 到点干净返回，恒定 marker 没把它拖成 5s quiet
    expect(Date.now() - start).toBeLessThan(1500);
    expect(events.some((e) => e.type === "error")).toBe(false);
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
