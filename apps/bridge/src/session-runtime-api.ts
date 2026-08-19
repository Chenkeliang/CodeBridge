import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SessionCatalogStore } from "@codebridge/session-catalog";
import type { SqliteEventStore } from "@codebridge/work-items";
import {
  SessionCommandError,
  type SessionCoordinator,
  type SubmitTurnResult,
} from "@codebridge/session-coordinator";
import type { RunExecutor } from "@codebridge/run-executor";
import type { FlowCatalogStore } from "@codebridge/flow-catalog";
import type { CapabilityRegistry } from "@codebridge/policy";
import {
  definitionHash,
  WorkflowValidationError,
  type PlanIR,
} from "@codebridge/workflow-engine";
import { randomUUID } from "node:crypto";
import {
  toApiRun,
  toApiSession,
  toApiSessionTurn,
  toApiTimeline,
} from "./session-runtime-types.js";
import { compileCatalogFlow } from "./flow-compile.js";

export interface SessionRuntimeApiOptions {
  catalog: SessionCatalogStore;
  workItems: SqliteEventStore;
  coordinator?: SessionCoordinator;
  executor?: RunExecutor;
  flows?: FlowCatalogStore;
  capabilities?: CapabilityRegistry;
}

export function registerSessionRuntimeCommandRoutes(
  app: Hono,
  options: SessionRuntimeApiOptions & {
    coordinator: SessionCoordinator;
  },
): void {
  app.post("/v1/sessions/:session_id/messages", async (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const key = c.req.header("idempotency-key");
    if (!key) return c.json({ error: "idempotency_key_required" }, 400);
    const body = await c.req.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    if (!body || typeof body.message !== "string" || !body.message.trim()) {
      return c.json({ error: "message_required" }, 400);
    }
    const attachments = parseAttachments(body.attachments);
    if (!attachments) return c.json({ error: "invalid_attachments" }, 400);
    const flowId = nullable(body.flow_id, session.flowId);
    const flow = flowId ? options.flows?.get(flowId) : undefined;
    if (flowId && !flow) {
      return c.json({ error: "flow_not_found", flow_id: flowId }, 404);
    }
    if (flow?.status === "deprecated") {
      return c.json({ error: "flow_deprecated", flow_id: flowId }, 409);
    }
    const dryRun = body.dry_run === true;
    let frozenPlan: PlanIR | null = null;
    if (flow?.kind === "runbook") {
      if (flow.status === "candidate" && !dryRun) {
        return c.json({ error: "flow_not_executable", flow_id: flowId }, 409);
      }
      try {
        frozenPlan = compileCatalogFlow(flow);
      } catch (error) {
        if (error instanceof WorkflowValidationError) {
          return c.json({ error: "invalid_flow", issues: error.issues }, 409);
        }
        throw error;
      }
      if (definitionHash(frozenPlan) !== flow.planIrHash) {
        return c.json({ error: "plan_ir_drift", flow_id: flowId }, 409);
      }
      const provided = inputRecord(body.inputs);
      const missing = flow.inputs
        .filter((input) => input.required && input.source === "user")
        .filter((input) => provided[input.id] === undefined || provided[input.id] === null)
        .map((input) => ({
          id: input.id,
          type: input.type,
          source: input.source,
          reason: "required" as const,
        }));
      if (missing.length > 0) {
        return c.json({ error: "missing_inputs", missing }, 409);
      }
    }
    const delivery = parseDelivery(body.delivery);
    if (delivery === null) {
      return c.json({ error: "invalid_delivery" }, 400);
    }
    try {
      const result = options.coordinator.submitTurn({
        sessionId: session.id,
        idempotencyKey: key,
        attachments,
        message: {
          text: body.message,
          attachmentIds: [],
          flowId,
          model: nullable(body.model, session.model),
          effort: nullable(body.effort, session.effort),
          permissionMode: nullable(
            body.permission_mode,
            session.permissionMode,
          ),
          plan: frozenPlan
            ? {
                ...frozenPlan,
                planIrHash: flow?.planIrHash ?? null,
              }
            : null,
        },
        workItem: {
          title: body.message.slice(0, 80),
          mode: "auto",
          conversationId: `conv_${session.id.replace(/^sess_/, "")}`,
          agentId: session.agentId,
          workspaceScope: session.cwd ? [session.cwd] : [],
          riskLevel: frozenPlan ? maxStepRisk(frozenPlan) : "read_only",
        },
        delivery,
      });
      options.catalog.updateSession(session.id, {
        taskRecordId: result.workItemId,
        flowId: result.turn.message.flowId,
        model: result.turn.message.model,
        effort: result.turn.message.effort,
        permissionMode: result.turn.message.permissionMode,
        title: session.title ?? body.message.slice(0, 80),
        status: "active",
      });
      if (result.run) observeExecution(options, result.run.id, dryRun);
      return c.json(toSubmitReceipt(options, result), 202);
    } catch (error) {
      return commandError(c, options, error);
    }
  });

  app.get(
    "/v1/sessions/:session_id/submissions/:idempotency_key",
    (c) => {
      const result = options.workItems.getIdempotencyResponse(
        `session:message:${c.req.param("session_id")}`,
        c.req.param("idempotency_key"),
      ) as SubmitTurnResult | undefined;
      return result
        ? c.json(toSubmitReceipt(options, result))
        : c.json({ error: "submission_not_found" }, 404);
    },
  );

  app.delete("/v1/sessions/:session_id/queue/:turn_id", (c) => {
    const headers = commandHeaders(c);
    if ("error" in headers) return c.json({ error: headers.error }, headers.status);
    try {
      const result = options.coordinator.cancelQueuedTurn({
        sessionId: c.req.param("session_id"),
        turnId: c.req.param("turn_id"),
        expectedVersion: headers.version,
        idempotencyKey: headers.key,
      });
      return c.json({
        turn: toApiSessionTurn(result.turn),
        runtime: runtimeView(options, c.req.param("session_id")),
      });
    } catch (error) {
      return commandError(c, options, error);
    }
  });

  app.post("/v1/sessions/:session_id/queue/resume", (c) => {
    const headers = commandHeaders(c);
    if ("error" in headers) return c.json({ error: headers.error }, headers.status);
    try {
      const result = options.coordinator.resumeQueue({
        sessionId: c.req.param("session_id"),
        expectedRuntimeVersion: headers.version,
        idempotencyKey: headers.key,
      });
      if (result.dispatched) {
        observeExecution(options, result.dispatched.run.id);
      }
      return c.json({
        runtime: runtimeView(options, c.req.param("session_id")),
      });
    } catch (error) {
      return commandError(c, options, error);
    }
  });

  app.post("/v1/runs/:run_id/cancel", (c) => {
    const headers = commandHeaders(c);
    if ("error" in headers) return c.json({ error: headers.error }, headers.status);
    const run = options.workItems.getRun(c.req.param("run_id"));
    if (!run?.sessionId) return c.json({ error: "run_not_found" }, 404);
    try {
      const result = options.coordinator.requestRunCancellation({
        sessionId: run.sessionId,
        runId: run.id,
        expectedRuntimeVersion: headers.version,
        idempotencyKey: headers.key,
      });
      if (result.disposition === "interrupting") {
        void options.executor?.cancelRunAndWait(run.id).catch(() => {});
      }
      return c.json({
        disposition: result.disposition,
        run: toApiRun(result.run, run.sessionId),
      }, result.disposition === "interrupting" ? 202 : 200);
    } catch (error) {
      return commandError(c, options, error);
    }
  });

  app.post("/v1/sessions/:session_id/runs", (c) =>
    c.json({
      error: "run_creation_moved",
      message: "POST /messages now creates or queues the Run atomically",
    }, 410));
}

