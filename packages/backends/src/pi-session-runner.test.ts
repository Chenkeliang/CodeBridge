import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { afterEach } from "vitest";
import type { AgentEvent, RunContext } from "@codebridge/core";
import {
  collectPiSessionHistory,
  createPiModelRuntime,
  forkPiSession,
  listPiCommands,
  listPiConfigOptions,
  mapPiEvent,
  probePiSdk,
  resolvePiSessionManager,
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

async function capturePiPromptPayload(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const session = new FakePiSession();

  await collect(runPiSession({
    runId: "run-pi-stability",
    cwd: "/workspace",
    prompt: "inspect the project",
    backendConfig: { type: "pi-sdk" },
    ...overrides,
  } as RunContext, {
    createSession: async () => session,
    isAborted: () => false,
  }));

  expect(session.promptCalls).toHaveLength(1);
  return JSON.stringify(session.promptCalls[0]);
}

class FakePiSession implements PiSession {
  readonly sessionId = "pi-session-1";
  private listener?: (event: unknown) => void;
  aborted = false;
  abortBashCalls = 0;
  hangAbort = false;
  disposed = false;
  prompts: string[] = [];
  promptCalls: Array<{ text: string; options?: { images?: unknown[] } }> = [];

  subscribe(listener: (event: unknown) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  async prompt(text: string, options?: { images?: unknown[] }): Promise<void> {
    this.prompts.push(text);
    this.promptCalls.push({
      text,
      options: options ? JSON.parse(JSON.stringify(options)) : undefined,
    });
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

  abortBash(): void {
    this.abortBashCalls += 1;
  }

  async abort(): Promise<void> {
    this.aborted = true;
    if (this.hangAbort) await new Promise(() => {});
  }

  dispose(): void {
    this.disposed = true;
  }
}

describe("Pi event mapping", () => {
  it("normalizes persisted Pi messages for the Workbench", () => {
    expect(collectPiSessionHistory([
      {
        id: "user-1",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "查询会员" }] },
      },
      {
        id: "agent-1",
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "先检查会员记录" },
            { type: "text", text: "会员有效" },
          ],
        },
      },
    ])).toEqual([
      { kind: "message", text: "查询会员" },
      { kind: "agent_event", event: { type: "thought_delta", text: "先检查会员记录" } },
      { kind: "agent_event", event: { type: "text_delta", text: "会员有效", messageId: "agent-1" } },
    ]);
  });

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

  it("maps the final Pi assistant failure to a fatal bridge error", () => {
    expect(
      mapPiEvent({
        type: "agent_end",
        willRetry: false,
        messages: [{
          role: "assistant",
          stopReason: "error",
          errorMessage: "OpenAI API error (404): model unavailable",
        }],
      }),
    ).toEqual([{
      type: "error",
      message: "OpenAI API error (404): model unavailable",
      fatal: true,
    }]);
  });

  it("does not surface an intermediate Pi failure while it will retry", () => {
    expect(
      mapPiEvent({
        type: "agent_end",
        willRetry: true,
        messages: [{
          role: "assistant",
          stopReason: "error",
          errorMessage: "temporary provider failure",
        }],
      }),
    ).toEqual([]);
  });
});

