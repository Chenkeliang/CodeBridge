import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "@codebridge/core";
import { resolveStartupSurfaces } from "./startup-surfaces.js";

describe("startup surfaces", () => {
  it("starts the Core API without requiring a messaging channel", () => {
    const config = defaultConfig();
    config.web = { enabled: false };

    expect(resolveStartupSurfaces(config)).toEqual({
      web: false,
      feishu: false,
      telegram: false,
    });
  });

  it("enables Web independently from Feishu and Telegram", () => {
    const config = defaultConfig();
    config.web = { enabled: true };

    expect(resolveStartupSurfaces(config)).toEqual({
      web: true,
      feishu: false,
      telegram: false,
    });
  });

  it("allows a one-time Web startup without changing persistent config", () => {
    const config = defaultConfig();

    expect(resolveStartupSurfaces(config, { web: true }).web).toBe(true);
  });

  it("keeps OpenCode in the configurable Agent registry and forwards Session effort", () => {
    const source = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

    expect(source).toContain('"opencode"');
    expect(source).toContain('opencode: "OpenCode"');
    expect(source).toContain("effort: linkedSession?.effort ?? undefined");
  });
});
