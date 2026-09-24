import { vi, describe, expect, it } from "vitest";
import { SqliteEventStore, type ReplaySafety } from "@codebridge/work-items";
import { SessionCoordinator } from "./coordinator.js";
import { SessionLeaseService } from "./lease.js";
import { SessionRecoveryService } from "./recovery.js";

const startedAt = new Date("2026-08-14T00:00:00.000Z");
const expiredAt = new Date("2026-08-14T00:02:00.000Z");

function setupRunningRun(replaySafety: ReplaySafety = "safe") {
  const store = new SqliteEventStore(":memory:");
  const coordinator = new SessionCoordinator(store, {
    maxQueuedTurns: 100,
    now: () => startedAt,
  });
  const submitted = coordinator.submitTurn({
    sessionId: "sess_1",
    idempotencyKey: "message_1",
    message: {
      text: "调查",
      attachmentIds: [],
      executionKind: "agent",
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    },
    workItem: {
      title: "Session",
      mode: "investigation",
      conversationId: "conv_sess_1",
      agentId: "pi",
      workspaceScope: [],
      riskLevel: "read_only",
    },
  });
  const run = submitted.run!;
  const leases = new SessionLeaseService(store, {
    now: () => startedAt,
  });
  leases.claim(run.id, "bridge:123");
  if (replaySafety !== "safe") {
    store.updateRunControl(run.id, { replaySafety });
  }
  const recovery = new SessionRecoveryService(
    store,
    coordinator,
    new SessionLeaseService(store, { now: () => expiredAt }),
    () => expiredAt,
  );
  return { store, coordinator, recovery, run, submitted };
}

describe("SessionRecoveryService", () => {
  it("repairs an expired Run from a committed terminal event", () => {
    const { store, recovery, run, submitted } = setupRunningRun();
    store.appendEvent({
      workItemId: submitted.workItemId,
      runId: run.id,
      type: "RUN_SUCCEEDED",
      actor: "system",
    });

    expect(recovery.scanExpired()).toEqual([
      { runId: run.id, action: "repaired_succeeded" },
    ]);
    expect(store.getRun(run.id)?.status).toBe("succeeded");
    store.close();
  });

  it("interrupts instead of replaying an expired unknown-outcome Run", () => {
    const { store, recovery, run } = setupRunningRun(
      "outcome_unknown",
    );

    expect(recovery.scanExpired()).toEqual([
      { runId: run.id, action: "interrupted" },
    ]);
    expect(store.getSessionRuntime("sess_1")).toMatchObject({
      activeRunId: null,
      queueState: "paused",
      queuePauseReason: "interrupted",
    });
    store.close();
  });

  it("leaves waiting Runs untouched", () => {
    const { store, recovery, run } = setupRunningRun();
    store.updateRunControl(run.id, {
      status: "waiting",
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    expect(recovery.scanExpired()).toEqual([]);
    expect(store.getRun(run.id)?.status).toBe("waiting");
    store.close();
  });

  it("reclaims an expired Run this process is still executing instead of interrupting it", () => {
    const { store, run } = setupRunningRun();
    const coordinator = new SessionCoordinator(store, {
      maxQueuedTurns: 100,
      now: () => expiredAt,
    });
    const recovery = new SessionRecoveryService(
      store,
      coordinator,
      new SessionLeaseService(store, { now: () => expiredAt }),
      () => expiredAt,
      { owner: "bridge:123", isExecuting: (id) => id === run.id },
    );

    expect(recovery.scanExpired()).toEqual([
      { runId: run.id, action: "reclaimed_own" },
    ]);
    const reclaimed = store.getRun(run.id)!;
    expect(reclaimed.status).toBe("running");
    expect(reclaimed.leaseOwner).toBe("bridge:123");
    expect(new Date(reclaimed.leaseExpiresAt!).getTime()).toBeGreaterThan(
      expiredAt.getTime(),
    );
    store.close();
  });

  it("does not reclaim when the provider session was taken over during the stall", () => {
    const { store, coordinator, run } = setupRunningRun();
    const leases = new SessionLeaseService(store, { now: () => expiredAt });
    vi.spyOn(leases, "listExpired").mockReturnValue([
      { ...store.getRun(run.id)!, agentId: "claude", providerSessionId: "provider-1" },
    ]);
    vi.spyOn(store, "renewProviderSession").mockReturnValue(false);
    const recovery = new SessionRecoveryService(
      store,
      coordinator,
      leases,
      () => expiredAt,
      { owner: "bridge:123", isExecuting: () => true },
    );

    expect(recovery.scanExpired()).toEqual([
      { runId: run.id, action: "interrupted" },
    ]);
    expect(store.getRun(run.id)?.status).toBe("interrupted");
    store.close();
  });

  it("interrupts an expired Run owned by a different process", () => {
    const { store, coordinator, run } = setupRunningRun();
    const recovery = new SessionRecoveryService(
      store,
      coordinator,
      new SessionLeaseService(store, { now: () => expiredAt }),
      () => expiredAt,
      { owner: "bridge:999", isExecuting: () => true },
    );

    expect(recovery.scanExpired()).toEqual([
      { runId: run.id, action: "interrupted" },
    ]);
    expect(store.getRun(run.id)?.status).toBe("interrupted");
    store.close();
  });

  it("interrupts own owner's expired Run when it is not actually executing", () => {
    const { store, coordinator, run } = setupRunningRun();
    const recovery = new SessionRecoveryService(
      store,
      coordinator,
      new SessionLeaseService(store, { now: () => expiredAt }),
      () => expiredAt,
      { owner: "bridge:123", isExecuting: () => false },
    );

    expect(recovery.scanExpired()).toEqual([
      { runId: run.id, action: "interrupted" },
    ]);
    expect(store.getRun(run.id)?.status).toBe("interrupted");
    store.close();
  });

  it("still repairs from terminal evidence even when ownLiveRun is configured", () => {
    const { store, coordinator, run, submitted } = setupRunningRun();
    store.appendEvent({
      workItemId: submitted.workItemId,
      runId: run.id,
      type: "RUN_SUCCEEDED",
      actor: "system",
    });
    const recovery = new SessionRecoveryService(
      store,
      coordinator,
      new SessionLeaseService(store, { now: () => expiredAt }),
      () => expiredAt,
      { owner: "bridge:123", isExecuting: () => true },
    );

    expect(recovery.scanExpired()).toEqual([
      { runId: run.id, action: "repaired_succeeded" },
    ]);
    expect(store.getRun(run.id)?.status).toBe("succeeded");
    store.close();
  });

  it("forces an overdue cancellation to interrupted", () => {
    const { store, coordinator, recovery, run } = setupRunningRun();
    coordinator.requestRunCancellation({
      sessionId: "sess_1",
      runId: run.id,
      expectedRuntimeVersion:
        store.getSessionRuntime("sess_1")!.version,
      idempotencyKey: "cancel_1",
    });

    expect(recovery.scanCancellationDeadlines()).toEqual([
      { runId: run.id, action: "interrupted" },
    ]);
    expect(store.getRun(run.id)?.status).toBe("interrupted");
    store.close();
  });
});
