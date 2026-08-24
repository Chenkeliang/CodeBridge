import { afterEach, describe, expect, it } from "vitest";
import {
  FlowBatchStore,
  aggregateFlowBatchStatus,
  type CreateFlowBatchDraftInput,
} from "./flow-batch.js";

const stores: FlowBatchStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()?.close();
});

function openStore(): FlowBatchStore {
  const store = new FlowBatchStore(":memory:");
  stores.push(store);
  return store;
}

function fixtureDraft(
  patch: Partial<CreateFlowBatchDraftInput> = {},
): CreateFlowBatchDraftInput {
  return {
    sessionId: "sess_batch",
    sourceRunId: "run_source",
    flowId: "flow_orders",
    definitionRevision: "sha256:def",
    status: "ready",
    globalInputs: { region: "cn" },
    items: [
      {
        itemId: "item_one",
        ordinal: 0,
        label: "订单 1",
        inputs: { oid: 1 },
        evidence: {
          oid: {
            source: "agent_extracted",
            evidenceRef: "event:1#line:1",
            inferred: false,
          },
        },
        issues: [],
      },
      {
        itemId: "item_two",
        ordinal: 1,
        label: "订单 2",
        inputs: { oid: 2 },
        evidence: {
          oid: {
            source: "agent_extracted",
            evidenceRef: "event:1#line:2",
            inferred: false,
          },
        },
        issues: [],
      },
    ],
    sourceRefs: ["event:1"],
    ...patch,
  };
}

describe("FlowBatchStore", () => {
  it("persists a ready draft and confirms it once", () => {
    const store = openStore();
    const draft = store.createDraft(fixtureDraft());

    const first = store.confirmDraft({
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      idempotencyKey: "confirm-1",
      planIrHash: "sha256:plan",
      flowSnapshot: { flow_id: "flow_orders", steps: [{ id: "lookup" }] },
      concurrency: 3,
      createdBy: "web:local",
    });
    const replay = store.confirmDraft({
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      idempotencyKey: "confirm-1",
      planIrHash: "sha256:plan",
      flowSnapshot: { flow_id: "flow_orders", steps: [{ id: "lookup" }] },
      concurrency: 3,
      createdBy: "web:local",
    });

    expect(replay.batchId).toBe(first.batchId);
    expect(store.getDraft(draft.draftId)?.status).toBe("confirmed");
    expect(store.listBatchItems(first.batchId)).toMatchObject([
      { itemId: "item_one", attempt: 1, resolvedInputs: { region: "cn", oid: 1 } },
      { itemId: "item_two", attempt: 1, resolvedInputs: { region: "cn", oid: 2 } },
    ]);
  });

  it("increments the draft revision and rejects a stale confirmation", () => {
    const store = openStore();
    const draft = store.createDraft(fixtureDraft());
    const replaced = store.replaceDraft({
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      status: "ready",
      globalInputs: { region: "us" },
      items: draft.items,
      sourceRefs: draft.sourceRefs,
    });

    expect(replaced.revision).toBe(2);
    expect(() => store.confirmDraft({
      draftId: draft.draftId,
      expectedRevision: 1,
      idempotencyKey: "confirm-stale",
      planIrHash: "sha256:plan",
      flowSnapshot: {},
      concurrency: 3,
      createdBy: "web:local",
    })).toThrowError(/batch_draft_changed/);
  });

  it("reserves a new attempt only for requested failed items", () => {
    const store = openStore();
    const draft = store.createDraft(fixtureDraft());
    const batch = store.confirmDraft({
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      idempotencyKey: "confirm-1",
      planIrHash: "sha256:plan",
      flowSnapshot: {},
      concurrency: 2,
      createdBy: "web:local",
    });
    const first = store.listBatchItems(batch.batchId)[0]!;

    const retries = store.reserveRetry({
      batchId: batch.batchId,
      itemIds: [first.itemId],
      idempotencyKey: "retry-1",
    });
    const replay = store.reserveRetry({
      batchId: batch.batchId,
      itemIds: [first.itemId],
      idempotencyKey: "retry-1",
    });

    expect(retries).toMatchObject([{ itemId: first.itemId, attempt: 2 }]);
    expect(replay[0]?.runId).toBe(retries[0]?.runId);
    expect(store.listBatchItems(batch.batchId)).toHaveLength(3);
  });
});

describe("aggregateFlowBatchStatus", () => {
  it.each([
    [["queued"], false, "queued"],
    [["running", "queued"], false, "running"],
    [["waiting", "queued"], false, "running"],
    [["succeeded", "succeeded"], false, "succeeded"],
    [["succeeded", "failed"], false, "partial_succeeded"],
    [["failed", "cancelled"], false, "failed"],
    [["cancelled", "cancelled"], true, "cancelled"],
    [["succeeded", "cancelled"], true, "partial_succeeded"],
  ] as const)("aggregates %j", (statuses, cancelRequested, expected) => {
    expect(aggregateFlowBatchStatus([...statuses], { cancelRequested }))
      .toBe(expected);
  });
});
