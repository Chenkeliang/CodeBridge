import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  client,
  type ClientConnection,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type {
  BackendConfigOption,
  BackendProfile,
} from "@codebridge/core";
import type {
  CliSessionSummary,
  ProviderSessionHistoryEvent,
} from "../session-discovery.js";
import { killProcessTree } from "./acp-kill.js";
import { acpContinueMethod, resolveAcpSpawn } from "./acp-spawn-profiles.js";
import { mapSessionConfigOptions } from "./acp-config-options.js";
import { mapSessionUpdate } from "./acp-event-mapper.js";
import { ACP_CLIENT_CAPABILITIES } from "./headless-client.js";
import { raceWithAbort } from "./acp-race.js";

const ACP_SESSION_DELETE_TIMEOUT_MS = 30_000;

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
  op: (
    agent: ClientConnection["agent"],
    initializeResponse: InitializeResponse,
  ) => Promise<T>,
  onSessionUpdate?: (sessionId: string, update: SessionUpdate) => void,
  timeoutMs = 60_000,
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
  const app = client({ name: "codebridge" }).onNotification(
    methods.client.session.update,
    ({ params }) => onSessionUpdate?.(params.sessionId, params.update),
  );
  const stream = childToStream(child);
  const connection = app.connect(stream);
  try {
    const initializeResponse = await raceWithAbort(
      Promise.race([
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: ACP_CLIENT_CAPABILITIES,
          clientInfo: { name: "codebridge", version: "0.1.0" },
        }),
        spawnError,
      ]),
      () => false,
      timeoutMs,
      "ACP initialize timeout",
    );
    return await raceWithAbort(
      Promise.race([op(connection.agent, initializeResponse), spawnError]),
      () => false,
      timeoutMs,
      "ACP operation timeout",
    );
  } finally {
    connection.close();
    if (!child.killed) killProcessTree(child, "SIGTERM");
  }
}

export function collectAcpSessionHistory(
  updates: Array<{ sessionId: string; update: SessionUpdate }>,
): ProviderSessionHistoryEvent[] {
  const result: ProviderSessionHistoryEvent[] = [];
  let previousUserMessageId: string | null | undefined;
  for (const { update } of updates) {
    if (update.sessionUpdate === "user_message_chunk") {
      const text = textFromContent(update.content);
      if (!text) continue;
      const previous = result.at(-1);
      if (previous?.kind === "message" && previousUserMessageId === update.messageId) previous.text += text;
      else result.push({ kind: "message", text });
      previousUserMessageId = update.messageId;
      continue;
    }
    previousUserMessageId = undefined;
    for (const event of mapSessionUpdate(update)) {
      result.push({ kind: "agent_event", event });
    }
  }
  return result;
}

function textFromContent(content: { type: string; text?: string }): string | undefined {
  return content.type === "text" && typeof content.text === "string" ? content.text : undefined;
}

export async function loadAcpSessionHistory(
  backendId: string,
  profile: BackendProfile,
  cwd: string,
  sessionId: string,
  options?: { additionalDirectories?: string[] },
): Promise<ProviderSessionHistoryEvent[]> {
  const updates: Array<{ sessionId: string; update: SessionUpdate }> = [];
  await withAcpConnection(
    profile,
    cwd,
    async (agent) => {
      const params = {
        sessionId,
        cwd,
        ...(options?.additionalDirectories?.length
          ? { additionalDirectories: options.additionalDirectories }
          : {}),
        mcpServers: [] as [],
      };
      const method =
        acpContinueMethod(profile) === "session/load"
          ? methods.agent.session.load
          : methods.agent.session.resume;
      await raceWithAbort(
        agent.request(method, params),
        () => false,
        60_000,
        `ACP session history load timeout for ${backendId}`,
      );
    },
    (notificationSessionId, update) => {
      if (notificationSessionId === sessionId) updates.push({ sessionId: notificationSessionId, update });
    },
    15_000,
  );
  return collectAcpSessionHistory(updates);
}

export function hasAcpSessionCapability(
  response: unknown,
  capability: "close" | "delete" | "resume",
): boolean {
  const sessionCapabilities = (response as {
    agentCapabilities?: {
      sessionCapabilities?: Record<string, unknown> | null;
    } | null;
  })?.agentCapabilities?.sessionCapabilities;
  return sessionCapabilities?.[capability] != null;
}

export async function deleteAcpSession(
  profile: BackendProfile,
  cwd: string,
  sessionId: string,
  timeoutMs = ACP_SESSION_DELETE_TIMEOUT_MS,
): Promise<void> {
  return withAcpConnection(profile, cwd, async (agent, initializeResponse) => {
    if (!hasAcpSessionCapability(initializeResponse, "delete")) {
      throw new Error("ACP agent 未声明 session/delete 支持");
    }
    await raceWithAbort(
      agent.request(methods.agent.session.delete, { sessionId }),
      () => false,
      timeoutMs,
      "ACP session/delete 超时",
    );
  });
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
      ...(session.additionalDirectories?.length
        ? { additionalDirectories: session.additionalDirectories }
        : {}),
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
        const app = client({ name: "codebridge" });
        const stream = childToStream(child);
        const connection = app.connect(stream);
        const init = await Promise.race([
          connection.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: ACP_CLIENT_CAPABILITIES,
            clientInfo: { name: "codebridge", version: "0.1.0" },
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
