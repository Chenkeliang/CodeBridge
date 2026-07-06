import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import {
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  client,
  type ClientConnection,
} from "@agentclientprotocol/sdk";
import type { BackendProfile } from "@feishu-code-bridge/core";
import type { CliSessionSummary } from "../session-discovery.js";
import { resolveAcpSpawn } from "./acp-spawn-profiles.js";

function childToStream(child: ReturnType<typeof spawn>) {
  if (!child.stdin || !child.stdout) {
    throw new Error("ACP agent stdio pipes unavailable");
  }
  return ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
}

async function withAcpConnection<T>(
  profile: BackendProfile,
  cwd: string,
  op: (agent: ClientConnection["agent"]) => Promise<T>,
): Promise<T> {
  const spawnProfile = resolveAcpSpawn(profile);
  const child = spawn(spawnProfile.command, spawnProfile.args, {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const app = client({ name: "feishu-code-bridge" });
  const stream = childToStream(child);
  const connection = app.connect(stream);
  try {
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "feishu-code-bridge", version: "0.1.0" },
    });
    return await op(connection.agent);
  } finally {
    connection.close();
    if (!child.killed) child.kill("SIGTERM");
  }
}

export async function listAcpSessions(
  backendId: string,
  profile: BackendProfile,
  cwd: string,
  options?: { limit?: number },
): Promise<CliSessionSummary[]> {
  const limit = options?.limit ?? 20;
  try {
    const result = await withAcpConnection(profile, cwd, (agent) =>
      agent.request(methods.agent.session.list, { cwd }),
    );
    return (result.sessions ?? []).slice(0, limit).map((s) => ({
      id: s.sessionId,
      backend: backendId,
      cwd: s.cwd ?? cwd,
      preview: s.title ?? "(no preview)",
      updatedAt: s.updatedAt ?? new Date().toISOString(),
    }));
  } catch {
    return [];
  }
}

export async function probeAcpInitialize(
  profile: BackendProfile,
  cwd: string,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; message: string }> {
  const spawnProfile = resolveAcpSpawn(profile);
  return new Promise((resolve) => {
    const child = spawn(spawnProfile.command, spawnProfile.args, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, message: "ACP initialize timeout" });
    }, timeoutMs);

    (async () => {
      try {
        const app = client({ name: "feishu-code-bridge" });
        const stream = childToStream(child);
        const connection = app.connect(stream);
        const init = await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "feishu-code-bridge", version: "0.1.0" },
        });
        connection.close();
        const caps = init.agentCapabilities;
        const parts = [
          `protocol=${init.protocolVersion}`,
          caps?.promptCapabilities?.image ? "image" : null,
          caps?.sessionCapabilities?.list ? "list" : null,
          caps?.sessionCapabilities?.resume ? "resume" : null,
          caps?.loadSession ? "load" : null,
        ].filter(Boolean);
        resolve({ ok: true, message: parts.join(", ") });
      } catch (err) {
        resolve({
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearTimeout(timer);
        if (!child.killed) child.kill("SIGTERM");
      }
    })();
  });
}
