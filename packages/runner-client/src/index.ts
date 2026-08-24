import type {
  AgentAvailableCommand,
  AgentEvent,
  BackendConfigOption,
  RunRequest,
} from "@codebridge/core";
import type {
  AgentSetupInstallResult,
  AgentSetupRecord,
  CliSessionSummary,
  ProviderSessionHistoryEvent,
  SkillAgentId,
  SkillCatalogSnapshot,
  SkillMutationPlan,
  SkillMutationResult,
} from "@codebridge/backends";

export interface RunnerClientOptions {
  baseUrl: string;
  token: string;
  directoryAuthorizationTimeoutMs?: number;
  sessionHistoryTimeoutMs?: number;
}

export type {
  CliSessionSummary,
  ProviderSessionHistoryEvent,
  SkillAgentId,
  SkillCatalogSnapshot,
  SkillMutationPlan,
  SkillMutationResult,
};

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  absolutePath: string;
  kind: "directory" | "file";
}

export interface WorkspaceDirectoryListing {
  ok: boolean;
  root?: string;
  path?: string;
  relativePath?: string;
  entries?: WorkspaceDirectoryEntry[];
  error?: string;
}

export interface AgentSetupListResponse {
  agents: AgentSetupRecord[];
  error?: string;
  message?: string;
  details?: string;
}

export class RunnerCancellationError extends Error {
  override readonly name = "RunnerCancellationError";
}

