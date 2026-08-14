import { api, streamSessionEvents } from "./api";
import type { SessionViewStore } from "./session-store";
import type { SessionSnapshot } from "./types";

export class SessionConnection {
  private abort: AbortController | null = null;
  private readonly refreshPromises = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: {
    store: SessionViewStore;
    openSession: typeof api.openSession;
    stream?: typeof streamSessionEvents;
  }) {}

  async open(sessionId: string): Promise<void> {
    this.close();
    const controller = new AbortController();
    this.abort = controller;
    await this.refresh(sessionId);

    while (!controller.signal.aborted) {
      const current = this.dependencies.store.get(sessionId);
      if (!current) {
        await this.refresh(sessionId);
        continue;
      }
      const after = current.snapshot.runtime.last_event_sequence;
      try {
        await (this.dependencies.stream ?? streamSessionEvents)(sessionId, after, controller.signal, (event) => {
          const disposition = this.dependencies.store.receive(sessionId, event);
          if (disposition === "gap" || disposition === "refresh_required") {
            void this.refresh(sessionId);
          }
        });
      } catch {
        if (controller.signal.aborted) return;
        await this.refresh(sessionId);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  close(): void {
    this.abort?.abort();
    this.abort = null;
  }

  refresh(sessionId: string): Promise<void> {
    const existing = this.refreshPromises.get(sessionId);
    if (existing) return existing;
    const refresh = this.dependencies.openSession(sessionId)
      .then((snapshot: SessionSnapshot) => {
        this.dependencies.store.hydrate(snapshot);
      })
      .finally(() => {
        this.refreshPromises.delete(sessionId);
      });
    this.refreshPromises.set(sessionId, refresh);
    return refresh;
  }
}
