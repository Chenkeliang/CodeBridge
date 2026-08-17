import { describe, expect, it, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "@codebridge/core";
import { SessionRouter } from "./session-router.js";
import { RunOrchestrator } from "./orchestrator.js";

const tmpDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("RunOrchestrator session persistence", () => {
  it("does not create an empty session record when a run fails before yielding a session id", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-orchestrator-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-workspace-"));
    tmpDirs.push(dataDir, cwd);
    const config = defaultConfig();
    const orchestrator = new RunOrchestrator({ dataDir, config });
    orchestrator.router.setBinding("chat1", { cwd });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          [
            'data: {"type":"error","message":"resume failed","fatal":true}',
            "",
            'data: {"type":"done","exitCode":1}',
            "",
          ].join("\n"),
          { status: 200 },
        ),
      ),
    );

    const events: Array<{ type: string; exitCode?: number }> = [];
    for await (const event of orchestrator.runAgent("chat1", undefined, "hi")) {
      events.push(event as { type: string; exitCode?: number });
    }

    // runAgent 不再写 sessions.json（Task 12）；失败 run 只透传事件。
    expect(events).toContainEqual({ type: "done", exitCode: 1 });
  });

  it("waits for the stopped stream to finish before cancellation resolves", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-orchestrator-"));
    tmpDirs.push(dataDir);
    const orchestrator = new RunOrchestrator({ dataDir, config: defaultConfig() });
    (orchestrator as unknown as { client: unknown }).client = {
      run: async function* () {
        yield { type: "session", sessionId: "s1" } as const;
        yield { type: "text_delta", text: "late event" } as const;
      },
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const stream = orchestrator.runAgent("chat1", undefined, "hi");
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: "session", sessionId: "s1" },
    });

    let cancelResolved = false;
    const cancelPromise = orchestrator.cancelActiveForChat("chat1").then((result) => {
      cancelResolved = true;
      return result;
    });
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: "error", message: "任务已停止", fatal: false },
    });
    await Promise.resolve();
    expect(cancelResolved).toBe(false);

    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: "done", exitCode: 130 },
    });
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(cancelPromise).resolves.toBe(true);
  });
});

