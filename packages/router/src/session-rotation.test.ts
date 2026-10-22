import { describe, expect, it } from "vitest";
import type { ChannelCommandContext } from "@codebridge/core";
import { sessionRotationNotice, sessionRotationReason } from "./session-rotation.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const ctx = (over: Partial<ChannelCommandContext> = {}): ChannelCommandContext => ({
  sessionId: "sess", activeRunId: null, providerSessionId: "prov",
  lastActivityAt: hoursAgo(1), contextUsed: 10_000, contextSize: 258_400, queuedTurns: 0, ...over,
});

describe("sessionRotationReason", () => {
  it("keeps a fresh, lightly used session", () => {
    expect(sessionRotationReason(ctx(), undefined, NOW)).toBeUndefined();
  });

  it("keeps the provider session at 50%, 52%, and a full context window", () => {
    for (const used of [414_200, 434_000, 711_489, 828_400]) {
      expect(sessionRotationReason(ctx({ contextFirstUsed: 20_000, contextUsed: used, contextSize: 828_400 }), undefined, NOW)).toBeUndefined();
    }
  });

  it("rotates after 12 idle hours by default", () => {
    expect(sessionRotationReason(ctx({ lastActivityAt: hoursAgo(11.9) }), undefined, NOW)).toBeUndefined();
    expect(sessionRotationReason(ctx({ lastActivityAt: hoursAgo(30) }), undefined, NOW)).toBe("上一会话已闲置 30 小时");
  });

  it("never rotates a busy session, an unbound slot, or when disabled", () => {
    const full = { contextUsed: 800_000, contextSize: 828_400, lastActivityAt: hoursAgo(48) };
    expect(sessionRotationReason(ctx({ ...full, activeRunId: "run" }), undefined, NOW)).toBeUndefined();
    expect(sessionRotationReason(ctx({ ...full, queuedTurns: 1 }), undefined, NOW)).toBeUndefined();
    expect(sessionRotationReason(ctx({ ...full, sessionId: null }), undefined, NOW)).toBeUndefined();
    expect(sessionRotationReason(ctx(full), { enabled: false }, NOW)).toBeUndefined();
  });

  it("honours idle settings and ignores the legacy context rotation threshold", () => {
    expect(sessionRotationReason(ctx({ contextUsed: 80_000, contextSize: 100_000 }), { maxContextRatio: 0.5 }, NOW)).toBeUndefined();
    expect(sessionRotationReason(ctx({ lastActivityAt: hoursAgo(2) }), { idleHours: 1 }, NOW)).toBe("上一会话已闲置 2 小时");
    expect(sessionRotationReason(ctx({ lastActivityAt: hoursAgo(500) }), { idleHours: 0 }, NOW)).toBeUndefined();
  });

  it("retains context regardless of first usage while still respecting idle rotation", () => {
    // /resume binds the old provider session again; its first usage is already large.
    const resumed = ctx({ contextFirstUsed: 700_000, contextUsed: 711_489, contextSize: 828_400 });
    expect(sessionRotationReason(resumed, undefined, NOW)).toBeUndefined();
    expect(sessionRotationReason({ ...resumed, lastActivityAt: hoursAgo(13) }, undefined, NOW)).toBe("上一会话已闲置 13 小时");
    expect(sessionRotationReason(ctx({ contextFirstUsed: 20_000, contextUsed: 711_489, contextSize: 828_400 }), undefined, NOW))
      .toBeUndefined();
  });

  it("ignores missing usage instead of guessing", () => {
    expect(sessionRotationReason(ctx({ contextUsed: null, contextSize: null, lastActivityAt: null }), undefined, NOW)).toBeUndefined();
  });

  it("tells the user the context was dropped and how to get it back", () => {
    expect(sessionRotationNotice("上一会话已闲置 30 小时")).toContain("/resume");
  });
});