export function registerSessionRuntimeReadRoutes(
  app: Hono,
  options: SessionRuntimeApiOptions,
): void {
  app.get("/v1/sessions/:session_id", (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const runtime = options.workItems.getSessionRuntime(session.id);
    const activeRun = runtime?.activeRunId
      ? options.workItems.getRun(runtime.activeRunId)
      : undefined;
    const queue = options.workItems.listQueuedTurns(session.id, {
      limit: 100,
    });
    const timeline = options.workItems.listTimelineTurns(session.id, {
      limit: 50,
      contentBudgetBytes: 1_048_576,
    });
    const workItem =
      options.workItems.getWorkItemBySessionId(session.id);
    return c.json({
      session: toApiSession({
        ...session,
        taskRecordId: session.taskRecordId ?? workItem?.id ?? null,
      }),
      runtime: {
        active_run: activeRun ? toApiRun(activeRun, session.id) : null,
        queue_state: runtime?.queueState ?? "ready",
        queue_pause_reason: runtime?.queuePauseReason ?? null,
        queue: {
          turns: queue.turns.map(toApiSessionTurn),
          total: queue.total,
          next_cursor: queue.nextCursor,
        },
        version: runtime?.version ?? 1,
        last_event_sequence: runtime?.lastEventSequence ?? 0,
      },
      timeline: toApiTimeline(timeline),
      commands: options.workItems.listSessionCommands(session.id),
    });
  });

  app.get("/v1/sessions/:session_id/timeline", (c) => {
    if (!options.catalog.getSession(c.req.param("session_id"))) {
      return c.json({ error: "session_not_found" }, 404);
    }
    return c.json(toApiTimeline(options.workItems.listTimelineTurns(
      c.req.param("session_id"),
      {
        before: integerQuery(c.req.query("before")),
        limit: integerQuery(c.req.query("limit")) ?? 50,
        contentBudgetBytes: 1_048_576,
      },
    )));
  });

  app.get(
    "/v1/sessions/:session_id/blocks/:block_id/segments",
    (c) => {
      if (!options.catalog.getSession(c.req.param("session_id"))) {
        return c.json({ error: "session_not_found" }, 404);
      }
      const page = options.workItems.listTimelineSegments(
        c.req.param("block_id"),
        {
          after: integerQuery(c.req.query("after")),
          limit: integerQuery(c.req.query("limit")) ?? 100,
        },
      );
      return c.json({
        segments: page.segments.map((segment) => ({
          segment_id: segment.segmentId,
          segment_index: segment.segmentIndex,
          content: segment.content,
          byte_length: segment.byteLength,
          sealed: segment.sealed,
        })),
        next_cursor: page.nextCursor,
      });
    },
  );

  app.get("/v1/sessions/:session_id/queue", (c) => {
    if (!options.catalog.getSession(c.req.param("session_id"))) {
      return c.json({ error: "session_not_found" }, 404);
    }
    const page = options.workItems.listQueuedTurns(
      c.req.param("session_id"),
      {
        afterPosition:
          integerQuery(c.req.query("after_position")),
        limit: integerQuery(c.req.query("limit")) ?? 100,
      },
    );
    return c.json({
      turns: page.turns.map(toApiSessionTurn),
      total: page.total,
      next_cursor: page.nextCursor,
    });
  });

  app.get("/v1/sessions/:session_id/events", (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    let workItem = options.workItems.getWorkItemBySessionId(session.id)
      ?? (session.taskRecordId
        ? options.workItems.getWorkItem(session.taskRecordId)
        : undefined);
    const after = integerQuery(c.req.query("after_sequence")) ?? 0;
    if (c.req.query("live") === "true") {
      return streamSSE(c, async (stream) => {
        let cursor = after;
        let aborted = false;
        stream.onAbort(() => { aborted = true; });
        while (!aborted) {
          workItem ??= options.workItems.getWorkItemBySessionId(session.id)
            ?? (options.catalog.getSession(session.id)?.taskRecordId
              ? options.workItems.getWorkItem(
                  options.catalog.getSession(session.id)!.taskRecordId!,
                )
              : undefined);
          const candidates = workItem
            ? options.workItems.listEventsPage(
                workItem.id,
                cursor,
                500,
              )
            : [];
          let bytes = 0;
          let wrote = false;
          for (const event of candidates) {
            const data = JSON.stringify(event);
            const size = Buffer.byteLength(data, "utf8");
            if (wrote && bytes + size > 1_048_576) break;
            await stream.writeSSE({
              id: String(event.sequence),
              event: "session_event",
              data,
            });
            cursor = event.sequence;
            bytes += size;
            wrote = true;
          }
          if (!wrote) await stream.sleep(250);
        }
      });
    }
    if (!workItem) {
      return c.json({
        events: [],
        next_sequence: after,
        has_more: false,
      });
    }
    const tail = integerQuery(c.req.query("tail"));
    if (tail !== undefined) {
      const events = options.workItems.listRecentEvents(
        workItem.id,
        Math.min(500, Math.max(1, tail)),
      );
      return c.json({
        events,
        next_sequence: events.at(-1)?.sequence ?? after,
        has_more: false,
      });
    }
    {
      const requested = integerQuery(c.req.query("limit")) ?? 500;
      const limit = Math.min(500, Math.max(1, requested));
      const rows = options.workItems.listEventsPage(
        workItem.id,
        after,
        limit + 1,
      );
      const events = rows.slice(0, limit);
      return c.json({
        events,
        next_sequence: events.at(-1)?.sequence ?? after,
        has_more: rows.length > events.length,
      });
    }
  });
}

