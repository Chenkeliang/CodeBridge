import { describe, expect, it } from "vitest";
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
      "@agentclientprotocol/claude-agent-acp@0.63.0",
    ]);
    expect(resolveAcpSpawn({ type: "codex" }).args).toEqual([
      "-y",
      "@agentclientprotocol/codex-acp@1.1.7",
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
