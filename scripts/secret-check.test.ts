import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function fixture(file: string, content: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-privacy-check-")); roots.push(root);
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(new URL("./secret-check.sh", import.meta.url), path.join(root, "scripts/secret-check.sh"));
  const scanner = path.join(root, "scanner");
  // A version-only test double: the source policy must reject before invoking any scanner.
  fs.writeFileSync(scanner, '#!/bin/sh\nif [ "$1" = "version" ]; then echo 8.25.0; exit 0; fi\nexit 99\n', { mode: 0o700 });
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.writeFileSync(path.join(root, file), content);
  execFileSync("git", ["add", "--", file], { cwd: root });
  return spawnSync("bash", [path.join(root, "scripts/secret-check.sh")], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: "/fixture/private-home", GITLEAKS_BIN: scanner } });
}
it("rejects a staged local task registration before scanning", () => {
  const result = fixture("managed-local-tasks.json", "[]");
  expect(result.status).toBe(1); expect(result.stderr).toContain("Forbidden runtime/backup file");
});
it("rejects personal home paths from tracked examples before scanning", () => {
  const result = fixture("example.md", "/fixture/private-home/project");
  expect(result.status).toBe(1); expect(result.stderr).toContain("Personal home path in tracked source");
});
