import { describe, expect, it } from "vitest";
import { createBackend } from "./index.js";
import type { RunContext } from "@feishu-code-bridge/core";

describe("buildArgv model/effort", () => {
  const baseCtx = (partial: Partial<RunContext>): RunContext => ({
    runId: "r1",
    cwd: "/tmp/proj",
    prompt: "hi",
    backendConfig: partial.backendConfig ?? {
      type: "claude-code",
      command: "claude",
    },
    ...partial,
  });

  it("passes claude permission mode from profile", () => {
    const b = createBackend("claude", {
      type: "claude-code",
      command: "claude",
      claudePermissionMode: "acceptEdits",
    });
    const argv = b.buildArgv(baseCtx({}));
    expect(argv).toContain("--permission-mode");
    expect(argv).toContain("acceptEdits");
  });

  it("passes claude permission mode from run context override", () => {
    const b = createBackend("claude", {
      type: "claude-code",
      command: "claude",
      claudePermissionMode: "acceptEdits",
    });
    const argv = b.buildArgv(
      baseCtx({
        claudePermissionMode: "dontAsk",
        backendConfig: {
          type: "claude-code",
          command: "claude",
          claudePermissionMode: "acceptEdits",
        },
      }),
    );
    expect(argv).toContain("dontAsk");
  });

  it("passes claude model and effort", () => {
    const b = createBackend("claude", {
      type: "claude-code",
      command: "claude",
    });
    const argv = b.buildArgv(
      baseCtx({
        model: "haiku",
        effort: "low",
        backendConfig: { type: "claude-code", command: "claude" },
      }),
    );
    const joined = argv.join(" ");
    expect(joined).toContain("--model");
    expect(joined).toContain("haiku");
    expect(joined).toContain("--effort");
    expect(joined).toContain("low");
  });

  it("passes cursor-agent -m", () => {
    const b = createBackend("cursor", {
      type: "cursor-cli",
      command: "cursor-agent",
    });
    const argv = b.buildArgv(
      baseCtx({
        model: "composer-2.5",
        backendConfig: { type: "cursor-cli", command: "cursor-agent" },
      }),
    );
    expect(argv).toContain("--model");
    expect(argv).toContain("composer-2.5");
  });

  it("passes codex -m", () => {
    const b = createBackend("codex", {
      type: "codex",
      command: "codex",
    });
    const argv = b.buildArgv(
      baseCtx({
        model: "o3",
        backendConfig: { type: "codex", command: "codex" },
      }),
    );
    const joined = argv.join(" ");
    expect(joined).toContain("-m");
    expect(joined).toContain("o3");
  });
});
