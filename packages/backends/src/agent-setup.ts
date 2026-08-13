import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import {
  createPiModelRuntime,
  probePiSdk,
} from "./pi-session-runner.js";
import type {
  AgentDiagnostic,
  AgentSetupManifest,
  AgentSetupState,
} from "@codebridge/session-catalog";

export interface AgentCommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
}

export interface AgentSetupRecord extends AgentSetupState {
  agentId: string;
}

export interface AgentSetupInstallResult extends AgentSetupRecord {
  ok: boolean;
}

export interface AgentSetupServiceOptions {
  manifests: AgentSetupManifest[];
  run?: (command: string, args: string[]) => Promise<AgentCommandResult>;
  exists?: (filePath: string) => Promise<boolean>;
  readText?: (filePath: string) => Promise<string>;
  homeDir?: () => string;
  piProbe?: typeof probePiSdk;
  piRuntimeFactory?: typeof createPiModelRuntime;
}

const CAPTURE_LIMIT = 8_192;

export class AgentSetupService {
  private readonly manifests = new Map<string, AgentSetupManifest>();

  constructor(private readonly options: AgentSetupServiceOptions) {
    for (const manifest of options.manifests) {
      this.manifests.set(manifest.agentId, cloneManifest(manifest));
    }
  }

  listManifests(): AgentSetupManifest[] {
    return [...this.manifests.values()].map(cloneManifest);
  }

  async list(): Promise<AgentSetupRecord[]> {
    return Promise.all(this.listManifests().map(async (manifest) => ({
      agentId: manifest.agentId,
      ...(await this.detect(manifest.agentId)),
    })));
  }

  async detect(agentId: string): Promise<AgentSetupState> {
    const manifest = this.getManifest(agentId);
    if (!manifest) throw new Error(`Unknown agent: ${agentId}`);

    switch (agentId) {
      case "opencode":
        return this.detectCliAgent({
          manifest,
          versionCommand: ["opencode", ["--version"]],
          configurationCheck: async () => {
            const auth = await this.run("opencode", ["auth", "list"]);
            if (!auth.ok) {
              return {
                installation: "installed",
                configuration: "needs_configuration",
                runtime: "not_started",
                version: versionFromOutput(auth.stdout) ?? versionFromOutput(auth.stderr),
                executablePath: "opencode",
                diagnostic: diagnosticFromCommand("configure", "configuration_required", "OpenCode is installed but not configured.", auth),
              };
            }
            return {
              installation: "installed",
              configuration: "configured",
              runtime: "healthy",
              version: versionFromOutput(auth.stdout) ?? versionFromOutput(auth.stderr),
              executablePath: "opencode",
            };
          },
        });
      case "codex":
        return this.detectCliAgent({
          manifest,
          versionCommand: ["codex", ["--version"]],
          configurationCheck: async () => {
            const configured = await this.hasCodexConfiguration();
            return configured
              ? {
                  installation: "installed",
                  configuration: "configured",
                  runtime: "healthy",
                  executablePath: "codex",
                }
              : {
                  installation: "installed",
                  configuration: "needs_configuration",
                  runtime: "not_started",
                  executablePath: "codex",
                  diagnostic: {
                    stage: "configure",
                    code: "configuration_required",
                    message: "Codex is installed but not configured.",
                    details: manifest.documentationUrl ?? manifest.configurationPath,
                  },
                };
          },
        });
      case "claude":
        return this.detectCliAgent({
          manifest,
          versionCommand: ["claude", ["--version"]],
          configurationCheck: async () => {
            const configured = await this.hasClaudeConfiguration();
            return configured
              ? {
                  installation: "installed",
                  configuration: "configured",
                  runtime: "healthy",
                  executablePath: "claude",
                }
              : {
                  installation: "installed",
                  configuration: "needs_configuration",
                  runtime: "not_started",
                  executablePath: "claude",
                  diagnostic: {
                    stage: "configure",
                    code: "configuration_required",
                    message: "Claude Code is installed but not configured.",
                    details: manifest.documentationUrl ?? manifest.configurationPath,
                  },
                };
          },
        });
      case "cursor":
        return this.detectCursor(manifest);
      case "pi":
        return this.detectPi(manifest);
      default:
        return this.detectGeneric(manifest);
    }
  }

