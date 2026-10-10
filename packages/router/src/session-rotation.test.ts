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

  it("rotates once the context reaches half the window by default", () => {
    // The production incident: one Codex session carried ~711k of a 828k window.
    expect(sessionRotationReason(ctx({ contextUsed: 711_489, contextSize: 828_400 }), undefined, NOW))
      .toBe("上一会话上下文已用 86%（711k / 828k tokens）");
    expect(sessionRotationReason(ctx({ contextUsed: 129_199, contextSize: 258_400 }), undefined, NOW)).toBeUndefined();
    expect(sessionRotationReason(ctx({ contextUsed: 129_200, contextSize: 258_400 }), undefined, NOW)).toContain("50%");
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

  it("honours configured thresholds and treats idleHours 0 as off", () => {
    expect(sessionRotationReason(ctx({ contextUsed: 80_000, contextSize: 100_000 }), { maxContextRatio: 0.9 }, NOW)).toBeUndefined();
    expect(sessionRotationReason(ctx({ lastActivityAt: hoursAgo(2) }), { idleHours: 1 }, NOW)).toBe("上一会话已闲置 2 小时");
    expect(sessionRotationReason(ctx({ lastActivityAt: hoursAgo(500) }), { idleHours: 0 }, NOW)).toBeUndefined();
  });

  it("ignores missing usage instead of guessing", () => {
    expect(sessionRotationReason(ctx({ contextUsed: null, contextSize: null, lastActivityAt: null }), undefined, NOW)).toBeUndefined();
  });

  it("tells the user the context was dropped and how to get it back", () => {
    expect(sessionRotationNotice("上一会话已闲置 30 小时")).toContain("/resume");
  });
});
