import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "@codebridge/core";
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

  it("preserves additionalDirectories in resolved run options", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-router-"));
    tmpDirs.push(dataDir);
    const router = new SessionRouter(dataDir);
    const config = defaultConfig();
    router.initFromConfig(config);
    router.setBinding(
      "chat1",
      { additionalDirectories: ["/tmp/shared", "/tmp/docs"] } as never,
    );
    expect(
      (router.resolveRunOptions("chat1", undefined, config) as unknown as {
        additionalDirectories?: string[];
      }).additionalDirectories,
    ).toEqual(["/tmp/shared", "/tmp/docs"]);
  });

  it("preserves arbitrary ACP config overrides in resolved run options", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-router-"));
    tmpDirs.push(dataDir);
    const router = new SessionRouter(dataDir);
    const config = defaultConfig();
    router.initFromConfig(config);
    router.setBinding("chat1", {
      acpConfig: { telemetry: true, output_style: "concise" },
    } as never);

    expect(router.resolveRunOptions("chat1", undefined, config).acpConfig).toEqual({
      telemetry: true,
      output_style: "concise",
    });
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

  it("tracks slot generation per backend+cwd", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-router-"));
    tmpDirs.push(dataDir);
    const router = new SessionRouter(dataDir);
    router.initFromConfig(defaultConfig());
    router.setBinding("chat1", { backendId: "pi", cwd: "/tmp/project" });

    expect(router.getSlotGeneration("chat1")).toBe(0);
    expect(router.incrementSlotGeneration("chat1")).toBe(1);

    router.setBinding("chat1", { backendId: "cursor" });
    expect(router.getSlotGeneration("chat1")).toBe(0);

    router.setBinding("chat1", { backendId: "pi" });
    expect(router.getSlotGeneration("chat1")).toBe(1);
  });

  it("buildSlot canonicalizes the workspace key", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-router-"));
    tmpDirs.push(dataDir);
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-ws-"));
    tmpDirs.push(real);
    const router = new SessionRouter(dataDir);
    router.initFromConfig(defaultConfig());
    router.setBinding("chat1", { backendId: "pi", cwd: `${real}/` });

    const slot = router.buildSlot("chat1");
    expect(slot.agentId).toBe("pi");
    expect(slot.workspaceKey).toBe(fs.realpathSync(real));
    expect(slot.generation).toBe(0);
  });
});
