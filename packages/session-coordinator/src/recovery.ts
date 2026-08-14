import type {
  DomainEvent,
  Run,
  RunStatus,
  SqliteEventStore,
} from "@codebridge/work-items";
import { SessionCoordinator } from "./coordinator.js";
import { SessionLeaseService } from "./lease.js";

export type RecoveryAction =
  | "repaired_succeeded"
  | "repaired_failed"
  | "repaired_cancelled"
  | "repaired_interrupted"
  | "interrupted";

export class SessionRecoveryService {
  constructor(
    private readonly store: SqliteEventStore,
    private readonly coordinator: SessionCoordinator,
    private readonly leases: SessionLeaseService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  scanExpired(): Array<{ runId: string; action: RecoveryAction }> {
    return this.leases.listExpired().map((run) => {
      const terminal = this.store.findTerminalEventForRun(run.id);
      if (terminal) return this.repairFromEvidence(run, terminal);
      if (!run.sessionId) {
        throw new Error(`Expired leased Run has no Session: ${run.id}`);
      }
      this.coordinator.finishRun({
        sessionId: run.sessionId,
        runId: run.id,
        status: "interrupted",
        reason: run.replaySafety === "outcome_unknown"
          ? "lease_expired_unknown_outcome"
          : "lease_expired",
      });
      return { runId: run.id, action: "interrupted" as const };
    });
  }

  scanCancellationDeadlines(): Array<{
    runId: string;
    action: "interrupted";
  }> {
    return this.store
      .listCancellationDeadlineRuns(this.now().toISOString(), 100)
      .map((run) => {
        if (!run.sessionId) {
          throw new Error(
            `Cancelling Run has no Session: ${run.id}`,
          );
        }
        this.coordinator.finishRun({
          sessionId: run.sessionId,
          runId: run.id,
          status: "interrupted",
          reason: "cancellation_deadline_exceeded",
        });
        return { runId: run.id, action: "interrupted" as const };
      });
  }

  private repairFromEvidence(
    run: Run,
    event: DomainEvent,
  ): { runId: string; action: RecoveryAction } {
    if (!run.sessionId) {
      throw new Error(`Terminal Run has no Session: ${run.id}`);
    }
    const status = terminalStatus(event.type);
    this.coordinator.repairRunFromTerminalEvidence({
      sessionId: run.sessionId,
      runId: run.id,
      status,
    });
    return {
      runId: run.id,
      action: `repaired_${status}` as RecoveryAction,
    };
  }
}

function terminalStatus(type: DomainEvent["type"]): Extract<
  RunStatus,
  "succeeded" | "failed" | "cancelled" | "interrupted"
> {
  switch (type) {
    case "RUN_SUCCEEDED":
      return "succeeded";
    case "RUN_FAILED":
      return "failed";
    case "RUN_CANCELLED":
      return "cancelled";
    case "RUN_INTERRUPTED":
      return "interrupted";
    default:
      throw new Error(`Event is not terminal: ${type}`);
  }
}
