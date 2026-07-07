import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "@feishu-code-bridge/core";
import type { CliSessionSummary } from "@feishu-code-bridge/runner-client";
import { handleSlashCommand, type SlashContext } from "./slash-commands.js";
import { SessionRouter } from "./session-router.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeSession(id: string, cwd: string, preview: string): CliSessionSummary {
  return { id, backend: "cursor", cwd, preview, updatedAt: "2026-07-07T00:00:00Z" };
}

let chatCounter = 0;

function makeCtx(overrides: {
  scopedSessions: CliSessionSummary[];
  allSessions: CliSessionSummary[];
  bound?: string[];
}): SlashContext {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-slash-"));
  tmpDirs.push(dataDir);
  const router = new SessionRouter(dataDir);
  const config = defaultConfig();
  router.initFromConfig(config);
  const bound = overrides.bound ?? [];
  // resumeListCache 按 chatId 缓存，每个用例用独立 chatId 避免互相污染
  chatCounter += 1;
  return {
    chatId: `chat-${chatCounter}`,
    senderId: "user1",
    text: "",
    config,
    router,
    listCliSessions: async (options) =>
      options?.all ? overrides.allSessions : overrides.scopedSessions,
    bindCliSession: (sessionId) => bound.push(sessionId),
  };
}

describe("/resume <N> after /resume all", () => {
  it("picks from the previously displayed 'all' list, not a fresh scoped query", async () => {
    const scoped = [makeSession("scoped-1", "/Users/demo/Projects", "scoped only")];
    const all = [
      makeSession("go-1", "/Users/demo/go", "Meepo Branch Check"),
      makeSession("proj-1", "/Users/demo/Projects", "Topic Content Info"),
      makeSession("proj-2", "/Users/demo/Projects", "Test Conversation"),
    ];
    const bound: string[] = [];
    const ctx = makeCtx({ scopedSessions: scoped, allSessions: all, bound });

    const listing = await handleSlashCommand({ ...ctx, text: "/resume all" });
    expect(listing?.type).toBe("reply");
    expect((listing as { text: string }).text).toContain("proj-2");

    const picked = await handleSlashCommand({ ...ctx, text: "/resume 3" });
    expect((picked as { text: string }).text).toContain("proj-2");
    expect(bound).toEqual(["proj-2"]);
  });

  it("without a prior list, falls back to the scoped query", async () => {
    const scoped = [
      makeSession("scoped-1", "/Users/demo/Projects", "first"),
      makeSession("scoped-2", "/Users/demo/Projects", "second"),
    ];
    const bound: string[] = [];
    const ctx = makeCtx({ scopedSessions: scoped, allSessions: [], bound });

    const picked = await handleSlashCommand({ ...ctx, text: "/resume 2" });
    expect((picked as { text: string }).text).toContain("second");
    expect(bound).toEqual(["scoped-2"]);
  });

  it("plain /resume caches the scoped list for a later /resume <N>", async () => {
    const scoped = [
      makeSession("scoped-1", "/Users/demo/Projects", "first"),
      makeSession("scoped-2", "/Users/demo/Projects", "second"),
    ];
    const bound: string[] = [];
    const ctx = makeCtx({ scopedSessions: scoped, allSessions: [], bound });

    await handleSlashCommand({ ...ctx, text: "/resume" });
    const picked = await handleSlashCommand({ ...ctx, text: "/resume 1" });
    expect((picked as { text: string }).text).toContain("first");
    expect(bound).toEqual(["scoped-1"]);
  });

  it("invalid index reports against the cached list's length", async () => {
    const all = [makeSession("go-1", "/Users/demo/go", "only one")];
    const ctx = makeCtx({ scopedSessions: [], allSessions: all });

    await handleSlashCommand({ ...ctx, text: "/resume all" });
    const picked = await handleSlashCommand({ ...ctx, text: "/resume 5" });
    expect((picked as { text: string }).text).toContain("共 1 条");
  });
});
