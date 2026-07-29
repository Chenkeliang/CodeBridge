import { describe, expect, it, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "@feishu-code-bridge/core";
import { SessionRouter } from "./session-router.js";
import { RunOrchestrator } from "./orchestrator.js";

const tmpDirs: string[] = [];

afterEach(() => {
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

    for await (const _event of orchestrator.runAgent("chat1", undefined, "hi")) {
      // consume the complete event stream
    }

    const key = orchestrator.router.buildSessionKey("chat1");
    expect(orchestrator.router.getSessionRecord(key)).toBeUndefined();
  });
});

describe("RunOrchestrator ACP capabilities", () => {
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
});

describe("SessionRouter multi-session", () => {
  it("keeps separate cli sessions per chat and backend", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-sess-"));
    tmpDirs.push(dataDir);
    const router = new SessionRouter(dataDir);
    const config = defaultConfig();
    router.initFromConfig(config);

    router.setBinding("chat1", { backendId: "cursor", cwd: "/proj/a" });
    router.setBinding("chat2", { backendId: "claude", cwd: "/proj/b" });
    router.bindSession("chat1", "cursor-session-111");
    router.bindSession("chat2", "claude-session-222");

    const rec1 = router.getSessionRecord(router.buildSessionKey("chat1"));
    const rec2 = router.getSessionRecord(router.buildSessionKey("chat2"));

    expect(rec1?.sessionId).toBe("cursor-session-111");
    expect(rec2?.sessionId).toBe("claude-session-222");
  });

  it("isolates sessions when same chat switches backend", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-sess-"));
    tmpDirs.push(dataDir);
    const router = new SessionRouter(dataDir);
    router.initFromConfig(defaultConfig());

    router.setBinding("chat1", { backendId: "cursor" });
    router.bindSession("chat1", "cursor-sess");
    router.setBinding("chat1", { backendId: "claude" });
    router.bindSession("chat1", "claude-sess");

    const cursorKey = {
      chatId: "chat1",
      backendId: "cursor",
      cwd: router.getBinding("chat1").cwd,
    };
    const claudeKey = router.buildSessionKey("chat1");

    expect(router.getSessionRecord(cursorKey)?.sessionId).toBe("cursor-sess");
    expect(router.getSessionRecord(claudeKey)?.sessionId).toBe("claude-sess");
  });

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
