import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  client,
  type ClientConnection,
  type ListSessionsRequest,
  type ListSessionsResponse,
} from "@agentclientprotocol/sdk";
import type {
  BackendConfigOption,
  BackendProfile,
} from "@feishu-code-bridge/core";
import type { CliSessionSummary } from "../session-discovery.js";
import { killProcessTree } from "./acp-kill.js";
import { resolveAcpSpawn } from "./acp-spawn-profiles.js";
import { mapSessionConfigOptions } from "./acp-config-options.js";

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
    detached: true, // 自成进程组，退出时全组一起杀，避免适配器的孙进程残留
  });
  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", reject);
  });
  const app = client({ name: "feishu-code-bridge" });
  const stream = childToStream(child);
  const connection = app.connect(stream);
  try {
    await Promise.race([
      connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "feishu-code-bridge", version: "0.1.0" },
      }),
      spawnError,
    ]);
    return await Promise.race([op(connection.agent), spawnError]);
  } finally {
    connection.close();
    if (!child.killed) killProcessTree(child, "SIGTERM");
  }
}

export async function listAcpSessions(
  backendId: string,
  profile: BackendProfile,
  cwd: string,
  options?: { limit?: number; all?: boolean },
): Promise<CliSessionSummary[]> {
  return withAcpConnection(profile, cwd, (agent) =>
    collectAcpSessions(
      backendId,
      cwd,
      (params) => agent.request(methods.agent.session.list, params),
      options,
    ),
  );
}

function cwdUnderScope(sessionCwd: string, scopeCwd: string): boolean {
  const session = path.resolve(sessionCwd);
  const scope = path.resolve(scopeCwd);
  return session === scope || session.startsWith(`${scope}${path.sep}`);
}

export async function collectAcpSessions(
  backendId: string,
  cwd: string,
  requestPage: (params: ListSessionsRequest) => Promise<ListSessionsResponse>,
  options?: { limit?: number; all?: boolean },
): Promise<CliSessionSummary[]> {
  const sessions: ListSessionsResponse["sessions"] = [];
  let cursor: string | undefined;
  do {
    const page = await requestPage(cursor ? { cursor } : {});
    sessions.push(...page.sessions);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  const scoped = options?.all
    ? sessions
    : sessions.filter((session) => cwdUnderScope(session.cwd, cwd));
  return scoped
    .map((session) => ({
      id: session.sessionId,
      backend: backendId,
      cwd: session.cwd,
      preview: session.title ?? "(no preview)",
      updatedAt: session.updatedAt ?? "1970-01-01T00:00:00.000Z",
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, options?.limit ?? 20);
}

const ACP_CONFIG_OPTIONS_TIMEOUT_MS = 15_000;

/**
 * 拉取 ACP 适配器 advertise 的会话配置项（/model 动态列表用）：短暂 spawn 适配器，
 * initialize + session/new 读 configOptions 后立即销毁。不发 prompt，无推理成本；
 * claude 适配器对未发过 prompt 的会话不持久化（实测 resume 报 Resource not found）。
 * 超时/失败直接抛出，调用方展示 adapter 的真实错误，不回退到过期静态列表。
 */
export async function listAcpConfigOptions(
  profile: BackendProfile,
  cwd: string,
  timeoutMs = ACP_CONFIG_OPTIONS_TIMEOUT_MS,
): Promise<BackendConfigOption[]> {
  return withAcpConnection(profile, cwd, (agent) => {
    // 超时放在 op 内：reject 后 withAcpConnection 的 finally 负责 close + kill
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("ACP config options timeout")),
        timeoutMs,
      );
      timer.unref?.();
    });
    const fetchOptions = (async () => {
      const active = await agent.buildSession(cwd).start();
      const options = active.newSessionResponse.configOptions ?? [];
      active.dispose();
      return mapSessionConfigOptions(options);
    })();
    return Promise.race([fetchOptions, timeout]);
  });
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
      detached: true,
    });
    const spawnError = new Promise<never>((_, reject) => {
      child.once("error", reject);
    });
    const timer = setTimeout(() => {
      killProcessTree(child, "SIGTERM");
      resolve({ ok: false, message: "ACP initialize timeout" });
    }, timeoutMs);

    (async () => {
      try {
        const app = client({ name: "feishu-code-bridge" });
        const stream = childToStream(child);
        const connection = app.connect(stream);
        const init = await Promise.race([
          connection.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "feishu-code-bridge", version: "0.1.0" },
          }),
          spawnError,
        ]);
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
        if (!child.killed) killProcessTree(child, "SIGTERM");
      }
    })();
  });
}
