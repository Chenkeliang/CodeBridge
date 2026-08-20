import { describe, expect, it } from "vitest";
import { revisionTail } from "./revision-tail";

describe("revisionTail", () => {
  it("strips sha256: and returns the last 8 characters", () => {
    expect(revisionTail("sha256:abcdef0123456789")).toBe("23456789");
  });
  it("returns empty for nullish", () => {
    expect(revisionTail(null)).toBe("");
    expect(revisionTail(undefined)).toBe("");
  });
});