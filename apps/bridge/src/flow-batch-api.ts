import { Hono, type Context } from "hono";
import {
  FlowBatchStoreError,
  type FlowBatchDraft,
} from "@codebridge/work-items";
import {
  FlowBatchService,
  FlowBatchServiceError,
  type FlowBatchSnapshot,
} from "./flow-batch-service.js";
import {
  FlowBatchValidationError,
} from "./flow-batch-validation.js";

export function createFlowBatchApp(
  service: FlowBatchService,
  token: string,
): Hono {
  const app = new Hono();
  app.use("/v1/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.post("/v1/flow-invocation-drafts", async (c) => {
    const body = await jsonRecord(c);
    if (!body) return c.json({ error: "batch_item_invalid" }, 422);
    const identity = draftIdentity(body);
    if (!identity) {
      return c.json({ error: "batch_identity_required" }, 400);
    }
    try {
      const draft = service.createDraft({
        ...identity,
        candidate: draftCandidate(body),
      });
      return c.json(toWireDraft(draft), 201);
    } catch (error) {
      return batchError(c, error);
    }
  });

  app.get("/v1/flow-invocation-drafts/:draft_id", (c) => {
    const draft = service.getDraft(c.req.param("draft_id"));
    return draft
      ? c.json(toWireDraft(draft))
      : c.json({ error: "batch_draft_not_found" }, 404);
  });

  app.get("/v1/sessions/:session_id/flow-invocation-drafts", (c) =>
    c.json({
      drafts: service.listDraftsForSession(c.req.param("session_id"))
        .map(toWireDraft),
    })
  );

  app.patch("/v1/flow-invocation-drafts/:draft_id", async (c) => {
    const body = await jsonRecord(c);
    if (!body || !positiveInteger(body.draft_revision)) {
      return c.json({ error: "draft_revision_required" }, 400);
    }
    try {
      return c.json(toWireDraft(service.updateDraft({
        draftId: c.req.param("draft_id"),
        expectedRevision: Number(body.draft_revision),
        candidate: draftCandidate(body),
      })));
    } catch (error) {
      return batchError(c, error);
    }
  });

  app.post("/v1/flow-invocation-drafts/:draft_id/confirm", async (c) => {
    const key = c.req.header("idempotency-key");
    if (!key) return c.json({ error: "idempotency_key_required" }, 400);
    const body = await jsonRecord(c);
    if (!body || !positiveInteger(body.draft_revision)) {
      return c.json({ error: "draft_revision_required" }, 400);
    }
    try {
      const snapshot = await service.confirm(
        c.req.param("draft_id"),
        Number(body.draft_revision),
        key,
        {
          concurrency: positiveInteger(body.concurrency)
            ? Number(body.concurrency)
            : undefined,
          createdBy: actorName(body.created_by),
        },
      );
      return c.json(toWireSnapshot(snapshot), 202);
    } catch (error) {
      return batchError(c, error);
    }
  });

  app.post("/v1/flow-invocation-drafts/:draft_id/cancel", (c) => {
    try {
      return c.json(toWireDraft(service.cancelDraft(c.req.param("draft_id"))));
    } catch (error) {
      return batchError(c, error);
    }
  });

  app.get("/v1/flow-batches/:batch_id", (c) => {
    try {
      return c.json(toWireSnapshot(service.snapshot(c.req.param("batch_id"))));
    } catch (error) {
      return batchError(c, error);
    }
  });

  app.post("/v1/flow-batches/:batch_id/cancel", async (c) => {
    try {
      return c.json(toWireSnapshot(
        await service.cancel(c.req.param("batch_id")),
      ), 202);
    } catch (error) {
      return batchError(c, error);
    }
  });

  app.post("/v1/flow-batches/:batch_id/retry-failed", async (c) => {
    const key = c.req.header("idempotency-key");
    if (!key) return c.json({ error: "idempotency_key_required" }, 400);
    try {
      return c.json(toWireSnapshot(
        await service.retryFailed(c.req.param("batch_id"), key),
      ), 202);
    } catch (error) {
      return batchError(c, error);
    }
  });

  return app;
}

