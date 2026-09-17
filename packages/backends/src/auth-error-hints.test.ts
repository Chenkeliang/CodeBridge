import { describe, expect, it } from "vitest";
import { friendlyAuthErrorMessage, isAuthErrorMessage } from "./auth-error-hints.js";

describe("isAuthErrorMessage", () => {
  it.each([
    "OAuth session expired and could not be refreshed",
    "oauth session expired",
    "session could not be refreshed",
    "Not logged in",
    "Please run /login",
    "please RUN /login to continue",
  ])("matches known auth failure text: %s", (message) => {
    expect(isAuthErrorMessage(message)).toBe(true);
  });

  it("does not match an unrelated error", () => {
    expect(isAuthErrorMessage("ECONNRESET: socket hang up")).toBe(false);
  });
});

describe("friendlyAuthErrorMessage", () => {
  it("maps Claude Code auth failures to `claude auth login`, keeping original detail", () => {
    const original = "Failed to authenticate: OAuth session expired and could not be refreshed";
    const mapped = friendlyAuthErrorMessage("claude-code", original);
    expect(mapped).toContain("claude auth login");
    expect(mapped).toContain("Claude Code");
    expect(mapped).toContain(original);
  });

  it("maps Codex auth failures to `codex login`", () => {
    const mapped = friendlyAuthErrorMessage("codex", "Not logged in");
    expect(mapped).toContain("codex login");
  });

  it("maps Cursor auth failures to `agent login`", () => {
    const mapped = friendlyAuthErrorMessage("cursor-cli", "Please run /login");
    expect(mapped).toContain("agent login");
  });

  it("keeps a generic hint (no invented command) for backends without a known login flow", () => {
    const mapped = friendlyAuthErrorMessage("generic-spawn", "Not logged in");
    expect(mapped).toContain("认证失败");
    expect(mapped).not.toMatch(/`[a-z-]+ (login|auth login)`/);
  });

  it("passes an unrelated error through unchanged", () => {
    const original = "ECONNRESET: socket hang up";
    expect(friendlyAuthErrorMessage("claude-code", original)).toBe(original);
  });
});
