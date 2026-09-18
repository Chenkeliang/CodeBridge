import type { Run, SqliteEventStore } from "@codebridge/work-items";

const LEASE_MS = 60_000;

export class SessionLeaseService {
  private readonly now: () => Date;

  constructor(
    private readonly store: SqliteEventStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  claim(runId: string, owner: string): Run | null {
    const now = this.now();
    return this.store.claimRun(
      runId,
      owner,
      now.toISOString(),
      new Date(now.getTime() + LEASE_MS).toISOString(),
    );
  }

  renew(runId: string, owner: string): Run | null {
    const now = this.now();
    return this.store.renewRunLease(
      runId,
      owner,
      now.toISOString(),
      new Date(now.getTime() + LEASE_MS).toISOString(),
    );
  }

  /** 同一 owner 在仍执行该 Run 时，把已过期的租约重新续回来。 */
  reclaimOwn(runId: string, owner: string): Run | null {
    const now = this.now();
    return this.store.reclaimRunLease(
      runId,
      owner,
      new Date(now.getTime() + LEASE_MS).toISOString(),
    );
  }

  listExpired(limit = 100): Run[] {
    return this.store.listExpiredRunningRuns(
      this.now().toISOString(),
      limit,
    );
  }
}
