import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

function themeVars(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/(--agnet-[\w-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((match) => [match[1]!, match[2]!]));
}

const paper = themeVars(':root, [data-theme="paper"]');
const carbon = themeVars('[data-theme="carbon"]');

function luminance(hex: string): number {
  const raw = hex.replace(/^#/, "");
  const channel = (index: number) => {
    const value = parseInt(raw.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(fg: string, bg: string): number {
  const [low, high] = [luminance(fg), luminance(bg)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}

function channelSpread(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  return Math.max(...channels) - Math.min(...channels);
}

const TEXT_ON = ["--agnet-canvas", "--agnet-surface", "--agnet-surface-soft", "--agnet-surface-tint"] as const;

// Enforces spec rules FE-TOKEN-001, FE-TOKEN-002, FE-TOKEN-003, FE-TOKEN-004 (docs/spec/RULES.md).
describe("design tokens", () => {
  it("keeps text tokens at WCAG AA contrast on every surface, in both themes", () => {
    for (const [name, vars] of [["paper", paper], ["carbon", carbon]] as const) {
      for (const fg of ["--agnet-ink", "--agnet-ink-soft", "--agnet-muted", "--agnet-faint"]) {
        for (const bg of TEXT_ON) {
          const ratio = contrast(vars[fg]!, vars[bg]!);
          expect(ratio, `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const fg of ["--agnet-success", "--agnet-warning", "--agnet-danger"]) {
        for (const bg of ["--agnet-canvas", "--agnet-surface"]) {
          const ratio = contrast(vars[fg]!, vars[bg]!);
          expect(ratio, `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(3.0);
        }
      }
    }
  });

  it("keeps accent text legible on the accent color in both themes", () => {
    for (const [name, vars] of [["paper", paper], ["carbon", carbon]] as const) {
      expect(contrast(vars["--agnet-accent-ink"]!, vars["--agnet-accent"]!), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("defines the same token set in both themes", () => {
    expect(Object.keys(paper).sort()).toEqual(Object.keys(carbon).sort());
  });

  it("defines matching semantic overlay tokens and scopes frosting to opt-in surfaces", () => {
    expect(paper["--agnet-overlay"]).toBe("#FFFFFF");
    expect(carbon["--agnet-overlay"]).toBe("#1D1D1D");
    expect(css).toContain("--agnet-overlay-strength: 94%");
    expect(css).toContain("--agnet-overlay-strength: 84%");
    expect(css).toContain("@utility surface-frosted");
    expect(css).toContain("background: color-mix(in srgb, var(--agnet-overlay) var(--agnet-overlay-strength), transparent)");
    expect(css).toContain("backdrop-filter: blur(");
  });

  it("keeps carbon structural surfaces neutral instead of green-tinted", () => {
    for (const token of ["--agnet-canvas", "--agnet-sidebar", "--agnet-surface", "--agnet-surface-soft", "--agnet-surface-tint", "--agnet-line"]) {
      expect(channelSpread(carbon[token]!), token).toBeLessThanOrEqual(1);
    }
  });

  it("matches the hex values documented in DESIGN.md", () => {
    const doc = readFileSync(new URL("../../../docs/orchestration/DESIGN.md", import.meta.url), "utf8");
    const paperSection = doc.split("### 3.2 Paper Lime")[1]?.split("### 3.3")[0] ?? "";
    const carbonSection = doc.split("### 3.3 Carbon Vermilion")[1]?.split("### 3.4")[0] ?? "";
    const toKebab = (name: string) => `--agnet-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    for (const [label, section, vars] of [["paper", paperSection, paper], ["carbon", carbonSection, carbon]] as const) {
      const docTokens = [...section.matchAll(/\| `agnet\.(\w+)` \| `(#[0-9A-Fa-f]{6})` \|/g)];
      expect(docTokens.length, `${label} token table`).toBeGreaterThanOrEqual(15);
      for (const match of docTokens) {
        const token = toKebab(match[1]!);
        const hex = match[2]!.toUpperCase();
        expect(vars[token]?.toUpperCase(), `DESIGN.md ${label} documents ${token} ${hex} but index.css has ${vars[token]}`).toBe(hex);
      }
    }
  });
});
