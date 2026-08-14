import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "./index.js";

function setup() {
  const store = new SqliteEventStore(":memory:");
  const item = store.createWorkItem({
    title: "Session",
    mode: "auto",
    conversationId: "conv_sess_1",
    sessionId: "sess_1",
    riskLevel: "read_only",
  });
  return { store, item };
}

function seedDispatchedTurn(
  store: SqliteEventStore,
  workItemId: string,
): void {
  store.withSessionTransaction((tx) => {
    tx.ensureRuntime("sess_1");
    const turn = tx.insertTurn("sess_1", {
      text: "检查项目",
      attachmentIds: [],
      flowId: null,
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    });
    tx.dispatchTurn(turn.turnId, {
      id: "run_1",
      workItemId,
      sessionId: "sess_1",
      turnId: turn.turnId,
      mode: "auto",
      agentId: "pi",
      planId: null,
      planIrHash: null,
      workflowRevision: null,
    });
  });
}

describe("Session projector", () => {
  it("creates a Turn and seals every block on a terminal event", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "RUN_STARTED",
      actor: "system",
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "AGENT_EVENT",
      actor: "agent",
      payload: {
        event: {
          type: "text_delta",
          blockId: "answer_1",
          phase: "final_answer",
          text: "完成",
        },
      },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "RUN_SUCCEEDED",
      actor: "system",
    });

    expect(
      store.listTimelineTurns("sess_1", { limit: 50 }).turns[0],
    ).toMatchObject({
      status: "succeeded",
      blocks: expect.arrayContaining([
        expect.objectContaining({
          kind: "user_message",
          status: "completed",
        }),
        expect.objectContaining({
          blockId: "answer_1",
          status: "completed",
        }),
      ]),
    });
    store.close();
  });

  it("updates command read models without scanning events", () => {
    const { store, item } = setup();
    store.appendEvent({
      workItemId: item.id,
      type: "AGENT_EVENT",
      actor: "agent",
      payload: {
        event: {
          type: "available_commands_update",
          availableCommands: [
            { name: "status", description: "Show status" },
          ],
        },
      },
    });
    expect(store.listSessionCommands("sess_1")).toEqual([
      { name: "status", description: "Show status" },
    ]);
    store.close();
  });

  it("splits UTF-8 output into bounded stable Segments", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    const content = "界".repeat(6_000);
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "AGENT_EVENT",
      actor: "agent",
      payload: {
        event: {
          type: "text_delta",
          blockId: "answer_1",
          phase: "final_answer",
          text: content,
        },
      },
    });

    const block = store
      .listTimelineTurns("sess_1", { limit: 50 })
      .turns[0]!
      .blocks.find((candidate) => candidate.blockId === "answer_1")!;
    expect(block.segments.length).toBeGreaterThan(1);
    expect(block.segments.every((segment) => segment.byteLength <= 16_384))
      .toBe(true);
    expect(block.segments.map((segment) => segment.content).join(""))
      .toBe(content);
    store.close();
  });

  it("rejects Agent events after a Session Run is terminal", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    store.updateRunControl("run_1", { status: "succeeded" });
    const before = store.listEvents(item.id).length;

    expect(() => store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "AGENT_EVENT",
      actor: "agent",
      payload: { event: { type: "text_delta", text: "late" } },
    })).toThrow("terminal Run cannot accept execution events");
    expect(store.listEvents(item.id)).toHaveLength(before);
    store.close();
  });

  it("rolls back an event when its projection violates an invariant", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    const turn = store
      .listTimelineTurns("sess_1", { limit: 50 })
      .turns[0]!;
    const before = store.listEvents(item.id).length;
    expect(() => store.appendEvent({
      workItemId: item.id,
      type: "TURN_CANCELLED",
      actor: "user",
      target: turn.turnId,
    })).toThrow("dispatched Turn cannot be cancelled");
    expect(store.listEvents(item.id)).toHaveLength(before);
    store.close();
  });
});
