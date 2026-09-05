import type { BackendProfile } from "@codebridge/core";

export interface AcpSpawnProfile {
  command: string;
  args: string[];
}

const DEFAULTS: Record<Exclude<BackendProfile["type"], "pi-sdk">, AcpSpawnProfile> = {
  "cursor-cli": { command: "cursor-agent", args: ["acp"] },
  "claude-code": {
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.64.2"],
  },
  codex: {
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.10.0"],
  },
  "generic-spawn": { command: "npx", args: [] },
};

export function resolveAcpSpawn(profile: BackendProfile): AcpSpawnProfile {
  if (profile.type === "pi-sdk") {
    throw new Error("Pi SDK backend does not use an ACP spawn command");
  }
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
