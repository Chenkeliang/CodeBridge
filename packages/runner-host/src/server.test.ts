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
import { createRunnerApp, RunnerHost } from "./server.js";
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

function setupAgentSetupService(overrides: Partial<{
  list: () => Promise<unknown>;
  detect: (agentId: string) => Promise<unknown>;
  install: (agentId: string, strategyId: string) => Promise<unknown>;
}> = {}) {
  return {
    list: overrides.list ?? vi.fn().mockResolvedValue([
      {
        agentId: "opencode",
        installation: "installed",
        configuration: "configured",
        runtime: "healthy",
        canSelectDefault: true,
        canCreateSession: true,
      },
    ]),
    detect: overrides.detect ?? vi.fn().mockResolvedValue({
      agentId: "opencode",
      installation: "installed",
      configuration: "configured",
      runtime: "healthy",
      canSelectDefault: true,
      canCreateSession: true,
    }),
    install: overrides.install ?? vi.fn().mockResolvedValue({
      agentId: "opencode",
      ok: true,
      installation: "installed",
      configuration: "configured",
      runtime: "healthy",
      canSelectDefault: true,
      canCreateSession: true,
    }),
  };
}

describe("RunnerHost Agent setup", () => {
  it("lists setup states and relays detect/install results", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-setup-"));
    tmpDirs.push(dataDir);
    const service = setupAgentSetupService();
    const host = new RunnerHost({
      token: "token",
      config: defaultConfig(),
      dataDir,
      agentSetupService: service as never,
    });
    const app = createRunnerApp(host, "token");

    const list = await app.request("/agents/setup", {
      headers: { authorization: "Bearer token" },
    });
    expect(await list.json()).toMatchObject({
      agents: [
        expect.objectContaining({
          agentId: "opencode",
          canSelectDefault: true,
        }),
      ],
    });

    const detect = await app.request("/agents/opencode/detect", {
      method: "POST",
      headers: { authorization: "Bearer token" },
    });
    expect(await detect.json()).toMatchObject({
      agentId: "opencode",
      installation: "installed",
    });

    const install = await app.request("/agents/opencode/install", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ strategy_id: "npm-global", command: "rm -rf /" }),
    });
    expect(await install.json()).toMatchObject({
      agentId: "opencode",
      ok: true,
    });
    expect((service.install as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("opencode", "npm-global");
    host.shutdown();
  });

  it("returns structured setup errors for missing agents and strategies", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-setup-"));
    tmpDirs.push(dataDir);
    const service = setupAgentSetupService({
      detect: async () => {
        throw new Error("Unknown agent: missing");
      },
      install: async () => {
        throw new Error("Unknown install strategy: opencode/missing");
      },
    });
    const host = new RunnerHost({
      token: "token",
      config: defaultConfig(),
      dataDir,
      agentSetupService: service as never,
    });
    const app = createRunnerApp(host, "token");

    const detect = await app.request("/agents/missing/detect", {
      method: "POST",
      headers: { authorization: "Bearer token" },
    });
    expect(detect.status).toBe(404);
    expect(await detect.json()).toMatchObject({ error: "agent_not_found" });

    const missingStrategy = await app.request("/agents/opencode/install", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missingStrategy.status).toBe(400);
    expect(await missingStrategy.json()).toMatchObject({
      error: "install_strategy_not_found",
    });
    host.shutdown();
  });
});

