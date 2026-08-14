import { createHash } from "node:crypto";
import type {
  AgentSession,
  SessionCatalogStore,
} from "@codebridge/session-catalog";
import type {
  ProviderSessionHistoryEvent,
  RunnerClient,
} from "@codebridge/runner-client";
import type {
  ProviderHistoryImportResult,
  SqliteEventStore,
} from "@codebridge/work-items";

function digest(
  events: ProviderSessionHistoryEvent[],
  end = events.length,
): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(events.slice(0, end)))
    .digest("hex")}`;
}

export class ProviderHistoryImporter {
  constructor(
    private readonly dependencies: {
      store: SqliteEventStore;
      catalog: SessionCatalogStore;
      runner: RunnerClient;
      defaultCwd?: string;
    },
  ) {}

  async preview(sessionId: string) {
    const session = this.requireBoundSession(sessionId);
    const history = await this.load(session);
    const prior = this.dependencies.store.getProviderHistoryImport(
      session.id,
      session.providerSessionId!,
    );
    if (
      prior
      && digest(history, prior.importedPosition)
        !== prior.providerDigest
    ) {
      throw new Error("provider_history_prefix_changed");
    }
    return {
      providerSessionId: session.providerSessionId!,
      importedPosition: prior?.importedPosition ?? 0,
      providerPosition: history.length,
      importableEvents:
        history.length - (prior?.importedPosition ?? 0),
      nextDigest: digest(history),
    };
  }

  async import(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<ProviderHistoryImportResult> {
    const namespace = `session:history-import:${sessionId}`;
    const cached = this.dependencies.store.getIdempotencyResponse(
      namespace,
      idempotencyKey,
    );
    if (cached) {
      this.bindTaskRecord(sessionId);
      return cached as ProviderHistoryImportResult;
    }

    const session = this.requireBoundSession(sessionId);
    const history = await this.load(session);
    const prior = this.dependencies.store.getProviderHistoryImport(
      session.id,
      session.providerSessionId!,
    );
    const priorPosition = prior?.importedPosition ?? 0;
    const priorDigest = digest(history, priorPosition);
    if (prior && priorDigest !== prior.providerDigest) {
      throw new Error("provider_history_prefix_changed");
    }
    const result = this.dependencies.store.importProviderHistory({
      sessionId,
      providerSessionId: session.providerSessionId!,
      priorPosition,
      priorDigest,
      nextDigest: digest(history),
      events: history.slice(priorPosition),
      idempotencyKey,
    });
    this.bindTaskRecord(sessionId);
    return result;
  }

  private bindTaskRecord(sessionId: string): void {
    const workItem =
      this.dependencies.store.getWorkItemBySessionId(sessionId);
    if (!workItem) {
      throw new Error("provider_history_work_item_missing");
    }
    if (
      this.dependencies.catalog.getSession(sessionId)?.taskRecordId
      === workItem.id
    ) {
      return;
    }
    this.dependencies.catalog.updateSession(sessionId, {
      taskRecordId: workItem.id,
    });
  }

  private requireBoundSession(sessionId: string): AgentSession {
    const session = this.dependencies.catalog.getSession(sessionId);
    if (!session) throw new Error("session_not_found");
    if (!session.providerSessionId) {
      throw new Error("provider_session_not_bound");
    }
    return session;
  }

  private load(
    session: AgentSession,
  ): Promise<ProviderSessionHistoryEvent[]> {
    return this.dependencies.runner.loadSessionHistory(
      session.agentId,
      session.cwd ?? this.dependencies.defaultCwd ?? process.cwd(),
      session.providerSessionId!,
      session.additionalDirectories,
    );
  }
}
