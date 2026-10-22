import type { SessionCatalogStore } from "@codebridge/session-catalog";
import type { SqliteEventStore } from "@codebridge/work-items";

export interface SessionRuntimeMigrationConflict {
  sessionId: string;
  activeRunIds: string[];
}

export interface SessionRuntimeMigrationResult {
  migratedSessions: number;
  projectedEvents: number;
  conflicts: SessionRuntimeMigrationConflict[];
}

export class SessionRuntimeMigration {
  constructor(
    private readonly catalog: SessionCatalogStore,
    private readonly store: SqliteEventStore,
  ) {}

  run(options: {
    batchSize: number;
    maximumBatches?: number;
  }): SessionRuntimeMigrationResult {
    const bindings = this.catalog
      .listSessions(undefined, { includeArchived: true })
      .filter((session) => session.taskRecordId)
      .map((session) => ({
        sessionId: session.id,
        workItemId: session.taskRecordId!,
      }));

    const preview = this.store.previewSessionRuntimeMigration(bindings);
    if (preview.conflicts.length) {
      const error = new Error("session_runtime_migration_conflict") as Error & {
        conflicts: SessionRuntimeMigrationConflict[];
      };
      error.conflicts = preview.conflicts;
      throw error;
    }

    let projectedEvents = 0;
    let batches = 0;
    for (const binding of bindings) {
      this.store.bindWorkItemToSession(binding.sessionId, binding.workItemId);
      this.store.backfillRunTurns(binding.sessionId, binding.workItemId);
      this.store.ensureRuntimeFromRuns(binding.sessionId);

      while (batches < (options.maximumBatches ?? Number.POSITIVE_INFINITY)) {
        const count = this.store.backfillSessionProjection(
          binding.sessionId,
          binding.workItemId,
          options.batchSize,
        );
        if (!count) break;
        projectedEvents += count;
        batches += 1;
      }
    }

    return {
      migratedSessions: bindings.length,
      projectedEvents,
      conflicts: [],
    };
  }
}
