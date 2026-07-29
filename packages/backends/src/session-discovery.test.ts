import { describe, expect, it } from "vitest";
import { encodeClaudeProjectDir } from "./session-discovery.js";

describe("encodeClaudeProjectDir", () => {
  it("encodes cwd like Claude Code", () => {
    expect(encodeClaudeProjectDir("/Users/dev/proj")).toBe("-Users-dev-proj");
  });
});
