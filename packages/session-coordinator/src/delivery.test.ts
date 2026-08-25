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

const NOW = "2026-08-14T00:00:00.000Z";

function setup(maxQueuedTurns = 100) {
  const store = new SqliteEventStore(":memory:");
  const coordinator = new SessionCoordinator(store, {
    maxQueuedTurns,
    now: () => new Date(NOW),
  });
  return { store, coordinator };
}

function submitWithDelivery(
  coordinator: SessionCoordinator,
  key: string,
  text: string,
  delivery: {
    channel: string;
    conversationId: string;
    replyToMessageId: string;
    showThinking: boolean;
  } = {
    channel: "feishu",
    conversationId: "chat:1",
    replyToMessageId: `msg_${key}`,
    showThinking: false,
  },
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
    delivery,
  });
}

describe("channel turn delivery", () => {
  it("dispatched submit inserts a dispatched delivery with run_id", () => {
    const { store, coordinator } = setup();
    const first = submitWithDelivery(coordinator, "m1", "一");
    expect(first.acceptance).toBe("dispatched");
    store.updateRunControl(first.run!.id, {
      status: "running",
      leaseOwner: "runner-1",
      leaseExpiresAt: "2026-08-14T00:01:00.000Z",
    });

    const deliveries = store.listDeliveries("feishu");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      turnId: first.turn.turnId,
      sessionId: "sess_1",
      channel: "feishu",
      conversationId: "chat:1",
      replyToMessageId: "msg_m1",
      showThinking: false,
      runId: first.run?.id,
      status: "dispatched",
      runSnapshot: {
        status: "running",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        leaseExpiresAt: "2026-08-14T00:01:00.000Z",
        terminalReason: null,
        sessionActiveRunId: first.run?.id,
        sessionQueueState: "ready",
      },
    });
    store.close();
  });

  it("queued submit inserts a pending delivery with run_id null", () => {
    const { store, coordinator } = setup();
    submitWithDelivery(coordinator, "m1", "一");
    const second = submitWithDelivery(coordinator, "m2", "二");
    expect(second.acceptance).toBe("queued");

    const deliveries = store.listDeliveries("feishu");
    const queued = deliveries.find((d) => d.turnId === second.turn.turnId);
    expect(queued).toMatchObject({
      showThinking: false,
      runId: null,
      status: "pending",
      runSnapshot: null,
    });
    store.close();
  });

  it("finishRun marks run_terminal_at but not completed", () => {
    const { store, coordinator } = setup();
    const first = submitWithDelivery(coordinator, "m1", "一");
    coordinator.finishRun({
      sessionId: "sess_1",
      runId: first.run!.id,
      status: "succeeded",
    });

    const delivery = store.listDeliveries("feishu")[0];
    expect(delivery.runTerminalAt).toBe(NOW);
    expect(delivery.status).toBe("dispatched");
    expect(delivery.runSnapshot).toMatchObject({
      status: "succeeded",
      terminalReason: null,
      sessionActiveRunId: null,
      sessionQueueState: "ready",
    });
    store.close();
  });

  it("dispatchTurn fills run_id for a previously queued turn", () => {
    const { store, coordinator } = setup();
    const first = submitWithDelivery(coordinator, "m1", "一");
    const second = submitWithDelivery(coordinator, "m2", "二");
    expect(second.acceptance).toBe("queued");

    coordinator.finishRun({
      sessionId: "sess_1",
      runId: first.run!.id,
      status: "succeeded",
    });

    const delivery = store
      .listDeliveries("feishu")
      .find((d) => d.turnId === second.turn.turnId);
    expect(delivery).toMatchObject({
      runId: expect.any(String),
      status: "dispatched",
    });
    store.close();
  });

  it("claimDelivery is CAS with expired retake", () => {
    const { store, coordinator } = setup();
    const first = submitWithDelivery(coordinator, "m1", "一");
    const turnId = first.turn.turnId;

    expect(
      store.withSessionTransaction((tx) =>
        tx.claimDelivery(turnId, "owner-1", NOW, "2026-08-14T00:01:00.000Z"),
      ),
    ).toBe(true);
    // 已被持有，第二次 claim 失败
    expect(
      store.withSessionTransaction((tx) =>
        tx.claimDelivery(turnId, "owner-2", NOW, "2026-08-14T00:01:00.000Z"),
      ),
    ).toBe(false);
    // 过期后可重领
    expect(
      store.withSessionTransaction((tx) =>
        tx.claimDelivery(turnId, "owner-2", "2026-08-14T00:02:00.000Z", "2026-08-14T00:03:00.000Z"),
      ),
    ).toBe(true);
    store.close();
  });

  it("cannot claim a pending delivery without a run", () => {
    const { store, coordinator } = setup();
    submitWithDelivery(coordinator, "m1", "一");
    const second = submitWithDelivery(coordinator, "m2", "二");
    expect(second.acceptance).toBe("queued");

    expect(
      store.withSessionTransaction((tx) =>
        tx.claimDelivery(second.turn.turnId, "owner-1", NOW, "2026-08-14T00:01:00.000Z"),
      ),
    ).toBe(false);
    store.close();
  });

  it("ackDelivery is owner-safe and idempotent for the same surface id", () => {
    const { store, coordinator } = setup();
    const first = submitWithDelivery(coordinator, "m1", "一");
    const turnId = first.turn.turnId;
    store.withSessionTransaction((tx) =>
      tx.claimDelivery(turnId, "owner-1", NOW, "2026-08-14T00:01:00.000Z"),
    );

    expect(
      store.withSessionTransaction((tx) =>
        tx.ackDelivery(turnId, "owner-1", "card-1"),
      ),
    ).toBe(true);
    // 同 surface id → 幂等成功
    expect(
      store.withSessionTransaction((tx) =>
        tx.ackDelivery(turnId, "owner-1", "card-1"),
      ),
    ).toBe(true);
    // 不同 surface id → 冲突失败
    expect(
      store.withSessionTransaction((tx) =>
        tx.ackDelivery(turnId, "owner-1", "card-2"),
      ),
    ).toBe(false);

    expect(store.listDeliveries("feishu")[0].surfaceMessageId).toBe("card-1");
    store.close();
  });

  it("rejects a stale owner ack after retake", () => {
    const { store, coordinator } = setup();
    const first = submitWithDelivery(coordinator, "m1", "一");
    const turnId = first.turn.turnId;
    store.withSessionTransaction((tx) =>
      tx.claimDelivery(turnId, "owner-1", NOW, "2026-08-14T00:01:00.000Z"),
    );
    // 过期后 owner-2 重领
    expect(
      store.withSessionTransaction((tx) =>
        tx.claimDelivery(turnId, "owner-2", "2026-08-14T00:02:00.000Z", "2026-08-14T00:03:00.000Z"),
      ),
    ).toBe(true);
    // owner-1 延迟 ack → 失败
    expect(
      store.withSessionTransaction((tx) =>
        tx.ackDelivery(turnId, "owner-1", "card-stale"),
      ),
    ).toBe(false);
    store.close();
  });

  it("completeDelivery requires terminal run, ack, and current owner", () => {
    const { store, coordinator } = setup();
    const first = submitWithDelivery(coordinator, "m1", "一");
    const turnId = first.turn.turnId;
    coordinator.finishRun({
      sessionId: "sess_1",
      runId: first.run!.id,
      status: "succeeded",
    });
    store.withSessionTransaction((tx) =>
      tx.claimDelivery(turnId, "owner-1", NOW, "2026-08-14T00:01:00.000Z"),
    );
    // 未 ACK → 不可 complete
    expect(
      store.withSessionTransaction((tx) =>
        tx.completeDelivery(turnId, "owner-1"),
      ),
    ).toBe(false);
    store.withSessionTransaction((tx) =>
      tx.ackDelivery(turnId, "owner-1", "card-1"),
    );
    expect(
      store.withSessionTransaction((tx) =>
        tx.completeDelivery(turnId, "owner-1"),
      ),
    ).toBe(true);
    expect(store.listDeliveries("feishu")).toHaveLength(0);
    store.close();
  });

  it("rejects complete from a non-terminal run and stale owner", () => {
    const { store, coordinator } = setup();
    const first = submitWithDelivery(coordinator, "m1", "一");
    const turnId = first.turn.turnId;
    store.withSessionTransaction((tx) =>
      tx.claimDelivery(turnId, "owner-1", NOW, "2026-08-14T00:01:00.000Z"),
    );
    store.withSessionTransaction((tx) =>
      tx.ackDelivery(turnId, "owner-1", "card-1"),
    );
    // run 未终态 → 不可 complete
    expect(
      store.withSessionTransaction((tx) =>
        tx.completeDelivery(turnId, "owner-1"),
      ),
    ).toBe(false);
    // stale owner → 不可 complete
    expect(
      store.withSessionTransaction((tx) =>
        tx.completeDelivery(turnId, "owner-other"),
      ),
    ).toBe(false);
    store.close();
  });

  it("completeDelivery is idempotent when retried with the same owner", () => {
    const { store, coordinator } = setup();
    const first = submitWithDelivery(coordinator, "m1", "一");
    const turnId = first.turn.turnId;
    coordinator.finishRun({
      sessionId: "sess_1",
      runId: first.run!.id,
      status: "succeeded",
    });
    store.withSessionTransaction((tx) =>
      tx.claimDelivery(turnId, "owner-1", NOW, "2026-08-14T00:01:00.000Z"),
    );
    store.withSessionTransaction((tx) =>
      tx.ackDelivery(turnId, "owner-1", "card-1"),
    );
    expect(
      store.withSessionTransaction((tx) =>
        tx.completeDelivery(turnId, "owner-1"),
      ),
    ).toBe(true);
    // 重试同 owner → 幂等成功
    expect(
      store.withSessionTransaction((tx) =>
        tx.completeDelivery(turnId, "owner-1"),
      ),
    ).toBe(true);
    // 不同 owner → 失败
    expect(
      store.withSessionTransaction((tx) =>
        tx.completeDelivery(turnId, "owner-other"),
      ),
    ).toBe(false);
    store.close();
  });

  it("listDeliveries filters by channel", () => {
    const { store, coordinator } = setup();
    submitWithDelivery(coordinator, "m1", "一", {
      channel: "feishu",
      conversationId: "chat:1",
      replyToMessageId: "msg_m1",
      showThinking: false,
    });
    submitWithDelivery(coordinator, "m2", "二", {
      channel: "telegram",
      conversationId: "chat:1",
      replyToMessageId: "msg_m2",
      showThinking: false,
    });

    expect(store.listDeliveries("feishu")).toHaveLength(1);
    expect(store.listDeliveries("telegram")).toHaveLength(1);
    store.close();
  });
});
