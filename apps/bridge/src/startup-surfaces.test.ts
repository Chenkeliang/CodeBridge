import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { supportedAgentSetupManifests } from "@codebridge/agent-registry";
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

  it("gates the Agent Flow save tool on the reachable Web confirmation surface", () => {
    const config = defaultConfig();
    config.web = { enabled: false };
    config.feishu.appId = "cli_feishu_enabled";
    config.feishu.appSecret = "feishu_enabled_secret";

    expect(resolveStartupSurfaces(config)).toEqual({
      web: false,
      feishu: true,
      telegram: false,
    });

    const source = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

    expect(source).toContain("flowSaveSourceAvailability: surfaces.web && linkedSession");
    expect(source).not.toContain("flowSaveSourceAvailability: linkedSession\n");
    expect(source).not.toContain("flowSaveSourceAvailability: surfaces.feishu");
    expect(source).not.toContain("flowSaveSourceAvailability: surfaces.telegram");
  });

  it("keeps OpenCode in the configurable Agent registry and forwards Session config", () => {
    expect(
      supportedAgentSetupManifests.some((manifest) => manifest.agentId === "opencode"),
    ).toBe(true);

    const source = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

    expect(source).toContain("supportedAgentSetupManifests");
    expect(source).toContain("projectSetupState({");
    expect(source).toContain("effort: linkedSession?.effort ?? undefined");
    expect(source).toContain("acpConfig: linkedSession?.configOverrides");
  });
});
