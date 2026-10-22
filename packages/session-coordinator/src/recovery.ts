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
  | "interrupted"
  | "reclaimed_own";

/** provider-session 租约时长，需与 run-executor 的 PROVIDER_LEASE_MS 保持一致。 */
const PROVIDER_LEASE_MS = 60_000;

export interface OwnLiveRunOptions {
  owner: string;
  isExecuting: (runId: string) => boolean;
}

export class SessionRecoveryService {
  constructor(
    private readonly store: SqliteEventStore,
    private readonly coordinator: SessionCoordinator,
    private readonly leases: SessionLeaseService,
    private readonly now: () => Date = () => new Date(),
    private readonly ownLiveRun?: OwnLiveRunOptions,
  ) {}

  scanExpired(): Array<{ runId: string; action: RecoveryAction }> {
    return this.leases.listExpired().map((run) => {
      const terminal = this.store.findTerminalEventForRun(run.id);
      if (terminal) return this.repairFromEvidence(run, terminal);
      if (
        this.ownLiveRun
        && run.leaseOwner === this.ownLiveRun.owner
        && this.ownLiveRun.isExecuting(run.id)
      ) {
        const reclaimed = this.tryReclaimOwn(run);
        if (reclaimed) return reclaimed;
      }
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

  /**
   * 本进程仍在执行该 Run（心跳/事件写入被事件循环长阻塞错过了续租窗口）时，
   * 把 Run 租约和 provider-session 租约都续回来，而不是自我中断这个还活着的 Run。
   */
  private tryReclaimOwn(
    run: Run,
  ): { runId: string; action: RecoveryAction } | undefined {
    const owner = this.ownLiveRun!.owner;
    // 先确认 provider session 还在自己手里：卡顿期间若已被别的 Run 接管，就不该续命，走原有中断。
    if (
      run.providerSessionId
      && run.agentId
      && !this.store.renewProviderSession({
        agentId: run.agentId,
        providerSessionId: run.providerSessionId,
        runId: run.id,
        expiresAt: new Date(this.now().getTime() + PROVIDER_LEASE_MS).toISOString(),
      })
    ) {
      return undefined;
    }
    const reclaimed = this.leases.reclaimOwn(run.id, owner);
    if (!reclaimed) return undefined;
    const overdueMs = run.leaseExpiresAt
      ? this.now().getTime() - new Date(run.leaseExpiresAt).getTime()
      : 0;
    console.warn(
      `${new Date().toISOString()} reclaimed_own_lease runId=${run.id} overdueMs=${overdueMs}`,
    );
    return { runId: run.id, action: "reclaimed_own" };
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
