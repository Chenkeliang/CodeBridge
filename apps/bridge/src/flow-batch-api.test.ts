import { afterEach, describe, expect, it } from "vitest";
import type { FlowRecord } from "@codebridge/flow-catalog";
import { FlowBatchStore, SqliteEventStore, type Run } from "@codebridge/work-items";
import { definitionHash } from "@codebridge/workflow-engine";
import { compileCatalogFlow } from "./flow-compile.js";
import { createFlowBatchApp } from "./flow-batch-api.js";
import { FlowBatchService, type FlowBatchRunExecutor } from "./flow-batch-service.js";

const token = "test-token";
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { ...auth, ...headers },
    body: JSON.stringify(body),
  };
}

function fixtureFlow(): FlowRecord {
  const flow: FlowRecord = {
    schemaVersion: 1,
    flowId: "flow_orders",
    name: "订单核验",
    description: null,
    kind: "runbook",
    status: "published",
    source: "user_selected",
    definitionRevision: "sha256:def",
    planIrHash: null,
    inputs: [{ id: "oid", type: "integer", source: "user", required: true }],
    reviewStatus: "approved",
    gitRevision: null,
    validationIssues: [],
    steps: [{ id: "lookup", capability: "demo.lookup", mode: "read_only", successWhen: "output.ok exists" }],
    lineageRootFlowId: "flow_orders",
    parentFlowId: null,
    provenance: null,
    publicationSequence: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  flow.planIrHash = definitionHash(compileCatalogFlow(flow));
  return flow;
}

function harness() {
  const batches = new FlowBatchStore(":memory:");
  const workItems = new SqliteEventStore(":memory:");
  cleanup.push(() => batches.close(), () => workItems.close());
  const source = workItems.createWorkItem({
    id: "wi_source",
    title: "source",
    mode: "auto",
    conversationId: "conv_batch",
    sessionId: "sess_batch",
    riskLevel: "read_only",
  });
  workItems.createRun({
    id: "run_source",
    workItemId: source.id,
    sessionId: "sess_batch",
    mode: "auto",
  });
  const flow = fixtureFlow();
  const executor: FlowBatchRunExecutor = {
    execute: (runId) => new Promise<Run>(() => {
      workItems.updateRunStatus(runId, "running");
    }),
    cancelRunAndWait: async (runId) => workItems.updateRunStatus(runId, "cancelled"),
  };
  const service = new FlowBatchService({
    batches,
    workItems,
    flows: { get: (id) => id === flow.flowId ? flow : undefined },
    executor,
  });
  return { app: createFlowBatchApp(service, token), flow };
}

describe("Flow batch API", () => {
  it("creates and confirms a ready batch draft", async () => {
    const { app, flow } = harness();
    const created = await app.request("/v1/flow-invocation-drafts", post({
      source_run_id: "run_source",
      flow_id: flow.flowId,
      definition_revision: flow.definitionRevision,
      global_inputs: {},
      source_refs: ["event:message-1"],
      items: [{
        item_id: "one",
        inputs: { oid: "1" },
        evidence: {
          oid: { source: "agent_extracted", evidence_ref: "event:message-1#line:1" },
        },
      }],
    }));
    expect(created.status).toBe(201);
    const draft = await created.json() as { draft_id: string; revision: number; status: string };
    expect(draft.status).toBe("ready");

    const confirmed = await app.request(
      `/v1/flow-invocation-drafts/${draft.draft_id}/confirm`,
      post(
        { draft_revision: draft.revision },
        { "idempotency-key": "confirm-1" },
      ),
    );
    expect(confirmed.status).toBe(202);
    expect(await confirmed.json()).toMatchObject({
      status: "running",
      counts: { total: 1, running: 1 },
    });
  });

  it("returns stable item errors and blocks confirmation", async () => {
    const { app, flow } = harness();
    const created = await app.request("/v1/flow-invocation-drafts", post({
      session_id: "sess_batch",
      source_run_id: "run_source",
      flow_id: flow.flowId,
      definition_revision: flow.definitionRevision,
      items: [{ item_id: "one", inputs: {}, evidence: {} }],
    }));
    const draft = await created.json() as { draft_id: string; revision: number };
    const confirmed = await app.request(
      `/v1/flow-invocation-drafts/${draft.draft_id}/confirm`,
      post({ draft_revision: draft.revision }, { "idempotency-key": "confirm-1" }),
    );

    expect(confirmed.status).toBe(409);
    expect(await confirmed.json()).toMatchObject({ error: "batch_draft_not_ready" });
  });

  it("rejects stale Flow revisions without creating a draft", async () => {
    const { app, flow } = harness();
    const response = await app.request("/v1/flow-invocation-drafts", post({
      session_id: "sess_batch",
      source_run_id: "run_source",
      flow_id: flow.flowId,
      definition_revision: "sha256:old",
      items: [{ item_id: "one", inputs: { oid: 1 }, evidence: {} }],
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "flow_revision_mismatch",
      expected_definition_revision: "sha256:old",
      current_definition_revision: flow.definitionRevision,
    });
  });

  it("requires authentication and confirmation idempotency", async () => {
    const { app } = harness();
    expect((await app.request("/v1/flow-invocation-drafts/missing", {
      headers: { authorization: "Bearer wrong" },
    })).status).toBe(401);
    expect((await app.request(
      "/v1/flow-invocation-drafts/missing/confirm",
      post({ draft_revision: 1 }),
    )).status).toBe(400);
  });
});