describe("RunOrchestrator ACP capabilities", () => {
  it("exposes the latest real ACP checkpoint for status queries", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-orchestrator-"));
    tmpDirs.push(dataDir);
    const orchestrator = new RunOrchestrator({ dataDir, config: defaultConfig() });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    (orchestrator as unknown as { client: unknown }).client = {
      run: async function* () {
        yield {
          type: "text_delta",
          text: "P3 正在接入",
          messageId: "checkpoint-1",
          phase: "commentary",
        } as const;
        yield {
          type: "text_delta",
          text: "板块成分股 Web 下钻",
          messageId: "checkpoint-1",
          phase: "commentary",
        } as const;
        await wait;
        yield { type: "done", exitCode: 0 } as const;
      },
    };

    const stream = orchestrator.runAgent("chat1", undefined, "continue");
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: "text_delta", phase: "commentary" },
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: "text_delta", phase: "commentary" },
    });

    expect(orchestrator.activeRunStatus("chat1")).toMatchObject({
      currentPhase: "任务检查点",
      lastCheckpoint: "P3 正在接入板块成分股 Web 下钻",
    });

    release();
    for await (const _event of stream) {
      // drain
    }
  });

  it("counts ACP tool events as real activity without inventing a checkpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T05:00:00.000Z"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-orchestrator-"));
    tmpDirs.push(dataDir);
    const orchestrator = new RunOrchestrator({ dataDir, config: defaultConfig() });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    (orchestrator as unknown as { client: unknown }).client = {
      run: async function* () {
        yield {
          type: "tool_start",
          toolCallId: "t1",
          name: "cargo test",
        } as const;
        yield {
          type: "tool_update",
          toolCallId: "t1",
          name: "cargo test",
          status: "in_progress",
        } as const;
        await wait;
        yield { type: "done", exitCode: 0 } as const;
      },
    };

    const stream = orchestrator.runAgent("chat1", undefined, "continue");
    vi.advanceTimersByTime(90_000);
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: "tool_start", name: "cargo test" },
    });
    vi.advanceTimersByTime(60_000);
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: "tool_update", name: "cargo test" },
    });

    expect(orchestrator.activeRunStatus("chat1")).toMatchObject({
      lastActivityAt: Date.parse("2026-08-09T05:02:30.000Z"),
      currentPhase: "工具执行：cargo test",
    });
    expect(orchestrator.activeRunStatus("chat1")?.lastCheckpoint).toBeUndefined();

    release();
    for await (const _event of stream) {
      // drain
    }
    vi.useRealTimers();
  });

  it("steers the active chat run", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-orchestrator-"));
    tmpDirs.push(dataDir);
    const orchestrator = new RunOrchestrator({ dataDir, config: defaultConfig() });
    (orchestrator as unknown as { client: { steer: typeof vi.fn } }).client = {
      steer: vi.fn().mockResolvedValue({ ok: true, outcome: "injected" }),
    };
    const activeRuns = (orchestrator as unknown as {
      activeChatRuns: Map<string, unknown>;
    }).activeChatRuns;
    activeRuns.set("chat1|", {
      runId: "r1",
      controller: new AbortController(),
      startedAt: Date.now(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, outcome: "injected" }), {
          status: 200,
        }),
      ),
    );
    const api = orchestrator as unknown as {
      steerActiveForChat?: (
        chatId: string,
        topicId: string | undefined,
        prompt: string,
      ) => Promise<{ ok: boolean; outcome?: string }>;
    };

    expect(typeof api.steerActiveForChat).toBe("function");
    expect(await api.steerActiveForChat!("chat1", undefined, "focus")).toEqual({
      ok: true,
      outcome: "injected",
      error: undefined,
    });
  });

  it("passes session additionalDirectories to Runner", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-orchestrator-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-workspace-"));
    tmpDirs.push(dataDir, cwd);
    const orchestrator = new RunOrchestrator({ dataDir, config: defaultConfig() });
    orchestrator.router.setBinding("chat1", {
      cwd,
      additionalDirectories: ["/tmp/shared"],
    } as never);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        ['data: {"type":"done","exitCode":0}', ""].join("\n"),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    for await (const _event of orchestrator.runAgent("chat1", undefined, "hi")) {
      // consume the stream
    }

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      additionalDirectories?: string[];
    };
    expect(body.additionalDirectories).toEqual(["/tmp/shared"]);
  });

  it("passes arbitrary ACP config overrides to Runner", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-orchestrator-"));
    tmpDirs.push(dataDir);
    const orchestrator = new RunOrchestrator({ dataDir, config: defaultConfig() });
    orchestrator.router.setBinding("chat1", {
      acpConfig: { telemetry: true },
    } as never);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(['data: {"type":"done","exitCode":0}', ""].join("\n"), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    for await (const _event of orchestrator.runAgent("chat1", undefined, "hi")) {
      // consume stream
    }

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      acpConfig?: Record<string, string | boolean>;
    };
    expect(body.acpConfig).toEqual({ telemetry: true });
  });

  it("refreshes config options on every request", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-orchestrator-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-workspace-"));
    tmpDirs.push(dataDir, cwd);
    const orchestrator = new RunOrchestrator({ dataDir, config: defaultConfig() });
    orchestrator.router.setBinding("chat1", { cwd });
    const response = {
      options: [
        {
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "new",
          values: [{ value: "new", name: "New" }],
        },
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(response)))
      .mockResolvedValueOnce(new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", fetchMock);

    await orchestrator.listConfigOptions("chat1");
    await orchestrator.listConfigOptions("chat1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("closes a session through the current backend/cwd", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-orchestrator-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-workspace-"));
    tmpDirs.push(dataDir, cwd);
    const orchestrator = new RunOrchestrator({ dataDir, config: defaultConfig() });
    orchestrator.router.setBinding("chat1", { backendId: "claude", cwd });
    const closeSession = vi.fn().mockResolvedValue({ ok: true });
    (orchestrator as unknown as { client: unknown }).client = { closeSession };

    await expect(orchestrator.closeSession("chat1", undefined, "s1")).resolves.toEqual({
      ok: true,
    });
    expect(closeSession).toHaveBeenCalledWith("claude", cwd, "s1");
  });

  it("forwards a session deletion failure from the runner", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-orchestrator-"));
    tmpDirs.push(dataDir);
    const orchestrator = new RunOrchestrator({ dataDir, config: defaultConfig() });
    (orchestrator as unknown as { client: unknown }).client = {
      deleteSession: vi.fn().mockResolvedValue({ ok: false, error: "unsupported" }),
    };

    await expect(orchestrator.deleteSession("chat1", undefined, "s1")).resolves.toEqual({
      ok: false,
      error: "unsupported",
    });
  });
});

describe("SessionRouter slot keying", () => {
  it("session key includes backend and cwd so bindings do not collide", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-sess-"));
    tmpDirs.push(dataDir);
    const router = new SessionRouter(dataDir);
    router.initFromConfig(defaultConfig());

    router.setBinding("chat1", { backendId: "cursor", cwd: "/a" });
    router.setBinding("chat2", { backendId: "claude", cwd: "/b" });

    const k1 = router.buildSessionKey("chat1");
    const k2 = router.buildSessionKey("chat2");
    expect(k1.backendId).toBe("cursor");
    expect(k2.backendId).toBe("claude");
    expect(k1.cwd).toBe("/a");
    expect(k2.cwd).toBe("/b");
  });
});
