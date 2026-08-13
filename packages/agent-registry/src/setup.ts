import type {
  AgentProfile,
  AgentSetupManifest,
  AgentSetupState,
} from "@codebridge/session-catalog";

export const supportedAgentSetupManifests: AgentSetupManifest[] = [
  {
    agentId: "codex",
    displayName: "Codex",
    adapter: "acp",
    installStrategies: [
      {
        id: "npm-global",
        label: "Install Codex globally",
        command: "npm",
        args: ["install", "-g", "@openai/codex"],
        available: true,
        requiresConfirmation: true,
      },
    ],
    configurationOwner: "agent",
    documentationUrl: "https://developers.openai.com/codex/",
    supportsManagedConfiguration: false,
  },
  {
    agentId: "pi",
    displayName: "Pi",
    adapter: "sdk",
    installStrategies: [],
    configurationOwner: "codebridge",
    configurationPath: "~/.pi/agent/models.json",
    documentationUrl: "https://docs.orchestration/agent-providers#pi",
    supportsManagedConfiguration: true,
  },
  {
    agentId: "cursor",
    displayName: "Cursor",
    adapter: "acp",
    installStrategies: [],
    configurationOwner: "agent",
    documentationUrl: "https://cursor.com/",
    supportsManagedConfiguration: false,
  },
  {
    agentId: "claude",
    displayName: "Claude Code",
    adapter: "acp",
    installStrategies: [
      {
        id: "npm-global",
        label: "Install Claude Code globally",
        command: "npm",
        args: ["install", "-g", "@anthropic-ai/claude-code"],
        available: true,
        requiresConfirmation: true,
      },
    ],
    configurationOwner: "agent",
    documentationUrl: "https://docs.anthropic.com/en/docs/claude-code",
    supportsManagedConfiguration: false,
  },
  {
    agentId: "opencode",
    displayName: "OpenCode",
    adapter: "acp",
    installStrategies: [
      {
        id: "npm-global",
        label: "Install OpenCode globally",
        command: "npm",
        args: ["install", "-g", "opencode-ai"],
        available: true,
        requiresConfirmation: true,
      },
    ],
    configurationOwner: "agent",
    configurationPath: "~/.config/opencode/opencode.json",
    documentationUrl: "https://opencode.ai/docs/cli/",
    supportsManagedConfiguration: false,
  },
];

export const supportedAgentSetupManifestMap = new Map(
  supportedAgentSetupManifests.map((manifest) => [manifest.agentId, manifest] as const),
);

export function getSupportedAgentSetupManifest(agentId: string): AgentSetupManifest | undefined {
  return supportedAgentSetupManifestMap.get(agentId);
}

export function projectSetupState(
  state: Omit<AgentSetupState, "canSelectDefault" | "canCreateSession">,
): AgentSetupState {
  const canSelectDefault =
    state.installation === "installed" &&
    state.configuration === "configured";
  return {
    ...state,
    canSelectDefault,
    canCreateSession: canSelectDefault && state.runtime === "healthy",
  };
}

export function projectAgentStatus(
  state: Pick<AgentSetupState, "installation" | "configuration" | "runtime">,
): AgentProfile["status"] {
  if (state.installation !== "installed" || state.configuration !== "configured") {
    return "needs_setup";
  }
  return state.runtime === "healthy" ? "healthy" : "unavailable";
}

export function cloneSetupState(
  state: AgentSetupState | undefined,
): AgentSetupState | undefined {
  if (!state) return undefined;
  return {
    ...state,
    diagnostic: state.diagnostic ? { ...state.diagnostic } : undefined,
  };
}

export function cloneSetupManifest(
  manifest: AgentSetupManifest | undefined,
): AgentSetupManifest | undefined {
  if (!manifest) return undefined;
  return {
    ...manifest,
    installStrategies: manifest.installStrategies.map((strategy) => ({
      ...strategy,
      args: [...strategy.args],
    })),
  };
}
