import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  client,
  type ClientCapabilities,
  type ClientConnection,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type {
  BackendConfigOption,
  BackendProfile,
  SessionCompactionResult,
} from "@codebridge/core";
import { ACP_CODEX_ACP_VERSION } from "@codebridge/core";
import { parseGoalAction, parseSessionGoalObservation, type NativeSessionCommand } from "@codebridge/core/native-session-command";
import type {
  CliSessionSummary,
  ProviderSessionHistoryEvent,
} from "../session-discovery.js";
import { killProcessTree } from "./acp-kill.js";
import { acpContinueMethod, resolveAcpSpawn } from "./acp-spawn-profiles.js";
import { applySessionConfigOptions, mapSessionConfigOptions, resolveCustomSessionConfig } from "./acp-config-options.js";
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
  clientCapabilities: ClientCapabilities = ACP_CLIENT_CAPABILITIES,
  isAborted: () => boolean = () => false,
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
  child.stderr?.resume();
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
          clientCapabilities,
          clientInfo: { name: "codebridge", version: "0.1.0" },
        }),
        spawnError,
      ]),
      isAborted,
      timeoutMs,
      "ACP initialize timeout",
    );
    return await raceWithAbort(
      Promise.race([op(connection.agent, initializeResponse), spawnError]),
      isAborted,
      timeoutMs,
      "ACP operation timeout",
    );
  } finally {
    connection.close();
    if (!child.killed) killProcessTree(child, "SIGTERM");
  }
}

export async function compactCodexSession(
  profile: BackendProfile,
  cwd: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<SessionCompactionResult> {
  const observed = new Map<string, string>();
  let advertised = false;
  let receiveCommands: () => void = () => {};
  const commandsPublished = new Promise<void>((resolve) => { receiveCommands = resolve; });
  let sent = false;
  return withAcpConnection(profile, cwd, async (agent, init) => {
    if (init.agentInfo?.name !== "@agentclientprotocol/codex-acp" || init.agentInfo.version !== ACP_CODEX_ACP_VERSION
      || !init.agentCapabilities?.sessionCapabilities?.resume) {
      return { status: "rejected", reason: "unsupported" };
    }
    await agent.request(methods.agent.session.resume, { sessionId, cwd, mcpServers: [] });
    try {
      await raceWithAbort(commandsPublished, () => signal.aborted, 5_000, "Codex commands unavailable");
    } catch {
      return { status: "rejected", reason: "unsupported" };
    }
    if (!advertised || signal.aborted) return { status: "rejected", reason: "unsupported" };
    sent = true;
    const response = await agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "/compact" }] });
    if (observed.size !== 1 || signal.aborted) return { status: "unknown" };
    const status = observed.values().next().value;
    if (status === "cancelled" || response.stopReason === "cancelled") return { status: "rejected", reason: "cancelled" };
    if (status === "failed") return { status: "rejected", reason: "failed" };
    return { status: status === "completed" && response.stopReason === "end_turn" ? "completed" : "unknown" };
  }, (source, update) => {
    if (source !== sessionId) return;
    if (!sent && update.sessionUpdate === "available_commands_update") {
      advertised = update.availableCommands.filter((command) => command.name === "compact").length === 1;
      receiveCommands();
    }
    if (!sent || update.sessionUpdate !== "compaction_update" || !update.compactionId) return;
    if (update.status === "in_progress" && !observed.has(update.compactionId)) {
      observed.set(update.compactionId, update.status);
    } else if (observed.get(update.compactionId) === "in_progress") {
      observed.set(update.compactionId, update.status);
    }
  }, 90_000, { ...ACP_CLIENT_CAPABILITIES, session: { ...ACP_CLIENT_CAPABILITIES.session, compaction: {} } }, () => signal.aborted);
}

export async function probeCodexCompactionSupport(profile: BackendProfile, cwd: string): Promise<boolean> {
  return withAcpConnection(profile, cwd, async (_agent, init) => {
    const goal = init._meta?.goal as { version?: unknown; controlMethod?: unknown; actions?: unknown } | undefined;
    const actions = goal?.actions;
    return init.agentInfo?.name === "@agentclientprotocol/codex-acp" && init.agentInfo.version === ACP_CODEX_ACP_VERSION
      && Boolean(init.agentCapabilities?.sessionCapabilities?.resume) && goal?.version === 1 && goal.controlMethod === "_session/goal"
      && Array.isArray(actions) && ["set", "pause", "resume", "clear"].every((action) => actions.includes(action));
  }, undefined, 20_000);
}

