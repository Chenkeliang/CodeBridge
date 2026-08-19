import fs from "node:fs/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentAvailableCommand,
  AgentEvent,
  BackendConfigOption,
  RunContext,
} from "@codebridge/core";
import type {
  CliSessionSummary,
  ProviderSessionHistoryEvent,
} from "./session-discovery.js";

/** The small native-session surface used by the runner and by adapter tests. */
export interface PiSession {
  readonly sessionId: string;
  readonly sessionFile?: string;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string, options?: { images?: unknown[] }): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  /** Kill in-flight bash process groups. Native AgentSession has this; abort() does not call it. */
  abortBash?: () => void;
  dispose(): void;
}

/** Match ACP's SIGKILL upgrade delay: abort() waits for idle and can hang on live bash. */
const PI_ABORT_SETTLE_MS = 2_000;

function abortPiSession(session: PiSession): Promise<void> {
  session.abortBash?.();
  return Promise.race([
    session.abort().then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, PI_ABORT_SETTLE_MS).unref();
    }),
  ]);
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
  sessionId?: string;
  cwd?: string;
  title?: string | null;
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
    willRetry?: boolean;
    messages?: Array<{
      role?: string;
      stopReason?: string;
      errorMessage?: string;
    }>;
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

  if (value.type === "agent_end" && value.willRetry === false) {
    const assistant = [...(value.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant");
    if (assistant?.stopReason === "error") {
      return [{
        type: "error",
        message: assistant.errorMessage || "Pi model request failed without an error message",
        fatal: true,
      }];
    }
  }

  // Provider/transport failures must surface as real error events instead of
  // silently ending the run (auto-retry exhaustion carries the final error).
  if (value.type === "auto_retry_end") {
    const retry = value as { success?: boolean; finalError?: string };
    if (retry.success === false && retry.finalError) {
      return [{ type: "error", message: retry.finalError, fatal: true }];
    }
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
  const seenErrors = new Set<string>();
  let sawOutput = false;
  let sawError = false;
  const notify = () => {
    const current = wake;
    wake = undefined;
    current?.();
  };
  const unsubscribe = session.subscribe((event) => {
    for (const mapped of mapPiEvent(event)) {
      if (mapped.type === "error") {
        if (seenErrors.has(mapped.message)) continue;
        seenErrors.add(mapped.message);
        sawError = true;
      } else {
        sawOutput = true;
      }
      pending.push(mapped);
    }
    notify();
  });
  let aborting: Promise<void> | undefined;
  const handle: PiRunHandle = {
    cancel: () => {
      aborting ??= abortPiSession(session);
      return aborting;
    },
    steer: (prompt) => session.steer(prompt),
  };
  if (handleRef) handleRef.current = handle;

  try {
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
    } else if (!options.isAborted()) {
      if (!sawOutput && !sawError) {
        yield {
          type: "error",
          message: "Pi run completed without assistant output or a provider error",
          fatal: true,
        };
      } else {
        yield { type: "session", sessionId: session.sessionId };
      }
    }
  } finally {
    unsubscribe();
    if (options.isAborted() && !finished) {
      await (aborting ?? abortPiSession(session));
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

export async function loadPiSessionHistory(
  cwd: string,
  sessionId: string,
): Promise<ProviderSessionHistoryEvent[]> {
  const match = await findPiSession(cwd, sessionId);
  if (!match) throw new Error(`Pi session not found in ${cwd}: ${sessionId}`);
  const manager = SessionManager.open(match.path, undefined, cwd);
  return collectPiSessionHistory(manager.getBranch());
}

export function collectPiSessionHistory(entries: unknown[]): ProviderSessionHistoryEvent[] {
  const result: ProviderSessionHistoryEvent[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") continue;
    const value = entry as { id?: unknown; message?: unknown };
    const message = value.message as {
      role?: string;
      content?: unknown;
      toolCallId?: string;
      isError?: boolean;
    } | undefined;
    if (!message) continue;
    if (message.role === "user") {
      const text = textFromPiContent(message.content);
      if (text) result.push({ kind: "message", text });
    } else if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [message.content];
      for (const block of blocks) {
        if (typeof block === "string" && block) {
          result.push({
            kind: "agent_event",
            event: { type: "text_delta", text: block, ...(typeof value.id === "string" ? { messageId: value.id } : {}) },
          });
          continue;
        }
        if (!block || typeof block !== "object") continue;
        const content = block as { type?: string; text?: string; thinking?: string };
        if (content.type === "thinking" && content.thinking) {
          result.push({ kind: "agent_event", event: { type: "thought_delta", text: content.thinking } });
        } else if (content.type === "text" && content.text) {
          result.push({
            kind: "agent_event",
            event: { type: "text_delta", text: content.text, ...(typeof value.id === "string" ? { messageId: value.id } : {}) },
          });
        }
      }
    } else if (message.role === "toolResult") {
      const text = textFromPiContent(message.content);
      if (!text) continue;
      result.push({
        kind: "agent_event",
        event: {
          type: "tool_end",
          toolCallId: message.toolCallId,
          status: message.isError ? "failed" : "completed",
          output: text,
        },
      });
    }
  }
  return result;
}

function textFromPiContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const value = block as { type?: string; text?: string; thinking?: string };
      if (value.type === "text" && typeof value.text === "string") return value.text;
      if (value.type === "thinking" && typeof value.thinking === "string") return value.thinking;
      return "";
    })
    .join("");
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

const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const LEVEL_LABEL: Record<string, string> = {
  off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max",
};

type PiModelLike = {
  provider: string;
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null | undefined>;
};

type PiConfigRuntime = {
  getModels: () => PiModelLike[];
  hasConfiguredAuth: (provider: string) => boolean;
  getModel?: (provider: string, modelId: string) => PiModelLike | undefined;
};

/** Thinking levels supported by a specific model: keys of thinkingLevelMap
 *  with a non-null mapping, in canonical order. Falls back to all levels for
 *  reasoning models without a map; empty for non-reasoning models. */
export function piThinkingLevelsForModel(model: Pick<PiModelLike, "reasoning" | "thinkingLevelMap"> | undefined | null): string[] {
  if (model && model.reasoning === false) return [];
  const map = model?.thinkingLevelMap;
  if (!map) return [...ALL_THINKING_LEVELS];
  const levels = ALL_THINKING_LEVELS.filter((level) => typeof map[level] === "string" && map[level]);
  return levels.length ? levels : [...ALL_THINKING_LEVELS];
}

export async function listPiConfigOptions(
  runtime?: PiConfigRuntime,
  currentModel?: string | null,
): Promise<BackendConfigOption[]> {
  const activeRuntime = runtime ?? await createPiModelRuntime();
  const values = activeRuntime.getModels()
    .filter((model) => activeRuntime.hasConfiguredAuth(model.provider))
    .map((model) => ({
    value: `${model.provider}/${model.id}`,
    name: model.name,
    description: model.api,
    }));

  // Derive the thinking-level control from the *selected* model's declared
  // capabilities: hidden for non-reasoning models, restricted to the mapped
  // levels otherwise (docs/orchestration/agent-providers.md §2.6).
  let selected: PiModelLike | undefined;
  if (currentModel && activeRuntime.getModel) {
    const separator = currentModel.includes("/") ? "/" : ":";
    const [provider, ...rest] = currentModel.split(separator);
    if (provider && rest.length) selected = activeRuntime.getModel(provider, rest.join(separator)) as PiModelLike | undefined;
  }
  const levels = piThinkingLevelsForModel(selected);

  // Surface Pi's configured defaults so "Agent 默认" shows what it resolves to
  // (settings.json defaultProvider/defaultModel/defaultThinkingLevel).
  let defaultModelValue: string | undefined;
  let defaultThinkingLevel: string | undefined;
  if (!runtime) {
    const settings = SettingsManager.create(process.cwd(), getAgentDir());
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    if (provider && modelId && values.some((v) => v.value === `${provider}/${modelId}`)) {
      defaultModelValue = `${provider}/${modelId}`;
    }
    const thinking = settings.getDefaultThinkingLevel();
    if (thinking && levels.includes(thinking)) defaultThinkingLevel = thinking;
  }

  return [
    ...(values.length ? [{
      id: "model",
      name: "Model",
      type: "select" as const,
      category: "model",
      values,
      currentValue: defaultModelValue,
    }] : []),
    ...(levels.length ? [{
      id: "thinking_level",
      name: "Reasoning",
      type: "select" as const,
      category: "thought_level",
      values: levels.map((value) => ({ value, name: LEVEL_LABEL[value] ?? value })),
      currentValue: defaultThinkingLevel,
    }] : []),
  ];
}

export async function listPiCommands(cwd: string): Promise<AgentAvailableCommand[]> {
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
  });
  await loader.reload();
  const result = loader.getSkills();
  return result.skills.map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description,
  }));
}

