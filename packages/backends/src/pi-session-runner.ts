import fs from "node:fs/promises";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentEvent, BackendConfigOption, RunContext } from "@codebridge/core";
import type { CliSessionSummary } from "./session-discovery.js";

/** The small native-session surface used by the runner and by adapter tests. */
export interface PiSession {
  readonly sessionId: string;
  readonly sessionFile?: string;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string, options?: { images?: unknown[] }): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export interface PiRunHandle {
  cancel(): Promise<void>;
  steer(prompt: string): Promise<unknown>;
}

export interface PiRunHandleRef {
  current?: PiRunHandle;
}

export interface PiSessionRunnerOptions {
  isAborted: () => boolean;
  handleRef?: PiRunHandleRef;
  createSession?: (ctx: RunContext) => Promise<PiSession>;
}

export interface PiSessionLifecycleResult {
  ok: boolean;
  error?: string;
}

/** Map Pi's event stream to CodeBridge's provider-neutral event contract. */
export function mapPiEvent(event: unknown): AgentEvent[] {
  const value = event as {
    type?: string;
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    partialResult?: unknown;
    result?: unknown;
    isError?: boolean;
    assistantMessageEvent?: { type?: string; delta?: string };
  };

  if (value.type === "message_update") {
    const update = value.assistantMessageEvent;
    if (update?.type === "text_delta" && update.delta) {
      return [{ type: "text_delta", text: update.delta }];
    }
    if (update?.type === "thinking_delta" && update.delta) {
      return [{ type: "thought_delta", text: update.delta }];
    }
    return [];
  }

  if (value.type === "tool_execution_start") {
    return [
      {
        type: "tool_start",
        toolCallId: value.toolCallId,
        name: value.toolName ?? "tool",
        input: value.args,
      },
    ];
  }

  if (value.type === "tool_execution_update") {
    return [
      {
        type: "tool_update",
        toolCallId: value.toolCallId ?? "unknown-tool-call",
        name: value.toolName,
        status: "running",
        output: value.partialResult,
      },
    ];
  }

  if (value.type === "tool_execution_end") {
    return [
      {
        type: "tool_end",
        toolCallId: value.toolCallId,
        name: value.toolName,
        status: value.isError ? "failed" : "completed",
        output: value.result,
      },
    ];
  }

  return [];
}

