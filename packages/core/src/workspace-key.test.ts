import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalWorkspaceKey } from "./workspace-key.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-workspace-key-"));
  tempDirectories.push(dir);
  return dir;
}

describe("canonicalWorkspaceKey", () => {
  it("resolves to realpath without trailing slash", () => {
    const dir = tempDir();
    const result = canonicalWorkspaceKey(`${dir}/`);
    expect(result.key).toBe(fs.realpathSync(dir));
    expect(result.key.endsWith("/")).toBe(false);
    expect(result.diagnostic).toBeUndefined();
  });

  it("falls back to a resolved path with a diagnostic for a missing directory", () => {
    const missing = path.join(os.tmpdir(), "cb-does-not-exist", "sub");
    const result = canonicalWorkspaceKey(`${missing}/`);
    expect(result.key).toBe(path.resolve(missing));
    expect(result.key.endsWith("/")).toBe(false);
    expect(result.diagnostic).toMatch(/realpath failed/i);
  });
});
