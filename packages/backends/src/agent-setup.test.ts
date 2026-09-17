import { describe, expect, it, vi } from "vitest";
import { AgentSetupService, redactSetupOutput, type AgentCommandResult } from "./agent-setup.js";
import type { AgentSetupManifest } from "@codebridge/session-catalog";

const opencodeManifest: AgentSetupManifest = {
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
  documentationUrl: "https://opencode.ai/docs/cli/",
  supportsManagedConfiguration: false,
};

function setupService(run?: (command: string, args: string[]) => Promise<AgentCommandResult>) {
  return new AgentSetupService({
    manifests: [opencodeManifest],
    run,
  });
}

describe("AgentSetupService", () => {
  it("reports a missing install when the version probe fails", async () => {
    const service = setupService(async (command, args) => {
      if (command === "opencode" && args[0] === "--version") {
        return {
          ok: false,
          exitCode: 127,
          stdout: "",
          stderr: "opencode: command not found",
        };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

    await expect(service.detect("opencode")).resolves.toMatchObject({
      installation: "missing",
      canSelectDefault: false,
      canCreateSession: false,
    });
  });

  it("refuses unknown agents and strategies before process creation", async () => {
    const run = vi.fn(async () => ({
      ok: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
    } satisfies AgentCommandResult));
    const service = setupService(run);

    await expect(service.install("missing", "npm-global")).rejects.toThrow("Unknown agent");
    await expect(service.install("opencode", "missing")).rejects.toThrow("Unknown install strategy");
    expect(run).not.toHaveBeenCalled();
  });

  it("surfaces install failures with redacted diagnostics", async () => {
    const service = setupService(async (command, args) => {
      if (command === "opencode" && args[0] === "--version") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "opencode 1.0.0",
          stderr: "",
        };
      }
      if (command === "opencode" && args[0] === "auth") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "logged in",
          stderr: "",
        };
      }
      if (command === "npm" && args[0] === "install") {
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "Authorization: Bearer secret-token\napi_key=sk-secret-token",
        };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

    await expect(service.install("opencode", "npm-global")).resolves.toMatchObject({
      ok: false,
      diagnostic: {
        stage: "install",
        code: "install_failed",
      },
    });
    expect(redactSetupOutput("Authorization: Bearer secret-token"))
      .toContain("Authorization: ******");
    expect(redactSetupOutput("api_key=sk-secret-token")).not.toContain("sk-secret-token");
  });

  describe("probeAuth", () => {
    it("reports claude auth status without ever throwing (advisory only)", async () => {
      const service = setupService(async (command, args) => {
        if (command === "claude" && args.join(" ") === "auth status") {
          return { ok: false, exitCode: 1, stdout: "", stderr: "Not logged in" };
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      });

      await expect(service.probeAuth("claude")).resolves.toMatchObject({
        ok: false,
        advisory: true,
        message: expect.stringContaining("Not logged in"),
      });
    });

    it("reports cursor auth status via `agent status`", async () => {
      const service = setupService(async (command, args) => {
        if (command === "agent" && args.join(" ") === "status") {
          return { ok: true, exitCode: 0, stdout: "logged in as x@y.com", stderr: "" };
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      });

      await expect(service.probeAuth("cursor")).resolves.toMatchObject({
        ok: true,
        advisory: true,
      });
    });

    it("falls back to config-file presence for codex (no live status command)", async () => {
      const service = new AgentSetupService({
        manifests: [opencodeManifest],
        homeDir: () => "/home/nobody",
        exists: async (filePath) => filePath.endsWith(".codex/config.toml"),
      });

      await expect(service.probeAuth("codex")).resolves.toMatchObject({
        ok: true,
        advisory: true,
      });
    });

    it("never rejects when the probe command itself throws", async () => {
      const service = setupService(async () => {
        throw new Error("ENOENT: claude not found");
      });

      await expect(service.probeAuth("claude")).resolves.toMatchObject({
        ok: false,
        advisory: true,
      });
    });

    it("returns an advisory no-op for agents without a known probe", async () => {
      const service = setupService();
      await expect(service.probeAuth("pi")).resolves.toMatchObject({
        ok: true,
        advisory: true,
      });
    });
  });
});
