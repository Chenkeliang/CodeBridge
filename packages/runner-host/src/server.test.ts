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
