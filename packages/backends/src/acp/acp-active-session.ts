import {
  methods,
  type ActiveSession,
  type ClientConnection,
} from "@agentclientprotocol/sdk";
import type { BackendProfile, RunContext } from "@feishu-code-bridge/core";
import { acpContinueMethod } from "./acp-spawn-profiles.js";
import { raceWithAbort } from "./acp-race.js";

export const ACP_LOAD_TIMEOUT_MS = 60_000;

export interface OpenActiveSessionOptions {
  isAborted?: () => boolean;
  loadTimeoutMs?: number;
  /** 续聊失败静默回退新会话前的通知钩子，避免用户无感丢失上下文 */
  onResumeFallback?: (reason: string) => void;
}

function attachActiveSession(
  agent: ClientConnection["agent"],
  sessionId: string,
): ActiveSession {
  const attach = (
    agent as unknown as {
      attachSession: (response: { sessionId: string }) => ActiveSession;
    }
  ).attachSession;
  if (typeof attach !== "function") {
    throw new Error("ACP SDK 缺少 attachSession，无法续聊");
  }
  return attach.call(agent, { sessionId });
}

/** 与 Zed 一致：new / load / resume 后均使用 ActiveSession */
export async function openActiveSession(
  connection: ClientConnection,
  ctx: RunContext,
  backendConfig: BackendProfile,
  options: OpenActiveSessionOptions = {},
): Promise<ActiveSession> {
  const agent = connection.agent;
  const isAborted = options.isAborted ?? (() => false);
  const loadTimeoutMs = options.loadTimeoutMs ?? ACP_LOAD_TIMEOUT_MS;

  const startNewSession = () =>
    raceWithAbort(
      agent.buildSession(ctx.cwd).start(),
      isAborted,
      loadTimeoutMs,
      "ACP session 创建超时",
    );

  if (!ctx.resumeSessionId) {
    return startNewSession();
  }

  const sessionId = ctx.resumeSessionId;
  const params = {
    sessionId,
    cwd: ctx.cwd,
    mcpServers: [] as [],
  };

  try {
    const loadMethod =
      acpContinueMethod(backendConfig) === "session/load"
        ? methods.agent.session.load
        : methods.agent.session.resume;
    await raceWithAbort(
      agent.request(loadMethod, params),
      isAborted,
      loadTimeoutMs,
      "ACP session 续聊超时",
    );
    return attachActiveSession(agent, sessionId);
  } catch (err) {
    if (isAborted()) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    options.onResumeFallback?.(reason);
    return startNewSession();
  }
}
