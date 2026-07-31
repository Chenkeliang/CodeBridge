import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, type AgentEvent, type RunRequest } from "@feishu-code-bridge/core";
import { RunnerHost } from "./server.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
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
