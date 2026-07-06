import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "@feishu-code-bridge/core";
import { SessionRouter } from "./session-router.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    router.bindCliSession("chat1", "cursor-session-111");
    router.bindCliSession("chat2", "claude-session-222");

    const rec1 = router.getSessionRecord(router.buildSessionKey("chat1"));
    const rec2 = router.getSessionRecord(router.buildSessionKey("chat2"));

    expect(rec1?.cliSessionId).toBe("cursor-session-111");
    expect(rec2?.cliSessionId).toBe("claude-session-222");
  });

  it("isolates sessions when same chat switches backend", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-sess-"));
    tmpDirs.push(dataDir);
    const router = new SessionRouter(dataDir);
    router.initFromConfig(defaultConfig());

    router.setBinding("chat1", { backendId: "cursor" });
    router.bindCliSession("chat1", "cursor-sess");
    router.setBinding("chat1", { backendId: "claude" });
    router.bindCliSession("chat1", "claude-sess");

    const cursorKey = {
      chatId: "chat1",
      backendId: "cursor",
      cwd: router.getBinding("chat1").cwd,
    };
    const claudeKey = router.buildSessionKey("chat1");

    expect(router.getSessionRecord(cursorKey)?.cliSessionId).toBe("cursor-sess");
    expect(router.getSessionRecord(claudeKey)?.cliSessionId).toBe("claude-sess");
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
