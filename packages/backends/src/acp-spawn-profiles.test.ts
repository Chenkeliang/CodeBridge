import { describe, expect, it } from "vitest";
import { defaultConfig } from "@codebridge/core";
import {
  acpContinueMethod,
  resolveAcpSpawn,
} from "./acp/acp-spawn-profiles.js";

describe("acp-spawn-profiles", () => {
  it("resolves cursor acp spawn", () => {
    expect(
      resolveAcpSpawn({ type: "cursor-cli" }),
    ).toEqual({ command: "cursor-agent", args: ["acp"] });
  });

  it("uses the current Claude and Codex ACP adapters", () => {
    expect(resolveAcpSpawn({ type: "claude-code" }).args).toEqual([
      "-y",
      "@agentclientprotocol/claude-agent-acp@0.64.2",
    ]);
    expect(resolveAcpSpawn({ type: "codex" }).args).toEqual([
      "-y",
      "@agentclientprotocol/codex-acp@1.10.0",
    ]);
  });

  it("uses custom acpCommand/acpArgs", () => {
    expect(
      resolveAcpSpawn({
        type: "codex",
        acpCommand: "npx",
        acpArgs: ["-y", "@agentclientprotocol/codex-acp@1.1.4"],
      }),
    ).toEqual({
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp@1.1.4"],
    });
  });

  it("keeps the generated Codex profile aligned with the spawn fallback", () => {
    const profile = defaultConfig().backends.codex!;
    expect(resolveAcpSpawn(profile)).toEqual({
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp@1.10.0"],
    });
  });

  it("cursor continues with session/load", () => {
    expect(
      acpContinueMethod({ type: "cursor-cli" }),
    ).toBe("session/load");
  });

  it("claude continues with session/resume", () => {
    expect(acpContinueMethod({ type: "claude-code" })).toBe(
      "session/resume",
    );
  });
});
