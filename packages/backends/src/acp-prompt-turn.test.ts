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
});