  async install(agentId: string, strategyId: string): Promise<AgentSetupInstallResult> {
    const manifest = this.getManifest(agentId);
    if (!manifest) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    const strategy = manifest.installStrategies.find((candidate) => candidate.id === strategyId);
    if (!strategy) {
      throw new Error(`Unknown install strategy: ${agentId}/${strategyId}`);
    }
    if (!strategy.available) {
      return {
        agentId,
        ok: false,
        ...(await this.detect(agentId)),
        diagnostic: {
          stage: "install",
          code: "install_not_supported",
          message: `${manifest.displayName} does not support managed installation.`,
          details: manifest.documentationUrl ?? manifest.configurationPath,
        },
      };
    }

    try {
      const result = await this.run(strategy.command, strategy.args);
      if (!result.ok) {
        return {
          agentId,
          ok: false,
          ...(await this.detect(agentId)),
          diagnostic: {
            stage: "install",
            code: "install_failed",
            message: `${manifest.displayName} installation failed.`,
            details: joinSetupOutput(result),
            exitCode: result.exitCode ?? undefined,
          },
        };
      }
      const setup = await this.detect(agentId);
      return {
        agentId,
        ok: true,
        ...setup,
      };
    } catch (cause) {
      return {
        agentId,
        ok: false,
        ...(await this.detect(agentId)),
        diagnostic: {
          stage: "install",
          code: "install_failed",
          message: `${manifest.displayName} installation failed.`,
          details: cause instanceof Error ? cause.message : String(cause),
        },
      };
    }
  }

  private async detectGeneric(manifest: AgentSetupManifest): Promise<AgentSetupState> {
    const probe = manifest.installStrategies[0];
    if (!probe) {
      return projectSetupState({
        installation: "missing",
        configuration: "unknown",
        runtime: "not_started",
        diagnostic: {
          stage: "detect",
          code: "install_not_supported",
          message: `${manifest.displayName} has no managed install strategy.`,
          details: manifest.documentationUrl ?? manifest.configurationPath,
        },
      });
    }
    const result = await this.safeRun(probe.command, ["--version"]);
    return this.toMissingInstall(manifest, result);
  }

  private async detectCliAgent(options: {
    manifest: AgentSetupManifest;
    versionCommand: [string, string[]];
    configurationCheck: () => Promise<Omit<AgentSetupState, "canSelectDefault" | "canCreateSession">>;
  }): Promise<AgentSetupState> {
    const [command, args] = options.versionCommand;
    const version = await this.safeRun(command, args);
    if (!version.ok) {
      return this.toMissingInstall(options.manifest, version);
    }
    const configured = await options.configurationCheck();
    return projectSetupState({
      installation: "installed",
      configuration: configured.configuration,
      runtime: configured.configuration === "configured" ? "healthy" : "not_started",
      version: configured.version ?? versionFromOutput(version.stdout) ?? versionFromOutput(version.stderr),
      executablePath: configured.executablePath ?? command,
      diagnostic: cloneDiagnostic(configured.diagnostic),
    });
  }

  private async detectCursor(manifest: AgentSetupManifest): Promise<AgentSetupState> {
    const cursorAgent = await this.safeRun("cursor-agent", ["--version"]);
    const agent = cursorAgent.ok
      ? cursorAgent
      : await this.safeRun("agent", ["--version"]);
    if (!agent.ok) return this.toMissingInstall(manifest, agent);

    const status = await this.safeRun("agent", ["status"]);
    if (status.ok) {
      return projectSetupState({
        installation: "installed",
        configuration: "configured",
        runtime: "healthy",
        version: versionFromOutput(agent.stdout) ?? versionFromOutput(agent.stderr),
        executablePath: cursorAgent.ok ? "cursor-agent" : "agent",
      });
    }
    return projectSetupState({
      installation: "installed",
      configuration: "needs_configuration",
      runtime: "not_started",
      version: versionFromOutput(agent.stdout) ?? versionFromOutput(agent.stderr),
      executablePath: cursorAgent.ok ? "cursor-agent" : "agent",
      diagnostic: diagnosticFromCommand(
        "configure",
        "configuration_required",
        "Cursor Agent is installed but not configured.",
        status,
      ),
    });
  }

  private async detectPi(manifest: AgentSetupManifest): Promise<AgentSetupState> {
    const probe = this.options.piProbe ?? probePiSdk;
    const sdk = await probe(process.cwd());
    if (!sdk.ok) {
      return projectSetupState({
        installation: "missing",
        configuration: "unknown",
        runtime: "not_started",
        diagnostic: {
          stage: "detect",
          code: "install_not_found",
          message: "Pi SDK is not available.",
          details: sdk.message,
        },
      });
    }
    const runtimeFactory = this.options.piRuntimeFactory ?? createPiModelRuntime;
    try {
      const runtime = await runtimeFactory();
      const models = runtime.getModels();
      const configured = models.some((model) => runtime.hasConfiguredAuth(model.provider));
      return projectSetupState({
        installation: "installed",
        configuration: configured ? "configured" : "needs_configuration",
        runtime: configured ? "healthy" : "not_started",
        executablePath: "pi-sdk",
        diagnostic: configured
          ? undefined
          : {
              stage: "configure",
              code: "configuration_required",
              message: "Pi has no configured providers.",
              details: manifest.configurationPath,
            },
      });
    } catch (cause) {
      return projectSetupState({
        installation: "installed",
        configuration: "needs_configuration",
        runtime: "unavailable",
        executablePath: "pi-sdk",
        diagnostic: {
          stage: "health",
          code: "runtime_unavailable",
          message: "Pi runtime is unavailable.",
          details: cause instanceof Error ? cause.message : String(cause),
        },
      });
    }
  }

