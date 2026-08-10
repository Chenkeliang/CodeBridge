import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultConfig,
  type AgentEvent,
  type RunContext,
  type RunRequest,
} from "@codebridge/core";
import { RunnerHost } from "./server.js";
import type { PiSession } from "@codebridge/backends";

const tmpDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 20,
    });
  }
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function request(cwd: string): RunRequest {
  return {
    runId: "bad-cwd",
    sessionKey: { chatId: "chat", backendId: "cursor", cwd },
    prompt: "hi",
  };
}

describe("RunnerHost cwd validation", () => {
  it("picks and authorizes a directory through an injectable host picker", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-pick-"));
    tmpDirs.push(dataDir, target);
    const host = new RunnerHost({
      token: "token",
      config: defaultConfig(),
      dataDir,
      directoryPicker: async () => target,
    });

    await expect(host.pickDirectory()).resolves.toEqual({
      ok: true,
      path: fs.realpathSync(target),
    });
    host.shutdown();
  });

  it("reports an explicit cancellation from the host picker", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    tmpDirs.push(dataDir);
    const host = new RunnerHost({
      token: "token",
      config: defaultConfig(),
      dataDir,
      directoryPicker: async () => null,
    });

    await expect(host.pickDirectory()).resolves.toEqual({ ok: true, cancelled: true });
    host.shutdown();
  });

  it("returns an explicit error for a relative cwd before spawning", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    tmpDirs.push(dataDir);
    const host = new RunnerHost({ token: "token", config: defaultConfig(), dataDir });

    const events = await collect(host.executeRun(request("mypy")));

    expect(events).toContainEqual({
      type: "error",
      message: expect.stringContaining("绝对路径"),
      fatal: true,
    });
    expect(events.at(-1)).toEqual({ type: "done", exitCode: 1 });
    host.shutdown();
  });

  it("returns an explicit error for a missing cwd before spawning", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    tmpDirs.push(dataDir);
    const host = new RunnerHost({ token: "token", config: defaultConfig(), dataDir });
    const missing = path.join(dataDir, "missing");

    const events = await collect(host.executeRun(request(missing)));

    expect(events).toContainEqual({
      type: "error",
      message: expect.stringContaining("不存在"),
      fatal: true,
    });
    expect(events.at(-1)).toEqual({ type: "done", exitCode: 1 });
    host.shutdown();
  });

  it("validates every additional directory before spawning", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-workspace-"));
    tmpDirs.push(dataDir, cwd);
    const config = defaultConfig();
    config.backends.cursor = {
      ...config.backends.cursor!,
      acpCommand: "fcb-missing-acp-adapter-for-test",
      acpArgs: [],
    };
    const host = new RunnerHost({ token: "token", config, dataDir });
    const run = request(cwd);
    run.additionalDirectories = ["relative/shared"];

    const events = await collect(host.executeRun(run));

    expect(events).toContainEqual({
      type: "error",
      message: expect.stringContaining("附加目录必须使用绝对路径"),
      fatal: true,
    });
    expect(events.at(-1)).toEqual({ type: "done", exitCode: 1 });
    host.shutdown();
  });

  it("returns an explicit error instead of an empty list for a bad session-list cwd", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    tmpDirs.push(dataDir);
    const host = new RunnerHost({ token: "token", config: defaultConfig(), dataDir });

    const result = await host.listSessions("cursor", "mypy", {
      all: true,
    });

    expect(result.sessions).toEqual([]);
    expect(result.error).toContain("绝对路径");
    host.shutdown();
  });

  it("returns an explicit error when the ACP adapter cannot list sessions", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    tmpDirs.push(dataDir);
    const config = defaultConfig();
    config.backends.cursor = {
      ...config.backends.cursor!,
      acpCommand: "fcb-missing-acp-adapter-for-test",
      acpArgs: [],
    };
    const host = new RunnerHost({ token: "token", config, dataDir });

    const result = await host.listSessions("cursor", dataDir);

    expect(result.sessions).toEqual([]);
    expect(result.error).toContain("ACP session/list failed");
    host.shutdown();
  });

  it("opens an absolute directory to verify macOS access", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-authorize-"));
    tmpDirs.push(dataDir, target);
    const host = new RunnerHost({ token: "token", config: defaultConfig(), dataDir });

    await expect(host.authorizeDirectory(target)).resolves.toEqual({
      ok: true,
      path: fs.realpathSync(target),
    });
    await expect(host.authorizeDirectory("relative/path")).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("绝对路径"),
    });
    host.shutdown();
  });

  it("uses asynchronous directory access so a TCC prompt does not block Runner", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-authorize-"));
    tmpDirs.push(dataDir, target);
    const host = new RunnerHost({ token: "token", config: defaultConfig(), dataDir });
    const open = vi.spyOn(fs.promises, "opendir");

    await host.authorizeDirectory(target);

    expect(open).toHaveBeenCalledWith(path.resolve(target));
    host.shutdown();
  });

  it("keeps the candidate path when macOS denies directory access", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    tmpDirs.push(dataDir);
    const host = new RunnerHost({ token: "token", config: defaultConfig(), dataDir });
    const denied = Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
    });
    vi.spyOn(fs.promises, "opendir").mockRejectedValueOnce(denied);

    await expect(host.authorizeDirectory("/Users/tester/Desktop")).resolves.toEqual({
      ok: false,
      path: "/Users/tester/Desktop",
      error: expect.stringContaining("尚未获得目录访问权限"),
    });
    host.shutdown();
  });
});

