import { describe, expect, it } from "vitest";
import { AgentRegistry } from "./index.js";

describe("agent registry", () => {
  it("keeps a stable registry for configured and setup-required Agents", () => {
    const registry = new AgentRegistry();
    registry.register({ agentId: "codex", displayName: "Codex", adapter: "acp", status: "healthy", capabilities: ["session"], models: [], sessionFeatures: ["resume"] });
    registry.register({ agentId: "pi", displayName: "Pi", adapter: "sdk", status: "needs_setup", capabilities: [], models: [], sessionFeatures: [] });
    expect(registry.list().map((agent) => agent.agentId)).toEqual(["codex", "pi"]);
    expect(registry.get("pi")?.adapter).toBe("sdk");
  });
});
