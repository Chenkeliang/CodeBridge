import { describe, expect, it } from "vitest";
import {
  acpContinueMethod,
  getBackendTransport,
  resolveAcpSpawn,
} from "./acp/acp-spawn-profiles.js";

describe("acp-spawn-profiles", () => {
  it("defaults transport to acp", () => {
    expect(
      getBackendTransport({ type: "cursor-cli", command: "cursor-agent" }),
    ).toBe("acp");
  });

  it("resolves cursor acp spawn", () => {
    expect(
      resolveAcpSpawn({ type: "cursor-cli", command: "cursor-agent" }),
    ).toEqual({ command: "cursor-agent", args: ["acp"] });
  });

  it("uses custom acpCommand/acpArgs", () => {
    expect(
      resolveAcpSpawn({
        type: "codex",
        command: "codex",
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
      acpContinueMethod({ type: "cursor-cli", command: "cursor-agent" }),
    ).toBe("session/load");
  });

  it("claude continues with session/resume", () => {
    expect(acpContinueMethod({ type: "claude-code", command: "claude" })).toBe(
      "session/resume",
    );
  });
});
