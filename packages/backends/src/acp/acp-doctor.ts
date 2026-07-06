import { spawn } from "node:child_process";
import type { BackendProfile, DoctorResult } from "@feishu-code-bridge/core";
import { getBackendTransport } from "./acp-spawn-profiles.js";
import { probeAcpInitialize } from "./acp-session-list.js";

async function checkCliVersion(
  id: string,
  profile: BackendProfile,
): Promise<DoctorResult["checks"][number]> {
  return new Promise((resolve) => {
    const child = spawn(profile.command, ["--version"], {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d) => {
      out += d.toString();
    });
    child.on("close", (code) => {
      resolve({
        name: `${id}:cli-version`,
        ok: code === 0,
        message: out.trim() || `exit ${code}`,
      });
    });
    child.on("error", (err) => {
      resolve({
        name: `${id}:cli-version`,
        ok: false,
        message: err.message,
      });
    });
  });
}

export async function detectBackend(
  id: string,
  profile: BackendProfile,
  cwd: string,
): Promise<DoctorResult> {
  const checks: DoctorResult["checks"] = [];
  const transport = getBackendTransport(profile);

  const cli = await checkCliVersion(id, profile);
  checks.push(cli);

  if (transport === "acp") {
    const acp = await probeAcpInitialize(profile, cwd);
    checks.push({
      name: `${id}:acp-initialize`,
      ok: acp.ok,
      message: acp.message,
    });
    return { ok: acp.ok, checks };
  }

  return { ok: cli.ok, checks };
}
