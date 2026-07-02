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
    config.backends.codex!.model = "gpt-5.1-codex";
    router.initFromConfig(config);
    router.setBinding("chat1", { backendId: "codex", model: "o3" });
    router.clearModel("chat1");
    const opts = router.resolveRunOptions("chat1", undefined, config);
    expect(opts.model).toBe("gpt-5.1-codex");
  });
});
