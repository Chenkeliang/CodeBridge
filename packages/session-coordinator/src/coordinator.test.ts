import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionCoordinator } from "./coordinator.js";

const message = {
  text: "检查项目",
  attachmentIds: [],
  flowId: null,
  model: null,
  effort: null,
  permissionMode: null,
  plan: null,
};

function setup(maxQueuedTurns = 100) {
  const store = new SqliteEventStore(":memory:");
  const coordinator = new SessionCoordinator(store, {
    maxQueuedTurns,
    now: () => new Date("2026-08-14T00:00:00.000Z"),
  });
  return { store, coordinator };
}

function submit(
  coordinator: SessionCoordinator,
  key: string,
  text: string,
) {
  return coordinator.submitTurn({
    sessionId: "sess_1",
    idempotencyKey: key,
    message: { ...message, text },
    workItem: {
      title: "Session",
      mode: "auto",
      conversationId: "conv_sess_1",
      agentId: "pi",
      workspaceScope: [],
      riskLevel: "read_only",
    },
  });
}

describe("SessionCoordinator submit", () => {
  it("dispatches the first Turn and queues the second", () => {
    const { store, coordinator } = setup();
    const first = coordinator.submitTurn({
      sessionId: "sess_1",
      idempotencyKey: "message_1",
      message,
      workItem: {
        title: "检查项目",
        mode: "auto",
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: ["/workspace"],
        riskLevel: "read_only",
      },
    });
    const second = coordinator.submitTurn({
      sessionId: "sess_1",
      idempotencyKey: "message_2",
      message: { ...message, text: "继续检查" },
      workItem: {
        title: "检查项目",
        mode: "auto",
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: ["/workspace"],
        riskLevel: "read_only",
      },
    });

    expect(first.acceptance).toBe("dispatched");
    expect(second.acceptance).toBe("queued");
    expect(second.runtime.activeRunId).toBe(first.run?.id);
    expect(
      store.listQueuedTurns("sess_1", { limit: 100 }).turns,
    ).toEqual([
      expect.objectContaining({
        turnId: second.turn.turnId,
        status: "queued",
      }),
    ]);
    store.close();
  });

  it("returns the first response for the same scoped idempotency key", () => {
    const { store, coordinator } = setup();
    const input = {
      sessionId: "sess_1",
      idempotencyKey: "message_1",
      message,
      workItem: {
        title: "检查项目",
        mode: "auto" as const,
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: [],
        riskLevel: "read_only" as const,
      },
    };
    const first = coordinator.submitTurn(input);
    const repeated = coordinator.submitTurn({
      ...input,
      message: { ...message, text: "different" },
    });

    expect(repeated).toEqual(first);
    expect(store.listRunsByStatus(["queued"])).toHaveLength(1);
    store.close();
  });

  it("enforces the configured queue limit", () => {
    const { store, coordinator } = setup(1);
    coordinator.submitTurn({
      sessionId: "sess_1",
      idempotencyKey: "first",
      message,
      workItem: {
        title: "检查项目",
        mode: "auto",
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: [],
        riskLevel: "read_only",
      },
    });
    coordinator.submitTurn({
      sessionId: "sess_1",
      idempotencyKey: "second",
      message,
      workItem: {
        title: "检查项目",
        mode: "auto",
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: [],
        riskLevel: "read_only",
      },
    });
    expect(() => coordinator.submitTurn({
      sessionId: "sess_1",
      idempotencyKey: "third",
      message,
      workItem: {
        title: "检查项目",
        mode: "auto",
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: [],
        riskLevel: "read_only",
      },
    })).toThrow("queue_full");
    store.close();
  });

  it("dispatches only the FIFO head after success", () => {
    const { store, coordinator } = setup();
    const first = submit(coordinator, "first", "一");
    const second = submit(coordinator, "second", "二");
    const third = submit(coordinator, "third", "三");

    const result = coordinator.finishRun({
      sessionId: "sess_1",
      runId: first.run!.id,
      status: "succeeded",
    });

    expect(result.dispatched?.turn.turnId).toBe(second.turn.turnId);
    expect(result.runtime.activeRunId).toBe(result.dispatched?.run.id);
    expect(store.getTurn(third.turn.turnId)?.status).toBe("queued");
  });

  it.each(["failed", "cancelled", "interrupted"] as const)(
    "pauses the queue after %s",
    (status) => {
      const { store, coordinator } = setup();
      const first = submit(coordinator, "first", "一");
      submit(coordinator, "second", "二");

      const result = coordinator.finishRun({
        sessionId: "sess_1",
        runId: first.run!.id,
        status,
        reason: "test_terminal",
      });

      expect(result.runtime).toMatchObject({
        activeRunId: null,
        queueState: "paused",
        queuePauseReason: status,
      });
      expect(store.listRunsByStatus(["queued"])).toHaveLength(0);
    },
  );

  it("cancels a queued Turn with its own version", () => {
    const { store, coordinator } = setup();
    submit(coordinator, "first", "一");
    const second = submit(coordinator, "second", "二");
    const third = submit(coordinator, "third", "三");

    const cancelled = coordinator.cancelQueuedTurn({
      sessionId: "sess_1",
      turnId: second.turn.turnId,
      expectedVersion: second.turn.version,
      idempotencyKey: "cancel_second",
    });

    expect(cancelled.turn.status).toBe("cancelled");
    expect(store.getTurn(third.turn.turnId)?.queuePosition)
      .toBe(third.turn.queuePosition);
    expect(() => coordinator.cancelQueuedTurn({
      sessionId: "sess_1",
      turnId: third.turn.turnId,
      expectedVersion: 999,
      idempotencyKey: "cancel_third",
    })).toThrow("turn_version_conflict");
  });

  it("rejects queue cancellation after dispatch", () => {
    const { coordinator } = setup();
    const first = submit(coordinator, "first", "一");
    expect(() => coordinator.cancelQueuedTurn({
      sessionId: "sess_1",
      turnId: first.turn.turnId,
      expectedVersion: first.turn.version,
      idempotencyKey: "cancel_dispatched",
    })).toThrow("turn_not_queued");
  });

  it("does not couple Turn cancellation to Runtime version", () => {
    const { store, coordinator } = setup();
    submit(coordinator, "first", "一");
    const queued = submit(coordinator, "second", "二");
    store.withSessionTransaction((tx) => {
      tx.updateRuntime("sess_1", { queueState: "ready" });
    });
    expect(coordinator.cancelQueuedTurn({
      sessionId: "sess_1",
      turnId: queued.turn.turnId,
      expectedVersion: queued.turn.version,
      idempotencyKey: "cancel_second",
    }).turn.status).toBe("cancelled");
  });

  it("resumes a paused queue and dispatches exactly one Turn", () => {
    const { store, coordinator } = setup();
    const first = submit(coordinator, "first", "一");
    const second = submit(coordinator, "second", "二");
    coordinator.finishRun({
      sessionId: "sess_1",
      runId: first.run!.id,
      status: "failed",
      reason: "provider_failed",
    });

    const resumed = coordinator.resumeQueue({
      sessionId: "sess_1",
      expectedRuntimeVersion:
        store.getSessionRuntime("sess_1")!.version,
      idempotencyKey: "resume_1",
    });

    expect(resumed.dispatched?.turn.turnId).toBe(second.turn.turnId);
    expect(resumed.runtime.queueState).toBe("ready");
  });

  it("keeps new submissions queued while paused", () => {
    const { coordinator } = setup();
    const first = submit(coordinator, "first", "一");
    coordinator.finishRun({
      sessionId: "sess_1",
      runId: first.run!.id,
      status: "interrupted",
      reason: "provider_disconnected",
    });
    const later = submit(coordinator, "later", "稍后继续");
    expect(later.acceptance).toBe("queued");
    expect(later.run).toBeNull();
    expect(later.runtime.queueState).toBe("paused");
  });

  it("scopes identical keys by Session", () => {
    const { coordinator } = setup();
    const first = submit(coordinator, "shared_key", "Session one");
    const second = coordinator.submitTurn({
      sessionId: "sess_2",
      idempotencyKey: "shared_key",
      message: { ...message, text: "Session two" },
      workItem: {
        title: "Session two",
        mode: "auto",
        conversationId: "conv_sess_2",
        agentId: "pi",
        workspaceScope: [],
        riskLevel: "read_only",
      },
    });
    expect(second.turn.turnId).not.toBe(first.turn.turnId);
  });
});
