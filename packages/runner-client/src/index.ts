import type { AgentEvent, RunRequest } from "@feishu-code-bridge/core";
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

  async cancel(runId: string): Promise<void> {
    await this.fetch(`/runs/${runId}/cancel`, { method: "POST" });
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
    try {
      while (true) {
        if (options?.signal?.aborted) {
          await reader.cancel();
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const json = line.slice(5).trim();
          if (json) yield JSON.parse(json) as AgentEvent;
        }
      }
    } finally {
      reader.releaseLock();
    }
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
