import { parseStreamJsonLine } from "@feishu-code-bridge/core";
import type {
  AgentEvent,
  BackendProfile,
  DoctorResult,
  RunContext,
} from "@feishu-code-bridge/core";

export interface AgentBackend {
  readonly id: string;
  detect(): Promise<DoctorResult>;
  buildArgv(ctx: RunContext): string[];
  parseLine(line: string): AgentEvent[];
}

export function createBackend(
  id: string,
  profile: BackendProfile,
): AgentBackend {
  switch (profile.type) {
    case "cursor-cli":
      return new CursorCliBackend(id, profile);
    case "claude-code":
      return new ClaudeCodeBackend(id, profile);
    case "codex":
      return new CodexBackend(id, profile);
    default:
      return new GenericSpawnBackend(id, profile);
  }
}

abstract class BaseBackend implements AgentBackend {
  constructor(
    readonly id: string,
    protected readonly profile: BackendProfile,
  ) {}

  abstract buildArgv(ctx: RunContext): string[];

  parseLine(line: string): AgentEvent[] {
    return parseStreamJsonLine(line);
  }

  async detect(): Promise<DoctorResult> {
    const { spawn } = await import("node:child_process");
    const checks: DoctorResult["checks"] = [];
    return new Promise((resolve) => {
      const child = spawn(this.profile.command, ["--version"], {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout?.on("data", (d) => {
        out += d.toString();
      });
      child.on("close", (code) => {
        checks.push({
          name: `${this.id}:version`,
          ok: code === 0,
          message: out.trim() || `exit ${code}`,
        });
        resolve({ ok: checks.every((c) => c.ok), checks });
      });
      child.on("error", (err) => {
        checks.push({
          name: `${this.id}:version`,
          ok: false,
          message: err.message,
        });
        resolve({ ok: false, checks });
      });
    });
  }
}

class CursorCliBackend extends BaseBackend {
  buildArgv(ctx: RunContext): string[] {
    const args = [
      ...(this.profile.args ?? []),
      "-p",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
    ];
    if (this.profile.command === "agent") {
      args.push("--workspace", ctx.cwd);
    }
    const model = ctx.model ?? this.profile.model;
    if (model) {
      args.unshift("--model", model);
    }
    if (ctx.resumeSessionId) {
      args.unshift("--resume", ctx.resumeSessionId);
    }
    args.push(ctx.prompt);
    return [this.profile.command, ...args];
  }
}

class ClaudeCodeBackend extends BaseBackend {
  buildArgv(ctx: RunContext): string[] {
    const claudeArgs = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    const model = ctx.model ?? this.profile.model;
    const effort = ctx.effort ?? this.profile.effort;
    if (model) {
      claudeArgs.unshift("--model", model);
    }
    if (effort) {
      claudeArgs.unshift("--effort", effort);
    }
    if (ctx.resumeSessionId) {
      claudeArgs.unshift("--resume", ctx.resumeSessionId);
    }
    claudeArgs.push(ctx.prompt);
    if (this.profile.claudeArgsOption) {
      return [
        this.profile.command,
        ...(this.profile.args ?? []),
        this.profile.claudeArgsOption,
        claudeArgs.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "),
      ];
    }
    return [this.profile.command, ...(this.profile.args ?? []), ...claudeArgs];
  }
}

class CodexBackend extends BaseBackend {
  buildArgv(ctx: RunContext): string[] {
    const execArgs = ["exec", "--json", "-C", ctx.cwd];
    const model = ctx.model ?? this.profile.model;
    if (model) {
      execArgs.push("-m", model);
    }
    if (this.profile.allowBypassApprovals) {
      execArgs.push("--dangerously-bypass-approvals-and-sandbox");
    }
    if (ctx.resumeSessionId) {
      execArgs.push("resume", ctx.resumeSessionId, ctx.prompt);
    } else {
      execArgs.push(ctx.prompt);
    }
    if (this.profile.codexArgsOption) {
      return [
        this.profile.command,
        ...(this.profile.args ?? []),
        this.profile.codexArgsOption,
        execArgs.join(" "),
      ];
    }
    return [this.profile.command, ...execArgs];
  }
}

class GenericSpawnBackend extends BaseBackend {
  buildArgv(ctx: RunContext): string[] {
    return [this.profile.command, ...(this.profile.args ?? []), ctx.prompt];
  }

  parseLine(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    return [{ type: "text_delta", text: `${trimmed}\n` }];
  }
}

export class BackendRegistry {
  private readonly backends = new Map<string, AgentBackend>();

  register(id: string, profile: BackendProfile): void {
    this.backends.set(id, createBackend(id, profile));
  }

  get(id: string): AgentBackend | undefined {
    return this.backends.get(id);
  }

  ids(): string[] {
    return [...this.backends.keys()];
  }

  async doctor(): Promise<DoctorResult> {
    const all: DoctorResult["checks"] = [];
    let ok = true;
    for (const backend of this.backends.values()) {
      const result = await backend.detect();
      all.push(...result.checks);
      if (!result.ok) ok = false;
    }
    return { ok, checks: all };
  }
}

export {
  type CliSessionSummary,
  encodeClaudeProjectDir,
  listClaudeSessions,
  listCodexSessions,
  listCursorSessions,
  listSessionsForBackend,
} from "./session-discovery.js";
