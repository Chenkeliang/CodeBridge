import type { FlowSaveInboxPage, FlowSaveInboxRequest } from "./types";

export type FlowSaveInboxRefreshKind = "periodic" | "immediate";

export type FlowSaveInboxRequestToken = {
  generation: number;
  signal: AbortSignal;
};

export type FlowSaveInboxSnapshot = {
  requests: FlowSaveInboxRequest[];
  loading: boolean;
  error: string | null;
  nextPollAt: number | null;
};

export function mergeFlowSaveInboxPages(
  pages: FlowSaveInboxPage[],
): FlowSaveInboxRequest[] {
  const seen = new Set<string>();
  const merged: FlowSaveInboxRequest[] = [];
  for (const page of pages) {
    for (const request of page.requests) {
      if (seen.has(request.request_id)) continue;
      seen.add(request.request_id);
      merged.push(request);
    }
  }
  return merged;
}

export class FlowSaveInboxState {
  readonly #pollIntervalMs: number;
  #generation = 0;
  #active: { generation: number; controller: AbortController } | null = null;
  #snapshot: FlowSaveInboxSnapshot = {
    requests: [],
    loading: false,
    error: null,
    nextPollAt: null,
  };

  constructor(options: { pollIntervalMs?: number } = {}) {
    this.#pollIntervalMs = options.pollIntervalMs ?? 15_000;
  }

  snapshot(): FlowSaveInboxSnapshot {
    return {
      ...this.#snapshot,
      requests: [...this.#snapshot.requests],
    };
  }

  begin(kind: FlowSaveInboxRefreshKind, _now: number): FlowSaveInboxRequestToken | null {
    if (kind === "periodic" && this.#active) return null;
    if (this.#active) this.#active.controller.abort();

    const controller = new AbortController();
    const generation = ++this.#generation;
    this.#active = { generation, controller };
    this.#snapshot = {
      ...this.#snapshot,
      loading: true,
      error: null,
      nextPollAt: null,
    };
    return { generation, signal: controller.signal };
  }

  succeed(
    token: FlowSaveInboxRequestToken,
    pages: FlowSaveInboxPage[],
    settledAt: number,
  ): boolean {
    if (!this.#isCurrent(token)) return false;
    this.#active = null;
    this.#snapshot = {
      requests: mergeFlowSaveInboxPages(pages),
      loading: false,
      error: null,
      nextPollAt: settledAt + this.#pollIntervalMs,
    };
    return true;
  }

  fail(token: FlowSaveInboxRequestToken, error: unknown, settledAt: number): boolean {
    if (!this.#isCurrent(token)) return false;
    this.#active = null;
    const aborted = isAbortError(error);
    this.#snapshot = {
      ...this.#snapshot,
      loading: false,
      error: aborted ? null : errorMessage(error),
      nextPollAt: settledAt + this.#pollIntervalMs,
    };
    return true;
  }

  cancel(): void {
    if (!this.#active) return;
    this.#active.controller.abort();
    this.#active = null;
    this.#generation += 1;
    this.#snapshot = { ...this.#snapshot, loading: false };
  }

  #isCurrent(token: FlowSaveInboxRequestToken): boolean {
    return this.#active?.generation === token.generation
      && this.#generation === token.generation;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "AbortError";
}