describe("RunnerHost cwd validation", () => {
  it("returns Codex ACP built-in commands without opening the provider Session", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-codex-commands-"));
    tmpDirs.push(dataDir, cwd);
    const config = defaultConfig();
    config.backends.codex = { type: "codex" };
    const host = new RunnerHost({
      token: "token",
      config,
      dataDir,
      codexSkillLister: async () => [
        { name: "$dcp", description: "Operate DCP workflows" },
      ],
    });

    await expect(host.listCommands("codex", cwd)).resolves.toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({ name: "plan", description: "Turn plan mode on." }),
        expect.objectContaining({ name: "mcp", description: "List configured Model Context Protocol (MCP) tools." }),
        expect.objectContaining({ name: "skills", description: "List available skills." }),
        expect.objectContaining({ name: "status", description: "Display session configuration and token usage." }),
        expect.objectContaining({ name: "review", description: "Review uncommitted changes, or review with custom instructions." }),
        expect.objectContaining({ name: "$dcp", description: "Operate DCP workflows" }),
      ]),
    });
    host.shutdown();
  });

  it("lists immediate workspace entries without traversing outside the authorized root", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-list-"));
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(path.join(cwd, "README.md"), "readme");
    tmpDirs.push(dataDir, cwd);
    const host = new RunnerHost({ token: "token", config: defaultConfig(), dataDir });
    const listDirectory = (host as unknown as {
      listDirectory?: (root: string, relativePath?: string) => Promise<unknown>;
    }).listDirectory;

    expect(listDirectory).toBeTypeOf("function");
    if (!listDirectory) return;
    await expect(listDirectory.call(host, cwd)).resolves.toMatchObject({
      ok: true,
      root: fs.realpathSync(cwd),
      entries: [
        { name: "src", path: "src", absolutePath: path.join(fs.realpathSync(cwd), "src"), kind: "directory" },
        { name: "README.md", path: "README.md", absolutePath: path.join(fs.realpathSync(cwd), "README.md"), kind: "file" },
      ],
    });
    await expect(listDirectory.call(host, cwd, "../")).resolves.toMatchObject({ ok: false });
    host.shutdown();
  });

  it("exposes provider session history for imported Workbench sessions", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-history-"));
    tmpDirs.push(dataDir, cwd);
    const host = new RunnerHost({ token: "token", config: defaultConfig(), dataDir });
    vi.spyOn(host, "loadSessionHistory").mockResolvedValue([
      { kind: "message", text: "历史问题" },
    ]);
    const app = createRunnerApp(host, "token");

    const response = await app.request(
      `/sessions/provider-1/history?backend=claude&cwd=${encodeURIComponent(cwd)}`,
      { headers: { authorization: "Bearer token" } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [{ kind: "message", text: "历史问题" }] });
    host.shutdown();
  });

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
  it("acknowledges cancellation only after the active run releases its session", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-cancel-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-workspace-cancel-"));
    tmpDirs.push(dataDir, cwd);
    const config = defaultConfig();
    config.backends.pi = { type: "pi-sdk" };
    let releaseAbort!: () => void;
    const abortReleased = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    let markPromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    let finishPrompt!: () => void;
    const promptFinished = new Promise<void>((resolve) => {
      finishPrompt = resolve;
    });
    let sessionCount = 0;
    const host = new RunnerHost({
      token: "token",
      config,
      dataDir,
      piSessionFactory: async () => {
        sessionCount += 1;
        if (sessionCount > 1) {
          return {
            sessionId: "pi-second",
            subscribe: () => () => {},
            async prompt() {},
            async steer() {},
            async abort() {},
            dispose() {},
          };
        }
        return {
          sessionId: "pi-first",
          subscribe: () => () => {},
          async prompt() {
            markPromptStarted();
            await promptFinished;
          },
          async steer() {},
          async abort() {
            await abortReleased;
            finishPrompt();
          },
          dispose() {},
        };
      },
    });
    const first = collect(host.executeRun({
      runId: "r1",
      sessionKey: { chatId: "chat", backendId: "pi", cwd },
      resumeSessionId: "shared-session",
      prompt: "wait",
    }));
    await promptStarted;

    let cancellationSettled = false;
    const cancellation = (async () => {
      const response = await createRunnerApp(host, "token").request("/runs/r1/cancel", {
        method: "POST",
        headers: { authorization: "Bearer token" },
      });
      cancellationSettled = true;
      return response;
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancellationSettled).toBe(false);

    releaseAbort();
    const response = await cancellation;
    expect(await response.json()).toEqual({ ok: true });
    await first;

    const second = await collect(host.executeRun({
      runId: "r2",
      sessionKey: { chatId: "chat", backendId: "pi", cwd },
      resumeSessionId: "shared-session",
      prompt: "continue",
    }));
    expect(second).not.toContainEqual(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("已被另一个 Runner 任务占用"),
    }));
    expect(second.at(-1)).toEqual({ type: "done", exitCode: 0 });
    host.shutdown();
  });

  it("does not start a run whose cancellation arrived first", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-runner-early-cancel-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-workspace-early-cancel-"));
    tmpDirs.push(dataDir, cwd);
    const config = defaultConfig();
    config.backends.pi = { type: "pi-sdk" };
    const prompt = vi.fn(async () => {});
    const host = new RunnerHost({
      token: "token",
      config,
      dataDir,
      piSessionFactory: async () => ({
        sessionId: "pi-early",
        subscribe: () => () => {},
        prompt,
        async steer() {},
        async abort() {},
        dispose() {},
      }),
    });
    const app = createRunnerApp(host, "token");

    const response = await app.request("/runs/early/cancel", {
      method: "POST",
      headers: { authorization: "Bearer token" },
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(await collect(host.executeRun({
      runId: "early",
      sessionKey: { chatId: "chat", backendId: "pi", cwd },
      prompt: "must not run",
    }))).toEqual([]);
    expect(prompt).not.toHaveBeenCalled();
    host.shutdown();
  });

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
