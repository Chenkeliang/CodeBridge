import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards docs/spec/RULES.md: every rule declared machine-enforced
 * (`test:<marker>` / `script:<name>`) must be referenced by real code.
 * The registry and the codebase can no longer drift apart silently.
 */

const ROOT = new URL("../", import.meta.url).pathname;
const rulesMd = readFileSync(path.join(ROOT, "docs/spec/RULES.md"), "utf8");

interface Rule { id: string; level: string; enforcement: string; text: string }

function parseRules(): Rule[] {
  const rules: Rule[] = [];
  for (const line of rulesMd.split("\n")) {
    if (!line.startsWith("|") || line.includes("---") || line.includes("| ID |")) continue;
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    const [id, level, enforcement, ...rest] = cells as [string, string, string, string, ...string[]];
    if (!/^[A-Z]+(-[A-Z]+)*-\d+$/.test(id)) continue;
    rules.push({ id, level, enforcement, text: rest.join(" | ") });
  }
  return rules;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx|mts|mjs)$/.test(entry.name)) yield full;
  }
}

const ALL_FILES = [...sourceFiles(path.join(ROOT, "apps")), ...sourceFiles(path.join(ROOT, "packages")), ...sourceFiles(path.join(ROOT, "scripts"))];
const ALL_SOURCE = ALL_FILES.map((file) => readFileSync(file, "utf8"));

describe("spec rules registry", () => {
  const rules = parseRules();

  it("registers at least one rule per domain", () => {
    for (const prefix of ["FE-", "ARCH-", "PROTO-", "SEC-", "OPS-"]) {
      expect(rules.some((rule) => rule.id.startsWith(prefix)), prefix).toBe(true);
    }
  });

  it("never reuses or duplicates rule IDs", () => {
    const ids = rules.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only valid levels and enforcement forms", () => {
    for (const rule of rules) {
      expect(["MUST", "SHOULD", "MAY"], rule.id).toContain(rule.level);
      expect(rule.enforcement, rule.id).toMatch(/^(test:.+|script:.+|review)$/);
    }
  });

  it("every test-enforced rule is referenced by an existing test", () => {
    for (const rule of rules.filter((rule) => rule.enforcement.startsWith("test:"))) {
      const marker = rule.enforcement.slice(5);
      const foundIn = ALL_SOURCE.some((source) => source.includes(rule.id));
      const markerExists = ALL_SOURCE.some((source) => source.includes(marker))
        || ALL_FILES.some((file) => file.includes(marker));
      expect(markerExists, `${rule.id}: no test file contains "${marker}"`).toBe(true);
      expect(foundIn, `${rule.id}: rule ID not referenced in any test`).toBe(true);
    }
  });

  it("every script-enforced rule points at an existing script", () => {
    for (const rule of rules.filter((rule) => rule.enforcement.startsWith("script:"))) {
      const name = rule.enforcement.slice(7);
      expect(existsSync(path.join(ROOT, "scripts", name)), rule.id).toBe(true);
    }
  });
});