function integerQuery(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value)) return undefined;
  return Number(value);
}

function nullable(value: unknown, fallback: string | null): string | null {
  return value === undefined
    ? fallback
    : typeof value === "string"
      ? value
      : null;
}

function parseDelivery(value: unknown): {
  channel: string;
  conversationId: string;
  replyToMessageId: string;
} | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return null;
  const delivery = value as Record<string, unknown>;
  if (
    typeof delivery.channel !== "string"
    || typeof delivery.conversation_id !== "string"
    || typeof delivery.reply_to_message_id !== "string"
  ) {
    return null;
  }
  return {
    channel: delivery.channel,
    conversationId: delivery.conversation_id,
    replyToMessageId: delivery.reply_to_message_id,
  };
}

function parseAttachments(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const result: Array<{
    id: string;
    name: string;
    mimeType: string;
    dataBase64: string;
  }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const attachment = item as Record<string, unknown>;
    const name = attachment.name;
    const mimeType = attachment.mime_type ?? attachment.mimeType;
    const dataBase64 = attachment.data_base64 ?? attachment.dataBase64;
    if (
      typeof name !== "string"
      || typeof mimeType !== "string"
      || typeof dataBase64 !== "string"
    ) {
      return null;
    }
    result.push({
      id: `att_${randomUUID().replaceAll("-", "")}`,
      name,
      mimeType,
      dataBase64,
    });
  }
  return result;
}