export async function closePiSession(
  cwd: string,
  sessionId: string,
): Promise<PiSessionLifecycleResult> {
  const session = await findPiSession(cwd, sessionId);
  return session ? { ok: true } : { ok: false, error: "Pi session not found" };
}

export async function forkPiSession(
  sourceCwd: string,
  sessionId: string,
  targetCwd: string,
): Promise<PiSessionLifecycleResult> {
  const source = await findPiSession(sourceCwd, sessionId);
  if (!source) return { ok: false, error: "Pi session not found" };
  const fork = SessionManager.forkFrom(source.path, targetCwd);
  return {
    ok: true,
    sessionId: fork.getSessionId(),
    cwd: targetCwd,
    title: source.name ?? (source.firstMessage || null),
  };
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
  const modelRuntime = await createPiModelRuntime();
  const sessionManager = await resolvePiSessionManager(ctx);
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

export async function resolvePiSessionManager(ctx: RunContext): Promise<SessionManager> {
  if (!ctx.resumeSessionId) return SessionManager.create(ctx.cwd);
  const sessions = await SessionManager.list(ctx.cwd);
  const match = sessions.find((session) => session.id === ctx.resumeSessionId);
  if (!match) return SessionManager.create(ctx.cwd);
  return SessionManager.open(match.path, undefined, ctx.cwd);
}

export function createPiModelRuntime(options: {
  authPath?: string;
  modelsPath?: string | null;
} = {}): Promise<ModelRuntime> {
  return ModelRuntime.create({ ...options, allowModelNetwork: false });
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
