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
  response?: unknown,
): ActiveSession {
  const attach = (
    agent as unknown as {
      attachSession: (response: { sessionId: string }) => ActiveSession;
    }
  ).attachSession;
  if (typeof attach !== "function") {
    throw new Error("ACP SDK 缺少 attachSession，无法续聊");
  }
  // claude 的 session/resume 会回传 configOptions（实测 keys: sessionId/modes/configOptions）。
  // 用完整响应 attach，让 newSessionResponse.configOptions 非空、与新建会话对称，后续
  // applySessionConfigOptions 才能在续聊时重设 model/effort/permission（续聊到新适配器进程
  // model 会退回默认）。cursor 的 session/load 响应为空则退回仅带 sessionId。
  const full =
    response && typeof response === "object" && "configOptions" in response
      ? { ...(response as Record<string, unknown>), sessionId }
      : { sessionId };
  return attach.call(agent, full);
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
    const response = await raceWithAbort(
      agent.request(loadMethod, params),
      isAborted,
      loadTimeoutMs,
      "ACP session 续聊超时",
    );
    return attachActiveSession(agent, sessionId, response);
  } catch (err) {
    if (isAborted()) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    options.onResumeFallback?.(reason);
    return startNewSession();
  }
}
