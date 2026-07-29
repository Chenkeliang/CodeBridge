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

describe("SessionRouter resolveRunOptions", () => {
  it("merges binding override over profile default", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-router-"));
    tmpDirs.push(dataDir);
    const router = new SessionRouter(dataDir);
    const config = defaultConfig();
    router.initFromConfig(config);
    router.setBinding("chat1", { model: "opus", effort: "high" });
    const opts = router.resolveRunOptions("chat1", undefined, config);
    expect(opts.model).toBe("opus");
    expect(opts.effort).toBe("high");
  });

  it("falls back to profile when binding cleared", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-router-"));
    tmpDirs.push(dataDir);
    const router = new SessionRouter(dataDir);
    const config = defaultConfig();
    config.backends.codex!.model = "gpt-5.3-codex";
    router.initFromConfig(config);
    router.setBinding("chat1", { backendId: "codex", model: "o3" });
    router.clearModel("chat1");
    const opts = router.resolveRunOptions("chat1", undefined, config);
    expect(opts.model).toBe("gpt-5.3-codex");
  });

  it("merges claude permission mode from binding", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-router-"));
    tmpDirs.push(dataDir);
    const router = new SessionRouter(dataDir);
    const config = defaultConfig();
    router.initFromConfig(config);
    router.setBinding("chat1", { claudePermissionMode: "dontAsk" });
    const opts = router.resolveRunOptions("chat1", undefined, config);
    expect(opts.claudePermissionMode).toBe("dontAsk");
  });

  it("clearRunOverrides drops model so new backend profile applies", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-router-"));
    tmpDirs.push(dataDir);
    const router = new SessionRouter(dataDir);
    const config = defaultConfig();
    router.initFromConfig(config);
    router.setBinding("chat1", {
      backendId: "claude",
      model: "opus",
      effort: "high",
      mode: "default",
      claudePermissionMode: "dontAsk",
    });
    router.setBinding("chat1", { backendId: "cursor" });
    router.clearRunOverrides("chat1");
    const opts = router.resolveRunOptions("chat1", undefined, config);
    expect(opts.model).toBeUndefined();
    expect(opts.effort).toBeUndefined();
    expect(opts.mode).toBeUndefined();
    expect(opts.claudePermissionMode).toBeUndefined();
  });

  it("topic binding inherits chat-level binding instead of global defaults", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-router-"));
    tmpDirs.push(dataDir);
    const router = new SessionRouter(dataDir);
    const config = defaultConfig();
    router.initFromConfig(config);
    router.setBinding("chat1", { backendId: "claude", cwd: "/tmp/proj" });

    const topicBinding = router.getBinding("chat1", "om_root_1");
    expect(topicBinding.backendId).toBe("claude");
    expect(topicBinding.cwd).toBe("/tmp/proj");

    // 话题内显式覆盖只影响该话题，不回写会话级
    router.setBinding("chat1", { backendId: "codex" }, "om_root_1");
    expect(router.getBinding("chat1", "om_root_1").backendId).toBe("codex");
    expect(router.getBinding("chat1").backendId).toBe("claude");
  });

  it("bindSession stores the selected ACP session", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-router-"));
    tmpDirs.push(dataDir);
    const router = new SessionRouter(dataDir);
    const config = defaultConfig();
    router.initFromConfig(config);

    router.bindSession("chat1", "acp-session-123");

    const record = router.getSessionRecord(router.buildSessionKey("chat1"));
    expect(record?.sessionId).toBe("acp-session-123");
  });

  it("reads a legacy cliSessionId as the ACP session id", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-router-"));
    tmpDirs.push(dataDir);
    const router = new SessionRouter(dataDir);
    const config = defaultConfig();
    router.initFromConfig(config);
    const key = router.buildSessionKey("chat1");
    fs.writeFileSync(
      path.join(dataDir, "sessions.json"),
      JSON.stringify({
        [`${key.chatId}||${key.backendId}|${key.cwd}`]: {
          cliSessionId: "legacy-session-123",
          lastRunAt: "2026-07-01T00:00:00.000Z",
        },
      }),
    );

    expect(router.getSessionRecord(key)?.sessionId).toBe("legacy-session-123");
  });
});
