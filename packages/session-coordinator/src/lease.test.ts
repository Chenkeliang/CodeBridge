import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionCoordinator } from "./coordinator.js";
import { SessionLeaseService } from "./lease.js";

function setupQueuedRun() {
  const store = new SqliteEventStore(":memory:");
  const coordinator = new SessionCoordinator(store, {
    maxQueuedTurns: 100,
  });
  const submitted = coordinator.submitTurn({
    sessionId: "sess_1",
    idempotencyKey: "message_1",
    message: {
      text: "检查项目",
      attachmentIds: [],
      flowId: null,
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    },
    workItem: {
      title: "Session",
      mode: "auto",
      conversationId: "conv_sess_1",
      agentId: "pi",
      workspaceScope: [],
      riskLevel: "read_only",
    },
  });
  return { store, runId: submitted.run!.id };
}

describe("Session leases", () => {
  it("claims queued to running with a sixty-second lease", () => {
    const now = new Date("2026-08-14T00:00:00.000Z");
    const { store, runId } = setupQueuedRun();
    const leases = new SessionLeaseService(store, { now: () => now });

    const run = leases.claim(runId, "bridge:123");

    expect(run).toMatchObject({
      status: "running",
      leaseOwner: "bridge:123",
      leaseExpiresAt: "2026-08-14T00:01:00.000Z",
    });
    expect(leases.claim(runId, "bridge:456")).toBeNull();
    store.close();
  });

  it("renews only the current owner's running lease", () => {
    const clock = {
      now: new Date("2026-08-14T00:00:00.000Z"),
    };
    const { store, runId } = setupQueuedRun();
    const leases = new SessionLeaseService(
      store,
      { now: () => clock.now },
    );
    leases.claim(runId, "bridge:123");
    clock.now = new Date("2026-08-14T00:00:15.000Z");

    expect(leases.renew(runId, "bridge:123")?.leaseExpiresAt)
      .toBe("2026-08-14T00:01:15.000Z");
    expect(leases.renew(runId, "bridge:456")).toBeNull();
    store.close();
  });

  it("finds expired running leases but never waiting Runs", () => {
    const clock = {
      now: new Date("2026-08-14T00:00:00.000Z"),
    };
    const { store, runId } = setupQueuedRun();
    const leases = new SessionLeaseService(
      store,
      { now: () => clock.now },
    );
    leases.claim(runId, "bridge:123");
    clock.now = new Date("2026-08-14T00:01:01.000Z");

    expect(leases.listExpired()).toEqual([
      expect.objectContaining({ id: runId, status: "running" }),
    ]);
    store.updateRunControl(runId, {
      status: "waiting",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(leases.listExpired()).toEqual([]);
    store.close();
  });
});
