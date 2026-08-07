import type { AgentProfile } from "@codebridge/session-catalog";

export type AgentAdapter = {
  agentId: string;
  kind: AgentProfile["adapter"];
  health(): Promise<AgentProfile["status"]> | AgentProfile["status"];
};

export class AgentRegistry {
  private readonly profiles = new Map<string, AgentProfile>();

  register(profile: AgentProfile): AgentProfile {
    this.profiles.set(profile.agentId, {
      ...profile,
      capabilities: [...profile.capabilities],
      models: [...profile.models],
      sessionFeatures: [...profile.sessionFeatures],
    });
    return this.get(profile.agentId)!;
  }

  async refresh(adapter: AgentAdapter): Promise<AgentProfile | undefined> {
    const profile = this.get(adapter.agentId);
    if (!profile) return undefined;
    profile.status = await adapter.health();
    return this.register(profile);
  }

  get(agentId: string): AgentProfile | undefined {
    const profile = this.profiles.get(agentId);
    return profile ? clone(profile) : undefined;
  }

  list(): AgentProfile[] {
    return [...this.profiles.values()].map(clone);
  }
}

function clone(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    capabilities: [...profile.capabilities],
    models: [...profile.models],
    sessionFeatures: [...profile.sessionFeatures],
  };
}
