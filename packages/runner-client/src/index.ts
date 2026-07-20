import type {
  AgentEvent,
  BackendConfigOption,
  RunRequest,
} from "@feishu-code-bridge/core";
import type { CliSessionSummary } from "@feishu-code-bridge/backends";

export interface RunnerClientOptions {
  baseUrl: string;
  token: string;
}

export type { CliSessionSummary };

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
    options?: { all?: boolean; limit?: number; transport?: RunRequest["transport"] },
  ): Promise<{ sessions: CliSessionSummary[]; error?: string }> {
    const params = new URLSearchParams({
      backend,
      cwd,
      limit: String(options?.limit ?? 20),
    });
    if (options?.all) params.set("all", "true");
    if (options?.transport) params.set("transport", options.transport);
    const res = await this.fetch(`/sessions?${params}`);
    if (!res.ok) {
      throw new Error(`Runner error: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<{
      sessions: CliSessionSummary[];
      error?: string;
    }>;
  }

  async listConfigOptions(
    backend: string,
    cwd: string,
    options?: { transport?: RunRequest["transport"] },
  ): Promise<{ options: BackendConfigOption[]; error?: string }> {
    const params = new URLSearchParams({ backend, cwd });
    if (options?.transport) params.set("transport", options.transport);
    const res = await this.fetch(`/config-options?${params}`);
    if (!res.ok) {
      throw new Error(`Runner error: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<{
      options: BackendConfigOption[];
      error?: string;
    }>;
  }

  async cancel(runId: string): Promise<void> {
    await this.fetch(`/runs/${runId}/cancel`, { method: "POST" });
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
    const res = await this.fetch("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: options?.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Runner error: ${res.status} ${await res.text()}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    const onAbort = () => {
      void reader.cancel().catch(() => {});
    };
    const signal = options?.signal;
    if (signal) {
      if (signal.aborted) {
        reader.releaseLock();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
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
      signal?.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
  }

  private mapStreamError(err: unknown, sawDone: boolean): Error {
    if (sawDone) {
      return err instanceof Error ? err : new Error(String(err));
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message === "terminated" || message.includes("other side closed")) {
      return new Error(
        "Runner 连接意外断开（常见于 Runner 僵尸进程）。请执行 `./scripts/start.sh stop && ./scripts/start.sh start` 重启后重试；或发送 `/transport cli` 切换传输。",
      );
    }
    return err instanceof Error ? err : new Error(message);
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