/** Execute one prompt on a native Pi AgentSession. */
export async function* runPiSession(
  ctx: RunContext,
  options: PiSessionRunnerOptions,
): AsyncGenerator<AgentEvent> {
  const session = await (options.createSession?.(ctx) ?? createNativePiSession(ctx));
  const handleRef = options.handleRef;
  let wake: (() => void) | undefined;
  let finished = false;
  let promptError: unknown;
  const pending: AgentEvent[] = [];
  const notify = () => {
    const current = wake;
    wake = undefined;
    current?.();
  };
  const unsubscribe = session.subscribe((event) => {
    pending.push(...mapPiEvent(event));
    notify();
  });
  const handle: PiRunHandle = {
    cancel: () => session.abort(),
    steer: (prompt) => session.steer(prompt),
  };
  if (handleRef) handleRef.current = handle;

  try {
    yield { type: "session", sessionId: session.sessionId };
    const prompt = await buildPrompt(ctx);
    const promptPromise = session
      .prompt(prompt.text, prompt.options)
      .catch((error: unknown) => {
        promptError = error;
      })
      .finally(() => {
        finished = true;
        notify();
      });

    while (!finished || pending.length > 0) {
      if (pending.length > 0) {
        yield pending.shift()!;
        continue;
      }
      if (options.isAborted()) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    if (!options.isAborted()) await promptPromise;
    if (promptError !== undefined && !options.isAborted()) {
      yield {
        type: "error",
        message: promptError instanceof Error ? promptError.message : String(promptError),
        fatal: true,
      };
    }
  } finally {
    unsubscribe();
    if (options.isAborted() && !finished) {
      await session.abort().catch(() => {});
    }
    session.dispose();
    if (handleRef?.current === handle) handleRef.current = undefined;
  }
}

export async function listPiSessions(
  backendId: string,
  cwd: string,
  options?: { limit?: number },
): Promise<CliSessionSummary[]> {
  const sessions = await SessionManager.list(cwd);
  return sessions
    .map((session) => ({
      id: session.id,
      backend: backendId,
      cwd: session.cwd || cwd,
      preview: session.firstMessage || "(no preview)",
      updatedAt: session.modified.toISOString(),
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, options?.limit ?? 20);
}

export async function probePiSdk(
  cwd: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    await SessionManager.list(cwd);
    return { ok: true, message: "Pi SDK available" };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listPiConfigOptions(): Promise<BackendConfigOption[]> {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  const values = runtime.getModels().map((model) => ({
    value: `${model.provider}/${model.id}`,
    name: model.name,
    description: model.api,
  }));
  return values.length
    ? [
        {
          id: "model",
          name: "Model",
          type: "select",
          category: "model",
          values,
        },
      ]
    : [];
}

export async function closePiSession(
  cwd: string,
  sessionId: string,
): Promise<PiSessionLifecycleResult> {
  const session = await findPiSession(cwd, sessionId);
  return session ? { ok: true } : { ok: false, error: "Pi session not found" };
}

export async function deletePiSession(
  cwd: string,
  sessionId: string,
): Promise<PiSessionLifecycleResult> {
  const session = await findPiSession(cwd, sessionId);
  if (!session) return { ok: false, error: "Pi session not found" };
  await fs.rm(session.path, { force: true });
  return { ok: true };
}

async function createNativePiSession(ctx: RunContext): Promise<PiSession> {
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
  const sessionManager = await resolveSessionManager(ctx);
  const model = resolveModel(modelRuntime, ctx.backendConfig.model ?? ctx.model);
  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    sessionManager,
    model,
    thinkingLevel: resolveThinkingLevel(ctx.effort),
    modelRuntime,
  });
  return session;
}

async function resolveSessionManager(ctx: RunContext): Promise<SessionManager> {
  if (!ctx.resumeSessionId) return SessionManager.create(ctx.cwd);
  const sessions = await SessionManager.list(ctx.cwd);
  const match = sessions.find((session) => session.id === ctx.resumeSessionId);
  if (!match) {
    throw new Error(`Pi session not found in ${ctx.cwd}: ${ctx.resumeSessionId}`);
  }
  return SessionManager.open(match.path, undefined, ctx.cwd);
}

function resolveModel(runtime: ModelRuntime, raw: string | undefined) {
  if (!raw) return undefined;
  const separator = raw.includes("/") ? "/" : ":";
  const [provider, ...modelParts] = raw.split(separator);
  const modelId = modelParts.join(separator);
  if (!provider || !modelId) {
    throw new Error(`Pi model must use provider/model format: ${raw}`);
  }
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error(`Pi model is not available: ${raw}`);
  return model;
}

async function findPiSession(cwd: string, sessionId: string) {
  const sessions = await SessionManager.list(cwd);
  return sessions.find((session) => session.id === sessionId);
}

function resolveThinkingLevel(raw: string | undefined) {
  const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  return raw && levels.has(raw)
    ? (raw as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
    : undefined;
}

async function buildPrompt(ctx: RunContext): Promise<{
  text: string;
  options?: { images?: unknown[] };
}> {
  if (!ctx.attachments?.length) return { text: ctx.prompt };
  const images = await Promise.all(
    ctx.attachments.map(async (attachment) => ({
      type: "image",
      source: {
        type: "base64",
        mediaType: attachment.mimeType ?? "image/png",
        data: await fs.readFile(attachment.path, "base64"),
      },
    })),
  );
  return { text: ctx.prompt, options: { images } };
}