describe("RunnerHost steering", () => {
  it("forwards steering to the active ACP run", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    tmpDirs.push(dataDir);
    const host = new RunnerHost({ token: "token", config: defaultConfig(), dataDir });
    const active = (host as unknown as {
      active: Map<string, unknown>;
    }).active;
    active.set("r1", {
      runId: "r1",
      aborted: false,
      cancel: () => {},
      steer: async (prompt: string) => ({ outcome: `injected:${prompt}` }),
    });
    const api = host as unknown as {
      steer?: (
        runId: string,
        prompt: string,
      ) => Promise<{ ok: boolean; outcome?: string; error?: string }>;
    };

    expect(typeof api.steer).toBe("function");
    expect(await api.steer!("r1", "focus")).toEqual({
      ok: true,
      outcome: "injected:focus",
    });
    host.shutdown();
  });
});

describe("RunnerHost session lifecycle", () => {
  it("stops an ACP run and reports a fatal error when its session lock is lost", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    tmpDirs.push(dataDir);
    const config = defaultConfig();
    config.backends.cursor = {
      ...config.backends.cursor!,
      acpCommand: "fcb-missing-acp-adapter-for-test",
      acpArgs: [],
    };
    const host = new RunnerHost({ token: "token", config, dataDir });
    const executeAcpRun = (
      host as unknown as {
        executeAcpRun(
          runId: string,
          ctx: RunContext,
          sessionLockLost: Promise<Error>,
        ): AsyncGenerator<AgentEvent>;
      }
    ).executeAcpRun.bind(host);
    const ctx: RunContext = {
      runId: "lock-lost",
      cwd: dataDir,
      prompt: "hi",
      resumeSessionId: "session-1",
      backendConfig: config.backends.cursor!,
    };

    const events = await collect(
      executeAcpRun(
        "lock-lost",
        ctx,
        Promise.resolve(new Error("holder exited")),
      ),
    );

    expect(events).toContainEqual({
      type: "error",
      message: expect.stringContaining("session 锁异常丢失"),
      fatal: true,
    });
    expect(events.at(-1)).toEqual({ type: "done", exitCode: 1 });
    host.shutdown();
  });

  it("refuses to resume a session already running in this Runner", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    tmpDirs.push(dataDir);
    const host = new RunnerHost({ token: "token", config: defaultConfig(), dataDir });
    const active = (host as unknown as {
      active: Map<string, unknown>;
    }).active;
    active.set("existing", {
      runId: "existing",
      sessionId: "shared-session",
      aborted: false,
      cancel: () => {},
    });
    const run = request(dataDir);
    run.runId = "second";
    run.resumeSessionId = "shared-session";

    const events = await collect(host.executeRun(run));

    expect(events).toContainEqual({
      type: "error",
      message: expect.stringContaining("正在运行"),
      fatal: true,
    });
    expect(events.at(-1)).toEqual({ type: "done", exitCode: 1 });
    host.shutdown();
  });

  it("refuses to resume a Codex session owned by desktop or TUI", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    tmpDirs.push(dataDir);
    const host = new RunnerHost({
      token: "token",
      config: defaultConfig(),
      dataDir,
      inspectSessionOwners: async () => [37540],
    });
    const run = request(dataDir);
    run.runId = "second";
    run.sessionKey.backendId = "codex";
    run.resumeSessionId = "shared-session";

    const events = await collect(host.executeRun(run));

    expect(events).toContainEqual({
      type: "error",
      message: expect.stringContaining("桌面端/TUI"),
      fatal: true,
    });
    expect(events.at(-1)).toEqual({ type: "done", exitCode: 1 });
    host.shutdown();
  });

  it("returns an explicit error for an unknown backend", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    tmpDirs.push(dataDir);
    const host = new RunnerHost({ token: "token", config: defaultConfig(), dataDir });

    await expect(host.closeSession("missing", dataDir, "s1")).resolves.toEqual({
      ok: false,
      error: "Unknown backend: missing",
    });
    host.shutdown();
  });

  it("validates cwd before trying to delete a session", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    tmpDirs.push(dataDir);
    const host = new RunnerHost({ token: "token", config: defaultConfig(), dataDir });

    const result = await host.deleteSession("cursor", "relative", "s1");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("绝对路径");
    host.shutdown();
  });

  it("refuses to close or delete a session while that session is running", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    tmpDirs.push(dataDir);
    const config = defaultConfig();
    config.backends.cursor = {
      ...config.backends.cursor!,
      acpCommand: "fcb-missing-acp-adapter-for-test",
      acpArgs: [],
    };
    const host = new RunnerHost({ token: "token", config, dataDir });
    const active = (host as unknown as {
      active: Map<string, unknown>;
    }).active;
    active.set("r1", {
      runId: "r1",
      sessionId: "s1",
      aborted: false,
      cancel: () => {},
    });
    expect(host.cancel("r1")).toBe(true);

    await expect(host.deleteSession("cursor", dataDir, "s1")).resolves.toEqual({
      ok: false,
      error: "ACP session s1 正在运行，请先 /stop 后重试",
    });
    host.shutdown();
  });

  it("does not claim to close a historical session without an owned ACP connection", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    tmpDirs.push(dataDir);
    const host = new RunnerHost({ token: "token", config: defaultConfig(), dataDir });

    await expect(host.closeSession("cursor", dataDir, "s1")).resolves.toEqual({
      ok: false,
      error: "Runner 当前未持有该 ACP session；历史 session 请使用 /session delete",
    });
    host.shutdown();
  });
});