  private async run(command: string, args: string[]): Promise<AgentCommandResult> {
    const runner = this.options.run ?? defaultRun;
    return runner(command, args);
  }

  private async safeRun(command: string, args: string[]): Promise<AgentCommandResult> {
    try {
      return await this.run(command, args);
    } catch (cause) {
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  private getManifest(agentId: string): AgentSetupManifest | undefined {
    return this.manifests.get(agentId);
  }

  private toMissingInstall(
    manifest: AgentSetupManifest,
    result: AgentCommandResult,
  ): AgentSetupState {
    return projectSetupState({
      installation: "missing",
      configuration: "unknown",
      runtime: "not_started",
      diagnostic: diagnosticFromCommand(
        "detect",
        "install_not_found",
        `${manifest.displayName} is not installed.`,
        result,
      ),
      version: versionFromOutput(result.stdout) ?? versionFromOutput(result.stderr),
      executablePath: manifest.agentId,
    });
  }

  private async hasCodexConfiguration(): Promise<boolean> {
    if (envConfigured(["OPENAI_API_KEY", "OPENAI_API_BASE", "OPENAI_BASE_URL"])) {
      return true;
    }
    const home = this.homeDir();
    const configPaths = [
      path.join(home, ".codex", "config.toml"),
      path.join(home, ".config", "codex", "config.toml"),
    ];
    return anyExisting(configPaths, this.options.exists);
  }

  private async hasClaudeConfiguration(): Promise<boolean> {
    if (envConfigured(["ANTHROPIC_API_KEY", "CLAUDE_CODE_API_KEY"])) {
      return true;
    }
    const home = this.homeDir();
    const configPaths = [
      path.join(home, ".claude.json"),
      path.join(home, ".config", "claude-code", "config.json"),
    ];
    return anyExisting(configPaths, this.options.exists);
  }

  private homeDir(): string {
    return this.options.homeDir?.() ?? os.homedir();
  }
}

function cloneManifest(manifest: AgentSetupManifest): AgentSetupManifest {
  return {
    ...manifest,
    installStrategies: manifest.installStrategies.map((strategy) => ({
      ...strategy,
      args: [...strategy.args],
    })),
  };
}

function cloneDiagnostic(diagnostic: AgentDiagnostic | undefined): AgentDiagnostic | undefined {
  return diagnostic ? { ...diagnostic } : undefined;
}

function envConfigured(keys: string[]): boolean {
  return keys.some((key) => Boolean(process.env[key]?.trim()));
}

async function anyExisting(
  paths: string[],
  exists?: (filePath: string) => Promise<boolean>,
): Promise<boolean> {
  if (exists) {
    for (const candidate of paths) {
      if (await exists(candidate)) return true;
    }
    return false;
  }
  for (const candidate of paths) {
    try {
      await access(candidate);
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

function diagnosticFromCommand(
  stage: AgentDiagnostic["stage"],
  code: string,
  message: string,
  result: AgentCommandResult,
): AgentDiagnostic {
  const details = joinSetupOutput(result);
  return {
    stage,
    code,
    message,
    details: details || undefined,
    exitCode: result.exitCode ?? undefined,
  };
}

function joinSetupOutput(result: AgentCommandResult): string {
  return redactSetupOutput(
    [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n"),
  ).slice(-CAPTURE_LIMIT);
}

function versionFromOutput(output: string | undefined | null): string | undefined {
  const firstLine = output?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine || undefined;
}

function defaultRun(command: string, args: string[]): Promise<AgentCommandResult> {
  return new Promise<AgentCommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendCaptured(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendCaptured(stderr, chunk);
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({
        ok: exitCode === 0,
        exitCode,
        signal,
        stdout: redactSetupOutput(stdout),
        stderr: redactSetupOutput(stderr),
      });
    });
  });
}

function appendCaptured(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  return next.length > CAPTURE_LIMIT ? next.slice(-CAPTURE_LIMIT) : next;
}

function projectSetupState(
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

export function redactSetupOutput(value: string): string {
  return value
    .replace(/Authorization:\s*(?:Bearer\s+)?[A-Za-z0-9._-]+/gi, "Authorization: ******")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*(['"])?[^\s'"]+\2/gi, "$1=******")
    .replace(/\bsk-[A-Za-z0-9]{8,}\b/g, "sk-******");
}
