import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { afterEach } from "vitest";
import type { AgentEvent, RunContext } from "@codebridge/core";
import {
  forkPiSession,
  mapPiEvent,
  probePiSdk,
  runPiSession,
  type PiRunHandleRef,
  type PiSession,
} from "./pi-session-runner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: "run-pi-1",
    cwd: "/workspace",
    prompt: "inspect the project",
    backendConfig: { type: "pi-sdk" },
    ...overrides,
  };
}

function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  return (async () => {
    const result: AgentEvent[] = [];
    for await (const event of events) result.push(event);
    return result;
  })();
}

class FakePiSession implements PiSession {
  readonly sessionId = "pi-session-1";
  private listener?: (event: unknown) => void;
  aborted = false;
  disposed = false;
  prompts: string[] = [];

  subscribe(listener: (event: unknown) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.listener?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "ready" },
    });
  }

  async steer(text: string): Promise<void> {
    this.listener?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: `steer:${text}` },
    });
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  dispose(): void {
    this.disposed = true;
  }
}

describe("Pi event mapping", () => {
  it("maps text, thinking, and tool lifecycle events to bridge events", () => {
    expect(
      mapPiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hello" },
      }),
    ).toEqual([{ type: "text_delta", text: "hello" }]);
    expect(
      mapPiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "reason" },
      }),
    ).toEqual([{ type: "thought_delta", text: "reason" }]);
    expect(
      mapPiEvent({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "README.md" },
      }),
    ).toEqual([
      {
        type: "tool_start",
        toolCallId: "tool-1",
        name: "read",
        input: { path: "README.md" },
      },
    ]);
    expect(
      mapPiEvent({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "ok" }] },
        isError: false,
      }),
    ).toEqual([
      {
        type: "tool_end",
        toolCallId: "tool-1",
        name: "read",
        status: "completed",
        output: { content: [{ type: "text", text: "ok" }] },
      },
    ]);
  });
});

describe("Pi session runner", () => {
  it("forks a persisted provider session into a new project directory", async () => {
    const sourceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "fcb-pi-source-"));
    const targetCwd = await fs.mkdtemp(path.join(os.tmpdir(), "fcb-pi-target-"));
    tempDirs.push(sourceCwd, targetCwd);
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const source = SessionManager.create(sourceCwd);
    source.appendMessage({
      role: "user",
      content: "seed conversation",
      timestamp: Date.now(),
    } as never);
    await fs.mkdir(path.dirname(source.getSessionFile()!), { recursive: true });
    await fs.writeFile(
      source.getSessionFile()!,
      `${JSON.stringify(source.getHeader())}\n${source
        .getEntries()
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );

    const forked = await forkPiSession(sourceCwd, source.getSessionId(), targetCwd);

    expect(forked).toMatchObject({ ok: true, cwd: targetCwd });
    expect(forked.sessionId).toBeTruthy();
    expect(forked.sessionId).not.toBe(source.getSessionId());
  });

  it("checks SDK/session storage without starting a model run", async () => {
    await expect(probePiSdk("/tmp")).resolves.toEqual({
      ok: true,
      message: "Pi SDK available",
    });
  });

  it("creates a native Pi session, emits its provider id, and disposes it", async () => {
    const session = new FakePiSession();
    const handle: PiRunHandleRef = {};
    const events = await collect(
      runPiSession(context(), {
        createSession: async () => session,
        isAborted: () => false,
        handleRef: handle,
      }),
    );

    expect(events).toEqual([
      { type: "session", sessionId: "pi-session-1" },
      { type: "text_delta", text: "ready" },
    ]);
    expect(session.prompts).toEqual(["inspect the project"]);
    expect(session.disposed).toBe(true);
    expect(handle.current).toBeUndefined();
  });

  it("forwards cancellation to the native session", async () => {
    const session = new FakePiSession();
    const handle: PiRunHandleRef = {};
    const run = runPiSession(context(), {
      createSession: async () => session,
      isAborted: () => false,
      handleRef: handle,
    });
    await run.next();
    expect(handle.current).toBeDefined();
    await handle.current!.cancel();
    expect(session.aborted).toBe(true);
    await run.return(undefined);
    expect(session.disposed).toBe(true);
  });
});
