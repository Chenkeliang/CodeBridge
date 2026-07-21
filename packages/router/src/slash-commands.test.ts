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

describe("/thinking", () => {
  const baseCtx = () => makeCtx({ scopedSessions: [], allSessions: [] });

  it("defaults to on, /thinking off then on flips the binding", async () => {
    const ctx = baseCtx();
    // 缺省：状态行须含 on 专属短语（不能只查 "on"——用法行本身含 on|off，会空断言）
    const status0 = await handleSlashCommand({ ...ctx, text: "/thinking" });
    expect((status0 as { text: string }).text).toContain("显示思考与工具调用过程");
    expect(ctx.router.getBinding(ctx.chatId).showThinking ?? true).toBe(true);

    const off = await handleSlashCommand({ ...ctx, text: "/thinking off" });
    expect((off as { text: string }).text).toContain("只显示最终答案");
    expect(ctx.router.getBinding(ctx.chatId).showThinking).toBe(false);

    const status1 = await handleSlashCommand({ ...ctx, text: "/thinking" });
    expect((status1 as { text: string }).text).toContain("卡片只显示最终答案");

    const on = await handleSlashCommand({ ...ctx, text: "/thinking on" });
    expect((on as { text: string }).text).toContain("显示思考");
    expect(ctx.router.getBinding(ctx.chatId).showThinking).toBe(true);
  });

  it("accepts 关/开 synonyms and rejects garbage without touching the binding", async () => {
    const ctx = baseCtx();
    await handleSlashCommand({ ...ctx, text: "/thinking 关" });
    expect(ctx.router.getBinding(ctx.chatId).showThinking).toBe(false);

    const bad = await handleSlashCommand({ ...ctx, text: "/thinking maybe" });
    expect((bad as { text: string }).text).toContain("无效参数");
    expect(ctx.router.getBinding(ctx.chatId).showThinking).toBe(false); // 未被改动

    await handleSlashCommand({ ...ctx, text: "/think 开" }); // /think 别名
    expect(ctx.router.getBinding(ctx.chatId).showThinking).toBe(true);
  });

  it("survives a backend switch (display preference, not a run override)", async () => {
    const ctx = baseCtx();
    await handleSlashCommand({ ...ctx, text: "/thinking off" });
    await handleSlashCommand({ ...ctx, text: "/backend claude" });
    expect(ctx.router.getBinding(ctx.chatId).showThinking).toBe(false);
  });

  it("/status reflects the thinking state", async () => {
    const ctx = baseCtx();
    await handleSlashCommand({ ...ctx, text: "/thinking off" });
    const status = await handleSlashCommand({ ...ctx, text: "/status" });
    expect((status as { text: string }).text).toContain("只显示最终答案");
  });
});
