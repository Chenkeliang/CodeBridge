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
});