function runtimeView(
  options: SessionRuntimeApiOptions,
  sessionId: string,
) {
  const runtime = options.workItems.getSessionRuntime(sessionId);
  const activeRun = runtime?.activeRunId
    ? options.workItems.getRun(runtime.activeRunId)
    : undefined;
  const queue = options.workItems.listQueuedTurns(sessionId, {
    limit: 100,
  });
  return {
    active_run: activeRun ? toApiRun(activeRun, sessionId) : null,
    queue_state: runtime?.queueState ?? "ready",
    queue_pause_reason: runtime?.queuePauseReason ?? null,
    queue: {
      turns: queue.turns.map(toApiSessionTurn),
      total: queue.total,
      next_cursor: queue.nextCursor,
    },
    version: runtime?.version ?? 1,
    last_event_sequence: runtime?.lastEventSequence ?? 0,
  };
}

function toSubmitReceipt(
  options: SessionRuntimeApiOptions,
  result: SubmitTurnResult,
) {
  return {
    acceptance: result.acceptance,
    turn: toApiSessionTurn(result.turn),
    runtime: runtimeView(options, result.turn.sessionId),
  };
}

function commandHeaders(c: Context):
  | { key: string; version: number }
  | { error: string; status: 400 | 428 } {
  const key = c.req.header("idempotency-key");
  if (!key) return { error: "idempotency_key_required", status: 400 };
  const raw = c.req.header("if-match");
  if (!raw || !/^\d+$/.test(raw)) {
    return { error: "if_match_required", status: 428 };
  }
  return { key, version: Number(raw) };
}

function commandError(
  c: Context,
  options: SessionRuntimeApiOptions,
  error: unknown,
) {
  if (!(error instanceof SessionCommandError)) throw error;
  const payload: Record<string, unknown> = { error: error.code };
  if (error.code === "turn_version_conflict") {
    const turnId = c.req.param("turn_id");
    payload.turn = turnId
      ? options.workItems.getTurn(turnId)
      : undefined;
  }
  if (error.code === "runtime_version_conflict") {
    const runId = c.req.param("run_id");
    const sessionId = c.req.param("session_id")
      || (runId ? options.workItems.getRun(runId)?.sessionId : null);
    if (sessionId) payload.runtime = runtimeView(options, sessionId);
  }
  if (error.status === 404) return c.json(payload, 404);
  if (error.status === 409) return c.json(payload, 409);
  return c.json(payload, 422);
}

function observeExecution(
  options: SessionRuntimeApiOptions,
  runId: string,
  dryRun?: boolean,
): void {
  void options.executor?.execute(runId, undefined, { dryRun }).catch(() => {});
}

function inputRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function maxStepRisk(
  plan: PlanIR,
): "read_only" | "workspace_write" | "git_write" | "production_write" {
  const rank: Record<string, number> = {
    read_only: 0,
    workspace_write: 1,
    git_write: 2,
    production_write: 3,
  };
  let best: "read_only" | "workspace_write" | "git_write" | "production_write" =
    "read_only";
  for (const step of plan.steps) {
    if ((rank[step.risk] ?? -1) > rank[best]!) {
      best = step.risk as typeof best;
    }
  }
  return best;
}
