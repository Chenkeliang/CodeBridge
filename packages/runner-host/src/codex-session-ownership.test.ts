import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  filterForeignOwnerPids,
  inspectForeignCodexSessionOwners,
} from "./codex-session-ownership.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("filterForeignOwnerPids", () => {
  it("allows CodeBridge's own process group and rejects desktop/TUI owners", async () => {
    const groups = new Map([
      [101, 500],
      [102, 500],
      [201, 900],
    ]);

    await expect(
      filterForeignOwnerPids(
        [101, 102, 201],
        new Set([500]),
        async (pid) => groups.get(pid),
      ),
    ).resolves.toEqual([201]);
  });

  it("skips the macOS lsof probe on other platforms", async () => {
    let called = false;
    await expect(
      inspectForeignCodexSessionOwners("session-1", new Set(), {
        platform: "linux",
        execFile: async () => {
          called = true;
          return { stdout: "123" };
        },
      }),
    ).resolves.toEqual([]);
    expect(called).toBe(false);
  });

  it("degrades safely when lsof is unavailable", async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    tmpDirs.push(codexHome);
    const sessions = path.join(codexHome, "sessions", "2026", "08", "09");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, "rollout-2026-08-09-session-1.jsonl"),
      "{}\n",
    );
    const unavailable = Object.assign(new Error("spawn lsof ENOENT"), {
      code: "ENOENT",
    });

    await expect(
      inspectForeignCodexSessionOwners("session-1", new Set(), {
        codexHome,
        platform: "darwin",
        execFile: async () => Promise.reject(unavailable),
      }),
    ).resolves.toEqual([]);
  });
});