export async function runCodexNativeSessionCommand(
  profile: BackendProfile,
  cwd: string,
  sessionId: string,
  command: Exclude<NativeSessionCommand, "compact">,
  instructions: string,
  signal: AbortSignal,
): Promise<SessionCompactionResult> {
  const goalAction = command === "goal" ? parseGoalAction(instructions) : null;
  const argument = instructions.trim();
  if ((command === "goal" && !goalAction) || (command === "review-branch" && !/^[a-z\d][a-z\d._/-]*$/i.test(argument))
    || (command === "review-commit" && !/^[\da-f]{7,64}$/i.test(argument))) {
    return { status: "rejected", reason: "invalid_arguments" };
  }
  let advertised = false;
  let sent = false;
  let goalChanged = false;
  let goal: unknown;
  let goalSeen = false;
  let output = "";
  let publishCommands: () => void = () => {};
  const commands = new Promise<void>((resolve) => { publishCommands = resolve; });
  let publishGoal: () => void = () => {};
  const initialGoal = new Promise<void>((resolve) => { publishGoal = resolve; });
  return withAcpConnection(profile, cwd, async (agent, init) => {
    if (init.agentInfo?.name !== "@agentclientprotocol/codex-acp" || init.agentInfo.version !== ACP_CODEX_ACP_VERSION
      || !init.agentCapabilities?.sessionCapabilities?.resume) return { status: "rejected", reason: "unsupported" };
    const goalProtocol = init._meta?.goal as { version?: unknown; controlMethod?: unknown; actions?: unknown } | undefined;
    if (goalAction && (goalProtocol?.version !== 1 || goalProtocol.controlMethod !== "_session/goal"
      || !Array.isArray(goalProtocol.actions) || !goalProtocol.actions.includes(goalAction.action))) {
      return { status: "rejected", reason: "unsupported" };
    }
    await agent.request(methods.agent.session.resume, { sessionId, cwd, mcpServers: [] });
    try {
      await raceWithAbort(Promise.all(goalAction ? [commands, initialGoal] : [commands]),
        () => signal.aborted, 5_000, "Codex command or goal state unavailable");
    } catch {
      return { status: "rejected", reason: "unsupported" };
    }
    if (!advertised || signal.aborted) return { status: "rejected", reason: "unsupported" };
    sent = true;
    if (goalAction?.action === "pause" || goalAction?.action === "clear") {
      await agent.request("_session/goal", { sessionId, ...goalAction });
    } else {
      // For set/resume the native prompt wrapper waits for any inline continuation.
      const value = goalAction?.action === "set" ? goalAction.objective : goalAction?.action ?? instructions;
      const response = await agent.request(methods.agent.session.prompt, { sessionId,
        prompt: [{ type: "text", text: value ? `/${command} ${value}` : `/${command}` }] });
      if (response.stopReason === "cancelled") return { status: "rejected", reason: "cancelled" };
      if (response.stopReason !== "end_turn" || signal.aborted) return { status: "unknown" };
    }
    if (!goalAction) return output.trim() ? { status: "completed", output: output.trim(), observedAt: new Date().toISOString() } : { status: "unknown" };
    const snapshot = parseSessionGoalObservation(goal);
    const actual = goal as { objective?: unknown } | null | undefined;
    const matches = goalAction.action === "clear" ? goalSeen && snapshot === null
      : goalAction.action === "pause" ? snapshot?.status === "paused"
        : goalAction.action === "resume" ? goalChanged && Boolean(snapshot && snapshot.status !== "paused")
          : goalChanged && Boolean(snapshot && actual?.objective === (goalAction as { objective: string }).objective);
    return matches ? { status: "completed", goal: snapshot, observedAt: new Date().toISOString() } : { status: "unknown" };
  }, (source, update) => {
    if (source !== sessionId) return;
    if (!sent && update.sessionUpdate === "available_commands_update") {
      advertised = update.availableCommands.filter((item) => item.name === command).length === 1;
      publishCommands();
    }
    if (goalAction && update.sessionUpdate === "session_info_update" && update._meta && Object.hasOwn(update._meta, "goal")) {
      goalSeen = true;
      goal = update._meta.goal;
      if (sent) goalChanged = true;
      else publishGoal();
    }
    if (sent && !goalAction && update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && output.length < 16000) {
      output += update.content.text.slice(0, 16000 - output.length);
    }
  }, 105_000, ACP_CLIENT_CAPABILITIES, () => signal.aborted);
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
      try {
        const { custom, requiredConfigIds } = resolveCustomSessionConfig(profile);
        const result = await applySessionConfigOptions(agent, active.sessionId,
          active.newSessionResponse.configOptions ?? [], {}, custom, requiredConfigIds);
        return mapSessionConfigOptions(result.configOptions);
      } finally {
        active.dispose();
      }
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
