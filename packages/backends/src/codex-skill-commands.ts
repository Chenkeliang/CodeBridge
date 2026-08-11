import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentAvailableCommand } from "@codebridge/core";

interface CodexSkill {
  name?: unknown;
  description?: unknown;
  shortDescription?: unknown;
  enabled?: unknown;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: { data?: Array<{ skills?: CodexSkill[] }> };
  error?: { message?: unknown };
}

const CODEX_SKILLS_TIMEOUT_MS = 5_000;

export async function listCodexSkillCommands(cwd: string): Promise<AgentAvailableCommand[]> {
  const child = spawn(process.env.CODEX_PATH || "codex", ["app-server", "--stdio"], {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new Error("Codex app-server stdio unavailable");
  }

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2_000);
  });
  const lines = createInterface({ input: child.stdout });

  return await new Promise<AgentAvailableCommand[]>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, commands?: AgentAvailableCommand[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      child.kill();
      if (error) reject(error);
      else resolve(commands ?? []);
    };
    const send = (value: unknown) => child.stdin?.write(`${JSON.stringify(value)}\n`);
    const timeout = setTimeout(() => finish(new Error("Codex skills/list timeout")), CODEX_SKILLS_TIMEOUT_MS);

    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (!settled) finish(new Error(stderr.trim() || `Codex app-server exited with code ${code}`));
    });
    lines.on("line", (line) => {
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        return;
      }
      if (response.id === 1) {
        if (response.error) {
          finish(new Error(String(response.error.message ?? "Codex initialize failed")));
          return;
        }
        send({ id: 2, method: "skills/list", params: { cwds: [cwd] } });
        return;
      }
      if (response.id !== 2) return;
      if (response.error) {
        finish(new Error(String(response.error.message ?? "Codex skills/list failed")));
        return;
      }
      const commands = new Map<string, AgentAvailableCommand>();
      for (const entry of response.result?.data ?? []) {
        for (const skill of entry.skills ?? []) {
          if (skill.enabled === false || typeof skill.name !== "string" || !skill.name) continue;
          const name = `$${skill.name}`;
          const description = typeof skill.shortDescription === "string"
            ? skill.shortDescription
            : typeof skill.description === "string"
              ? skill.description
              : skill.name;
          commands.set(name, { name, description });
        }
      }
      finish(undefined, [...commands.values()]);
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codebridge", title: "CodeBridge", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    });
  });
}