describe("RunnerHost Pi SDK backend", () => {
  it("forks a Pi provider session into a target directory", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-pi-fork-"));
    const sourceCwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-workspace-pi-source-"));
    const targetCwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-workspace-pi-target-"));
    tmpDirs.push(dataDir, sourceCwd, targetCwd);
    const config = defaultConfig();
    config.backends.pi = { type: "pi-sdk" };
    const host = new RunnerHost({
      token: "token",
      config,
      dataDir,
      piSessionForker: async (_cwd, _sessionId, target) => ({
        ok: true,
        sessionId: "pi-forked",
        cwd: target,
      }),
    });

    await expect(host.forkSession("pi", sourceCwd, "pi-source", targetCwd)).resolves.toMatchObject({
      ok: true,
      cwd: fs.realpathSync(targetCwd),
    });
    host.shutdown();
  });

  it("lists Pi sessions without spawning an ACP process", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-pi-list-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-workspace-pi-list-"));
    tmpDirs.push(dataDir, cwd);
    const config = defaultConfig();
    config.backends.pi = { type: "pi-sdk" };
    const host = new RunnerHost({ token: "token", config, dataDir });

    await expect(host.listSessions("pi", cwd)).resolves.toEqual({ sessions: [] });
    host.shutdown();
  });

  it("runs a configured pi-sdk profile through the native session adapter", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-pi-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-workspace-pi-"));
    tmpDirs.push(dataDir, cwd);
    const config = defaultConfig();
    config.backends.pi = { type: "pi-sdk" };
    const session: PiSession = {
      sessionId: "pi-native-session",
      subscribe(listener) {
        listener({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "native-pi" },
        });
        return () => {};
      },
      async prompt() {},
      async steer() {},
      async abort() {},
      dispose() {},
    };
    const host = new RunnerHost({
      token: "token",
      config,
      dataDir,
      piSessionFactory: async () => session,
    });

    const events = await collect(
      host.executeRun({
        runId: "pi-run",
        sessionKey: { chatId: "chat", backendId: "pi", cwd },
        prompt: "hello pi",
      }),
    );

    expect(events).toContainEqual({
      type: "session",
      sessionId: "pi-native-session",
    });
    expect(events).toContainEqual({
      type: "text_delta",
      text: "native-pi",
    });
    expect(events.at(-1)).toEqual({ type: "done", exitCode: 0 });
    host.shutdown();
  });
});