export class RunnerApiError extends Error {
  override readonly name = "RunnerApiError";

  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export class RunnerClient {
  constructor(private readonly options: RunnerClientOptions) {}

  async health(): Promise<{ ok: boolean; version?: string }> {
    const res = await this.fetch("/health");
    return res.json() as Promise<{ ok: boolean; version?: string }>;
  }

  async doctor(): Promise<unknown> {
    const res = await this.fetch("/doctor");
    return res.json();
  }

  async listSessions(
    backend: string,
    cwd: string,
    options?: { all?: boolean; limit?: number },
  ): Promise<{ sessions: CliSessionSummary[]; error?: string }> {
    const params = new URLSearchParams({
      backend,
      cwd,
      limit: String(options?.limit ?? 20),
    });
    if (options?.all) params.set("all", "true");
    const res = await this.fetch(`/sessions?${params}`);
    if (!res.ok) {
      throw new Error(`Runner error: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<{
      sessions: CliSessionSummary[];
      error?: string;
    }>;
  }

  async loadSessionHistory(
    backend: string,
    cwd: string,
    sessionId: string,
    additionalDirectories?: string[],
  ): Promise<ProviderSessionHistoryEvent[]> {
    const params = new URLSearchParams({ backend, cwd });
    if (additionalDirectories?.length) {
      params.set("additional_directories", JSON.stringify(additionalDirectories));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.sessionHistoryTimeoutMs ?? 20_000);
    timer.unref?.();
    try {
      const res = await this.fetch(
        `/sessions/${encodeURIComponent(sessionId)}/history?${params}`,
        { signal: controller.signal },
      );
      if (!res.ok) throw new Error(`Runner error: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { events?: ProviderSessionHistoryEvent[] };
      return body.events ?? [];
    } finally {
      clearTimeout(timer);
    }
  }

  async listConfigOptions(
    backend: string,
    cwd: string,
    model?: string | null,
  ): Promise<{ options: BackendConfigOption[]; error?: string }> {
    const params = new URLSearchParams({ backend, cwd });
    if (model) params.set("model", model);
    const res = await this.fetch(`/config-options?${params}`);
    if (!res.ok) {
      throw new Error(`Runner error: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<{
      options: BackendConfigOption[];
      error?: string;
    }>;
  }

  async listPiProviderPresets(): Promise<unknown> {
    const res = await this.fetch("/pi/providers/presets");
    if (!res.ok) throw new Error(`Runner error: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async listAgentSetup(): Promise<AgentSetupListResponse> {
    return this.requestSetup<AgentSetupListResponse>("/agents/setup");
  }

  async detectAgent(agentId: string): Promise<AgentSetupRecord> {
    return this.requestSetup<AgentSetupRecord>(`/agents/${encodeURIComponent(agentId)}/detect`, {
      method: "POST",
    });
  }

  async detectAllAgents(): Promise<AgentSetupListResponse> {
    return this.requestSetup<AgentSetupListResponse>("/agents/detect", { method: "POST" });
  }

  async installAgent(agentId: string, strategyId: string): Promise<AgentSetupInstallResult> {
    return this.requestSetup<AgentSetupInstallResult>(`/agents/${encodeURIComponent(agentId)}/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strategy_id: strategyId }),
    });
  }

  async listSkills(): Promise<SkillCatalogSnapshot> {
    return this.requestSetup<SkillCatalogSnapshot>("/skills");
  }

  async addSkillSource(sourcePath: string): Promise<SkillCatalogSnapshot> {
    return this.requestSetup<SkillCatalogSnapshot>("/skills/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: sourcePath }),
    });
  }

  async previewSkillAdopt(skillId: string, actorId: string): Promise<SkillMutationPlan> {
    return this.requestSetup<SkillMutationPlan>(
      `/skills/${encodeURIComponent(skillId)}/adopt/preview`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor_id: actorId }),
      },
    );
  }

  async previewSkillAssignment(input: {
    skill_id: string;
    agent_id: SkillAgentId;
    enabled: boolean;
    actor_id: string;
  }): Promise<SkillMutationPlan> {
    return this.requestSetup<SkillMutationPlan>("/skills/assignments/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async previewSkillGlobalState(input: {
    skill_id: string;
    enabled: boolean;
    actor_id: string;
  }): Promise<SkillMutationPlan> {
    return this.requestSetup<SkillMutationPlan>(
      `/skills/${encodeURIComponent(input.skill_id)}/global-state/preview`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: input.enabled, actor_id: input.actor_id }),
      },
    );
  }

  async previewSkillUnmanage(skillId: string, actorId: string): Promise<SkillMutationPlan> {
    return this.requestSetup<SkillMutationPlan>(
      `/skills/${encodeURIComponent(skillId)}/unmanage/preview`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor_id: actorId }),
      },
    );
  }

  async applySkillPlan(
    kind: "adopt" | "global-state" | "assignment" | "unmanage",
    planId: string,
    actorId: string,
  ): Promise<SkillMutationResult> {
    return this.requestSetup<SkillMutationResult>(
      `/skills/${kind}-plans/${encodeURIComponent(planId)}/apply`,
      {
      method: "POST",
      headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor_id: actorId }),
      },
    );
  }

  async listPiProviders(): Promise<unknown> {
    const res = await this.fetch("/pi/providers");
    if (!res.ok) throw new Error(`Runner error: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async savePiProviders(file: unknown): Promise<{ ok: boolean }> {
    const res = await this.fetch("/pi/providers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(file),
    });
    const payload = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[] };
    if (!res.ok) throw new Error(payload.issues?.join("; ") ?? payload.error ?? `Runner error: ${res.status}`);
    return { ok: true };
  }

  async testPiProvider(provider: { baseUrl: string; apiKey?: string; authHeader?: boolean; api?: string; model?: string }): Promise<{ ok: boolean; detail: string; compatSuggestion?: Record<string, unknown> }> {
    const res = await this.fetch("/pi/providers/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(provider),
    });
    if (!res.ok) throw new Error(`Runner error: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{ ok: boolean; detail: string; compatSuggestion?: Record<string, unknown> }>;
  }

  async listCommands(
    backend: string,
    cwd: string,
  ): Promise<{ commands: AgentAvailableCommand[]; error?: string }> {
    const params = new URLSearchParams({ backend, cwd });
    const res = await this.fetch(`/commands?${params}`);
    if (!res.ok) throw new Error(`Runner error: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{
      commands: AgentAvailableCommand[];
      error?: string;
    }>;
  }

  async authorizeDirectory(
    directory: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.directoryAuthorizationTimeoutMs ?? 45_000,
    );
    timer.unref?.();
    try {
      const res = await this.fetch("/directories/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: directory }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        path?: string;
        error?: string;
      };
      return {
        ok: res.ok && body.ok === true,
        path: body.path,
        error: body.error ?? (res.ok ? undefined : `Runner error: ${res.status}`),
      };
    } catch (err) {
      if (controller.signal.aborted) {
        return {
          ok: false,
          path: directory,
          error: "Runner 目录授权请求超时，请检查 macOS 系统弹窗或隐私与安全性设置。",
        };
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async listDirectory(root: string, relativePath = ""): Promise<WorkspaceDirectoryListing> {
    const params = new URLSearchParams({ root, path: relativePath });
    const res = await this.fetch(`/directories/list?${params}`);
    const body = await res.json() as WorkspaceDirectoryListing;
    if (!res.ok && !body.error) body.error = `Runner error: ${res.status}`;
    return body;
  }

  async pickDirectory(): Promise<{
    ok: boolean;
    path?: string;
    cancelled?: boolean;
    error?: string;
  }> {
    const res = await this.fetch("/directories/pick", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      path?: string;
      cancelled?: boolean;
      error?: string;
    };
    return {
      ok: res.ok && body.ok === true,
      path: body.path,
      cancelled: body.cancelled,
      error: body.error ?? (res.ok ? undefined : `Runner error: ${res.status}`),
    };
  }

  async closeSession(
    backend: string,
    cwd: string,
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.sessionLifecycle("close", backend, cwd, sessionId);
  }

  async deleteSession(
    backend: string,
    cwd: string,
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.sessionLifecycle("delete", backend, cwd, sessionId);
  }

  async forkSession(
    backend: string,
    cwd: string,
    sessionId: string,
    targetCwd: string,
  ): Promise<{ ok: boolean; sessionId?: string; cwd?: string; error?: string }> {
    const res = await this.fetch(`/sessions/${encodeURIComponent(sessionId)}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend, cwd, targetCwd }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      sessionId?: string;
      cwd?: string;
      error?: string;
    };
    return {
      ok: res.ok && body.ok === true,
      sessionId: body.sessionId,
      cwd: body.cwd,
      error: body.error ?? (res.ok ? undefined : `Runner error: ${res.status}`),
    };
  }

  async cancel(runId: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetch(`/runs/${runId}/cancel`, { method: "POST" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RunnerCancellationError(`Runner cancellation failed: ${message}`);
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
    if (!res.ok || body.ok !== true) {
      throw new RunnerCancellationError(`Runner cancellation failed: ${res.status}`);
    }
  }

  async steer(
    runId: string,
    prompt: string,
  ): Promise<{ ok: boolean; outcome?: string; error?: string }> {
    const res = await this.fetch(`/runs/${runId}/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      outcome?: string;
      error?: string;
    };
    return {
      ok: res.ok && body.ok === true,
      outcome: body.outcome,
      error: body.error ?? (res.ok ? undefined : `Runner error: ${res.status}`),
    };
  }

  /** prompt_feishu：回应 run 挂起的权限请求（/approve /deny） */
  async resolvePermission(runId: string, approve: boolean): Promise<boolean> {
    const res = await this.fetch(`/runs/${runId}/permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { resolved?: boolean };
    return body.resolved === true;
  }

  async *run(
    request: RunRequest,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<AgentEvent> {
    const signal = options?.signal;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    let cancelPromise: Promise<void> | undefined;
    const cancelRemote = () =>
      (cancelPromise ??= this.cancel(request.runId));
    const onAbort = () => {
      void cancelRemote().catch(() => {});
      void reader?.cancel().catch(() => {});
    };
    if (signal?.aborted) {
      await cancelRemote();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let res: Response;
      try {
        res = await this.fetch("/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) {
          await cancelRemote();
          return;
        }
        throw err;
      }
      if (!res.ok || !res.body) {
        throw new Error(`Runner error: ${res.status} ${await res.text()}`);
      }
      reader = res.body.getReader();
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        await cancelRemote();
        return;
      }
      while (true) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => {});
          break;
        }
        let done = false;
        let value: Uint8Array | undefined;
        try {
          ({ done, value } = await reader.read());
        } catch (err) {
          if (signal?.aborted) break;
          throw this.mapStreamError(err, sawDone);
        }
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          const event = JSON.parse(json) as AgentEvent;
          if (event.type === "done") sawDone = true;
          yield event;
        }
      }
      if (!sawDone && !signal?.aborted) {
        throw new Error(
          "Runner 连接意外断开（无完成信号）。请执行 `./scripts/start.sh stop && ./scripts/start.sh start` 重启服务后重试。",
        );
      }
    } finally {
      if (signal?.aborted) await cancelRemote();
      signal?.removeEventListener("abort", onAbort);
      reader?.releaseLock();
    }
  }

  private mapStreamError(err: unknown, sawDone: boolean): Error {
    if (sawDone) {
      return err instanceof Error ? err : new Error(String(err));
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message === "terminated" || message.includes("other side closed")) {
      return new Error(
        "Runner 连接意外断开（常见于 Runner 僵尸进程）。请执行 `./scripts/start.sh restart` 重启后重试。",
      );
    }
    return err instanceof Error ? err : new Error(message);
  }

  private async sessionLifecycle(
    action: "close" | "delete",
    backend: string,
    cwd: string,
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const suffix = action === "close" ? "/close" : "";
    const res = await this.fetch(`/sessions/${encodeURIComponent(sessionId)}${suffix}`, {
      method: action === "close" ? "POST" : "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend, cwd }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    return {
      ok: res.ok && body.ok === true,
      error: body.error ?? (res.ok ? undefined : `Runner error: ${res.status}`),
    };
  }

  private async requestSetup<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetch(path, init);
    const body = await res.json().catch(() => null) as SetupErrorPayload | T | null;
    if (!res.ok) {
      throw setupErrorFromResponse(res.status, body);
    }
    return (body ?? {}) as T;
  }

  private fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.options.baseUrl.replace(/\/$/, "")}${path}`;
    return fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        ...(init?.headers as Record<string, string>),
      },
    });
  }
}

interface SetupErrorPayload {
  error?: string;
  message?: string;
  details?: string;
  code?: string;
}

function setupErrorFromResponse(status: number, body: unknown): RunnerApiError {
  const payload = body && typeof body === "object" ? body as SetupErrorPayload : null;
  const message = payload?.message ?? payload?.error ?? `Runner error: ${status}`;
  const details = payload?.details;
  return new RunnerApiError(message, status, details, payload?.code ?? payload?.error);
}
