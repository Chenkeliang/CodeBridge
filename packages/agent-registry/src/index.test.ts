import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "./index.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("agent registry", () => {
  it("keeps a stable registry for configured and setup-required Agents", () => {
    const registry = new AgentRegistry();
    registry.register({ agentId: "codex", displayName: "Codex", adapter: "acp", status: "healthy", capabilities: ["session"], models: [], sessionFeatures: ["resume"] });
    registry.register({ agentId: "pi", displayName: "Pi", adapter: "sdk", status: "needs_setup", capabilities: [], models: [], sessionFeatures: [] });
    expect(registry.list().map((agent) => agent.agentId)).toEqual(["codex", "pi"]);
    expect(registry.get("pi")?.adapter).toBe("sdk");
    registry.close();
  });

  it("persists runtime health while definitions remain supplied by config", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-agent-registry-"));
    tempDirectories.push(directory);
    const databasePath = path.join(directory, "agents.sqlite");
    const first = new AgentRegistry({ databasePath });
    first.register({ agentId: "pi", displayName: "Pi", adapter: "sdk", status: "healthy", capabilities: [], models: [], sessionFeatures: [] });
    await first.refresh({ agentId: "pi", kind: "sdk", health: async (): Promise<"unavailable"> => "unavailable" });
    first.close();

    const reopened = new AgentRegistry({ databasePath });
    reopened.register({ agentId: "pi", displayName: "Pi", adapter: "sdk", status: "needs_setup", capabilities: [], models: [], sessionFeatures: [] });
    expect(reopened.get("pi")?.status).toBe("unavailable");
    expect(reopened.getHealth("pi")).toMatchObject({ agentId: "pi", status: "unavailable" });
    reopened.close();
  });

  it("can run periodic adapter health refreshes and stop them", async () => {
    const registry = new AgentRegistry();
    registry.register({ agentId: "codex", displayName: "Codex", adapter: "acp", status: "healthy", capabilities: [], models: [], sessionFeatures: [] });
    let checks = 0;
    const stop = registry.startHealthChecks([{ agentId: "codex", kind: "acp", health: (): "healthy" => { checks += 1; return "healthy"; } }], 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    expect(checks).toBeGreaterThan(0);
    registry.close();
  });
});
