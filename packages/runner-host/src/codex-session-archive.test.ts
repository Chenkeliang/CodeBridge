import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { restoreArchivedCodexSession } from "./codex-session-archive.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-archive-test-"));
  vi.stubEnv("CODEX_HOME", home);
  vi.stubEnv("CODEX_PATH", "/test/codex");
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    (args.at(-1) as (error: Error | null, stdout?: string) => void)(null, "restored");
    return {} as ReturnType<typeof execFile>;
  });
});
afterEach(async () => {
  vi.unstubAllEnvs(); vi.clearAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

describe("Codex archive restoration", () => {
  it("leaves active or missing sessions alone", async () => {
    await restoreArchivedCodexSession("original", home);
    await fs.mkdir(path.join(home, "archived_sessions"));
    await fs.writeFile(path.join(home, "archived_sessions", "rollout-other.jsonl"), "");
    await restoreArchivedCodexSession("original", home);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("uses the configured Codex CLI and home to restore only the original ID", async () => {
    await fs.mkdir(path.join(home, "archived_sessions"));
    await fs.writeFile(path.join(home, "archived_sessions", "rollout-2026-10-13-original.jsonl"), "");
    await restoreArchivedCodexSession("original", home);
    expect(execFile).toHaveBeenCalledWith("/test/codex", ["--no-daemon", "unarchive", "original"],
      expect.objectContaining({ cwd: home, timeout: 15_000,
        env: expect.objectContaining({ CODEX_HOME: home }) }), expect.any(Function));
  });

  it("does not treat an unreadable archive as an active session", async () => {
    await fs.writeFile(path.join(home, "archived_sessions"), "not a directory");
    await expect(restoreArchivedCodexSession("original", home)).rejects.toThrow();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("propagates CLI failure", async () => {
    await fs.mkdir(path.join(home, "archived_sessions"));
    await fs.writeFile(path.join(home, "archived_sessions", "rollout-original.jsonl"), "");
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error) => void)(new Error("CLI failed"));
      return {} as ReturnType<typeof execFile>;
    });
    await expect(restoreArchivedCodexSession("original", home)).rejects.toThrow("CLI failed");
  });
});