function toWireDraft(draft: FlowBatchDraft): Record<string, unknown> {
  return {
    schema_version: draft.schemaVersion,
    draft_id: draft.draftId,
    session_id: draft.sessionId,
    source_run_id: draft.sourceRunId,
    flow_id: draft.flowId,
    definition_revision: draft.definitionRevision,
    status: draft.status,
    revision: draft.revision,
    global_inputs: draft.globalInputs,
    items: draft.items.map((item) => ({
      item_id: item.itemId,
      ordinal: item.ordinal,
      label: item.label,
      inputs: item.inputs,
      evidence: Object.fromEntries(Object.entries(item.evidence).map(
        ([field, evidence]) => [field, {
          source: evidence.source,
          evidence_ref: evidence.evidenceRef,
          inferred: evidence.inferred,
        }],
      )),
      issues: item.issues,
    })),
    source_refs: draft.sourceRefs,
    created_at: draft.createdAt,
    updated_at: draft.updatedAt,
  };
}

function toWireSnapshot(snapshot: FlowBatchSnapshot): Record<string, unknown> {
  return {
    batch_id: snapshot.batch.batchId,
    draft_id: snapshot.batch.draftId,
    session_id: snapshot.batch.sessionId,
    flow_id: snapshot.batch.flowId,
    definition_revision: snapshot.batch.definitionRevision,
    plan_ir_hash: snapshot.batch.planIrHash,
    concurrency: snapshot.batch.concurrency,
    failure_policy: snapshot.batch.failurePolicy,
    cancel_requested_at: snapshot.batch.cancelRequestedAt,
    status: snapshot.status,
    counts: snapshot.counts,
    items: snapshot.items.map((item) => ({
      item_id: item.itemId,
      ordinal: item.ordinal,
      attempt: item.attempt,
      run_id: item.runId,
      input_hash: item.inputHash,
      inputs: item.resolvedInputs,
      status: item.status,
      terminal_reason: item.terminalReason,
      supersedes_run_id: item.supersedesRunId,
    })),
    created_at: snapshot.batch.createdAt,
    updated_at: snapshot.batch.updatedAt,
  };
}

function batchError(c: Context, error: unknown): Response {
  if (error instanceof FlowBatchValidationError) {
    return c.json(
      { error: error.code, ...error.details },
      error.code === "batch_limit_exceeded" ? 413 : 422,
    );
  }
  if (error instanceof FlowBatchStoreError) {
    const status = error.code === "batch_draft_not_found"
      || error.code === "batch_not_found" ? 404 : 409;
    return c.json({ error: error.code }, status);
  }
  if (error instanceof FlowBatchServiceError) {
    const status = error.code === "source_run_not_found"
      || error.code === "batch_not_found" ? 404 : 409;
    return c.json({ error: error.code, ...error.details }, status);
  }
  throw error;
}

function draftIdentity(body: Record<string, unknown>): {
  sessionId: string;
  sourceRunId: string;
  flowId: string;
  definitionRevision: string;
} | null {
  const sessionId = stringValue(body.session_id);
  const sourceRunId = stringValue(body.source_run_id);
  const flowId = stringValue(body.flow_id);
  const definitionRevision = stringValue(body.definition_revision);
  return sessionId && sourceRunId && flowId && definitionRevision
    ? { sessionId, sourceRunId, flowId, definitionRevision }
    : null;
}

function draftCandidate(body: Record<string, unknown>): Record<string, unknown> {
  return {
    global_inputs: body.global_inputs,
    global_evidence: body.global_evidence,
    items: body.items,
    source_refs: body.source_refs,
  };
}

async function jsonRecord(c: Context): Promise<Record<string, unknown> | null> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
}

function actorName(value: unknown): string {
  return stringValue(value) || "web:local";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
