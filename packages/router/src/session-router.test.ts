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
      claudePermissionMode: "dontAsk",
      transport: "cli",
    });
    router.setBinding("chat1", { backendId: "cursor" });
    router.clearRunOverrides("chat1");
    const opts = router.resolveRunOptions("chat1", undefined, config);
    expect(opts.model).toBe("composer-2.5");
    expect(opts.effort).toBeUndefined();
    expect(opts.claudePermissionMode).toBeUndefined();
    expect(opts.transport).toBe("acp");
  });

  it("merges transport from binding over profile default", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-router-"));
    tmpDirs.push(dataDir);
    const router = new SessionRouter(dataDir);
    const config = defaultConfig();
    config.backends.cursor!.transport = "acp";
    router.initFromConfig(config);
    router.setBinding("chat1", { transport: "cli" });
    const opts = router.resolveRunOptions("chat1", undefined, config);
    expect(opts.transport).toBe("cli");
  });

  it("clearTransport restores profile transport default", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-router-"));
    tmpDirs.push(dataDir);
    const router = new SessionRouter(dataDir);
    const config = defaultConfig();
    config.backends.cursor!.transport = "cli";
    router.initFromConfig(config);
    router.setBinding("chat1", { transport: "acp" });
    router.clearTransport("chat1");
    const opts = router.resolveRunOptions("chat1", undefined, config);
    expect(opts.transport).toBe("cli");
  });
});
