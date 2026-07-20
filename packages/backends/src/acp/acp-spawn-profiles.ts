import type { BackendProfile } from "@feishu-code-bridge/core";

export interface AcpSpawnProfile {
  command: string;
  args: string[];
}

const DEFAULTS: Record<BackendProfile["type"], AcpSpawnProfile> = {
  "cursor-cli": { command: "cursor-agent", args: ["acp"] },
  "claude-code": {
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.55.0"],
  },
  codex: {
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.1.4"],
  },
  "generic-spawn": { command: "npx", args: [] },
};

export function getBackendTransport(
  profile: BackendProfile,
): "acp" | "cli" {
  return profile.transport ?? "acp";
}

export function resolveAcpSpawn(profile: BackendProfile): AcpSpawnProfile {
  const defaults = DEFAULTS[profile.type] ?? DEFAULTS["generic-spawn"];
  return {
    command: profile.acpCommand ?? defaults.command,
    args: profile.acpArgs ?? defaults.args,
  };
}

/** Cursor 无 session/resume，续聊用 load；其余优先 resume */
export function acpContinueMethod(
  profile: BackendProfile,
): "session/load" | "session/resume" {
  return profile.type === "cursor-cli" ? "session/load" : "session/resume";
}