describe("Pi session runner", () => {
  it("loads literal provider credentials from Pi models.json", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "fcb-pi-runtime-"));
    tempDirs.push(cwd);
    const modelsPath = path.join(cwd, "models.json");
    const authPath = path.join(cwd, "auth.json");
    await fs.writeFile(modelsPath, JSON.stringify({
      providers: {
        dedao: {
          baseUrl: "https://llm.example.test",
          api: "openai-responses",
          apiKey: "test-key",
          models: [{
            id: "gpt-test",
            name: "GPT Test",
            reasoning: true,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 16000,
          }],
        },
      },
    }));

    const runtime = await createPiModelRuntime({ modelsPath, authPath });

    expect(runtime.getModel("dedao", "gpt-test")).toBeDefined();
    expect(runtime.hasConfiguredAuth("dedao")).toBe(true);
  });

  it("lists project Skills as Pi slash commands", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "fcb-pi-skills-"));
    tempDirs.push(cwd);
    const skillDir = path.join(cwd, ".pi", "skills", "project-review");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: project-review\ndescription: Review this project\n---\n",
    );

    await expect(listPiCommands(cwd)).resolves.toContainEqual({
      name: "skill:project-review",
      description: "Review this project",
    });
  });

  it("lists shared .agents Skills through Pi resource discovery", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "fcb-pi-agents-skills-"));
    tempDirs.push(cwd);
    const skillDir = path.join(cwd, ".agents", "skills", "shared-review");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: shared-review\ndescription: Review from shared skills\n---\n",
    );

    await expect(listPiCommands(cwd)).resolves.toContainEqual({
      name: "skill:shared-review",
      description: "Review from shared skills",
    });
  });

  it("only exposes models from configured Pi providers", async () => {
    const runtime = {
      getModels: () => [
        { provider: "configured", id: "ready", name: "Ready", api: "test" },
        { provider: "catalog-only", id: "hidden", name: "Hidden", api: "test" },
      ],
      hasConfiguredAuth: (provider: string) => provider === "configured",
    };

    const options = await listPiConfigOptions(runtime as never);

    expect(options).toContainEqual(expect.objectContaining({
      category: "model",
      values: [{ value: "configured/ready", name: "Ready", description: "test" }],
    }));
    expect(options).toContainEqual(expect.objectContaining({
      category: "thought_level",
      values: expect.arrayContaining([
        expect.objectContaining({ value: "off" }),
        expect.objectContaining({ value: "xhigh" }),
        expect.objectContaining({ value: "max" }),
      ]),
    }));
  });

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
      { type: "text_delta", text: "ready" },
      { type: "session", sessionId: "pi-session-1" },
    ]);
    expect(session.prompts).toEqual(["inspect the project"]);
    expect(session.disposed).toBe(true);
    expect(handle.current).toBeUndefined();
  });

  it("keeps Pi prompt payload byte-for-byte stable when setup/default metadata changes", async () => {
    const baseline = await capturePiPromptPayload();
    const withMetadata = await capturePiPromptPayload({
      defaultAgent: "codex",
      setupMetadata: {
        installation: "installed",
        configuration: "configured",
        runtime: "healthy",
      },
      setupMarker: "LEAK-PI-SETUP",
    });

    expect(withMetadata).toBe(baseline);
    expect(withMetadata).not.toContain("LEAK-PI-SETUP");
  });

  it("does not bind a provider Session when the first prompt fails", async () => {
    const session = new FakePiSession();
    session.prompt = async () => {
      throw new Error("provider unavailable");
    };

    const events = await collect(runPiSession(context(), {
      createSession: async () => session,
      isAborted: () => false,
    }));

    expect(events).toEqual([{ type: "error", message: "provider unavailable", fatal: true }]);
  });

  it("fails instead of reporting success when Pi produces no output", async () => {
    const session = new FakePiSession();
    session.prompt = async () => {};

    const events = await collect(runPiSession(context(), {
      createSession: async () => session,
      isAborted: () => false,
    }));

    expect(events).toEqual([{
      type: "error",
      message: "Pi run completed without assistant output or a provider error",
      fatal: true,
    }]);
  });

  it("deduplicates the final Pi error emitted by agent and retry events", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const session: PiSession = {
      sessionId: "pi-session-error",
      subscribe(next) {
        listener = next;
        return () => { listener = undefined; };
      },
      async prompt() {
        const message = {
          role: "assistant",
          stopReason: "error",
          errorMessage: "OpenAI API error (404): model unavailable",
        };
        listener?.({ type: "agent_end", willRetry: false, messages: [message] });
        listener?.({ type: "auto_retry_end", success: false, attempt: 3, finalError: message.errorMessage });
      },
      async steer() {},
      async abort() {},
      dispose() {},
    };

    const events = await collect(runPiSession(context(), {
      createSession: async () => session,
      isAborted: () => false,
    }));

    expect(events).toEqual([
      { type: "error", message: "OpenAI API error (404): model unavailable", fatal: true },
      { type: "session", sessionId: "pi-session-error" },
    ]);
  });

  it("starts a fresh native Session when a stored Pi Session no longer exists", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "fcb-pi-stale-session-"));
    tempDirs.push(cwd);

    const manager = await resolvePiSessionManager(context({ cwd, resumeSessionId: "missing-session" }));

    expect(manager.getSessionId()).not.toBe("missing-session");
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
    expect(session.abortBashCalls).toBe(1);
    expect(session.aborted).toBe(true);
    await run.return(undefined);
    expect(session.disposed).toBe(true);
  });

  it("kills bash and unblocks even if abort never becomes idle", async () => {
    vi.useFakeTimers();
    try {
      const session = new FakePiSession();
      session.hangAbort = true;
      const handle: PiRunHandleRef = {};
      const run = runPiSession(context(), {
        createSession: async () => session,
        isAborted: () => false,
        handleRef: handle,
      });
      await run.next();
      const cancelled = handle.current!.cancel();
      await vi.advanceTimersByTimeAsync(2_000);
      await cancelled;
      expect(session.abortBashCalls).toBe(1);
      expect(session.aborted).toBe(true);
      await run.return(undefined);
      expect(session.disposed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Pi event error surfacing", () => {
  it("maps exhausted auto-retry to a fatal error event", async () => {
    const { mapPiEvent } = await import("./pi-session-runner.js");
    const events = mapPiEvent({ type: "auto_retry_end", success: false, attempt: 3, finalError: "No available channel for model deepseek-v4-pro" });
    expect(events).toEqual([{ type: "error", message: "No available channel for model deepseek-v4-pro", fatal: true }]);
  });

  it("ignores successful retry completion", async () => {
    const { mapPiEvent } = await import("./pi-session-runner.js");
    expect(mapPiEvent({ type: "auto_retry_end", success: true, attempt: 2 })).toEqual([]);
  });
});
