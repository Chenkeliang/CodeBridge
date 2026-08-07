import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  SqliteEventStore,
  type DomainEvent,
  type WorkItem,
  type WorkItemMode,
} from "@codebridge/work-items";
import type { ApprovalService } from "@codebridge/policy";

const WORK_ITEM_MODES: readonly WorkItemMode[] = [
  "investigation",
  "change",
  "review",
  "release",
  "observe",
];

type ErrorStatus = 400 | 401 | 404 | 409 | 503;

export function createWorkItemApp(
  store: SqliteEventStore,
  token: string,
  approvals?: ApprovalService,
) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) {
      return errorResponse(c, 401, "unauthorized", "未授权");
    }
    await next();
  });

  app.post("/v1/work-items", async (c) => {
    const body = await readJson(c);
    const input = parseCreateInput(body);
    if (!input) {
      return errorResponse(
        c,
        400,
        "invalid_work_item",
        "conversation_id、title、agent_id、mode 和 message 必填",
      );
    }

    try {
      const workItem = store.createWorkItem(input);
      store.appendEvent({
        workItemId: workItem.id,
        type: "MESSAGE_RECEIVED",
        actor: "user",
        payload: { message: input.message },
      });
      return c.json(toApiWorkItem(workItem), 201);
    } catch (error) {
      return errorResponse(c, 400, "work_item_create_failed", messageOf(error));
    }
  });

  app.get("/v1/work-items/:work_item_id", (c) => {
    const workItem = store.getWorkItem(c.req.param("work_item_id"));
    if (!workItem) {
      return errorResponse(c, 404, "work_item_not_found", "WorkItem 不存在");
    }
    return c.json(toApiWorkItem(workItem));
  });

  app.post("/v1/work-items/:work_item_id/messages", async (c) => {
    const workItemId = c.req.param("work_item_id");
    if (!store.getWorkItem(workItemId)) {
      return errorResponse(c, 404, "work_item_not_found", "WorkItem 不存在");
    }
    const body = await readJson(c);
    if (
      !body ||
      typeof body.message !== "string" ||
      body.message.trim() === ""
    ) {
      return errorResponse(c, 400, "invalid_message", "message 必填");
    }

    const event = store.appendEvent({
      workItemId,
      type: "MESSAGE_RECEIVED",
      actor: body.actor === "channel" ? "channel" : "user",
      payload: { message: body.message },
    });
    return c.json(
      {
        request_id: `req_${randomUUID().replaceAll("-", "")}`,
        accepted: true,
        event_id: event.eventId,
        sequence: event.sequence,
      },
      202,
    );
  });

  app.post("/v1/work-items/:work_item_id/runs", async (c) => {
    const workItemId = c.req.param("work_item_id");
    const workItem = store.getWorkItem(workItemId);
    if (!workItem) {
      return errorResponse(c, 404, "work_item_not_found", "WorkItem 不存在");
    }

    const body = await readJson(c);
    if (
      !body ||
      typeof body.mode !== "string" ||
      !WORK_ITEM_MODES.includes(body.mode as WorkItemMode)
    ) {
      return errorResponse(c, 400, "invalid_run", "mode 必须是有效的 Run 模式");
    }
    if (
      body.plan_id !== undefined &&
      body.plan_id !== null &&
      typeof body.plan_id !== "string"
    ) {
      return errorResponse(c, 400, "invalid_run", "plan_id 无效");
    }

    try {
      const run = store.createRun({
        workItemId,
        mode: body.mode as WorkItemMode,
        planId: (body.plan_id as string | null | undefined) ?? null,
      });
      return c.json({ run_id: run.id, status: run.status }, 202);
    } catch (error) {
      return errorResponse(c, 400, "run_create_failed", messageOf(error));
    }
  });

  app.post("/v1/runs/:run_id/approve", async (c) => {
    if (!approvals) {
      return errorResponse(c, 503, "approval_unavailable", "审批服务未配置");
    }
    const run = store.getRun(c.req.param("run_id"));
    if (!run) return errorResponse(c, 404, "run_not_found", "Run 不存在");
    const body = await readJson(c);
    if (!body || typeof body.approval_id !== "string") {
      return errorResponse(c, 400, "invalid_approval", "approval_id 必填");
    }
    const approval = approvals.get(body.approval_id);
    if (!approval || approval.runId !== run.id) {
      return errorResponse(c, 404, "approval_not_found", "审批记录不存在");
    }
    const granted = approvals.grant(approval.id, body.granted_by === "system" ? "system" : "user");
    if (!granted || granted.status !== "granted") {
      return errorResponse(c, 409, "approval_not_grantable", "审批已过期或已处理");
    }
    return c.json({ approval_id: granted.id, status: granted.status, granted_at: granted.grantedAt });
  });

  app.get("/v1/work-items/:work_item_id/events", (c) => {
    const workItemId = c.req.param("work_item_id");
    if (!store.getWorkItem(workItemId)) {
      return errorResponse(c, 404, "work_item_not_found", "WorkItem 不存在");
    }
    const afterSequenceValue = c.req.query("after_sequence") ?? "0";
    const afterSequence = Number(afterSequenceValue);
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      return errorResponse(c, 400, "invalid_after_sequence", "after_sequence 无效");
    }

    const stream = store
      .listEvents(workItemId, afterSequence)
      .map(toSseEvent)
      .join("");
    return new Response(stream, {
      status: 200,
      headers: {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      },
    });
  });

  return app;
}

function parseCreateInput(
  body: Record<string, unknown> | null,
):
  | (Parameters<SqliteEventStore["createWorkItem"]>[0] & {
      message: string;
    })
  | null {
  if (!body) return null;
  const requiredStrings = ["conversation_id", "title", "agent_id", "message"];
  if (requiredStrings.some((key) => !isNonEmptyString(body[key]))) {
    return null;
  }
  if (
    typeof body.mode !== "string" ||
    !WORK_ITEM_MODES.includes(body.mode as WorkItemMode)
  ) {
    return null;
  }
  if (
    body.workflow_id !== undefined &&
    body.workflow_id !== null &&
    typeof body.workflow_id !== "string"
  ) {
    return null;
  }
  if (body.workspace_scope !== undefined && !isStringArray(body.workspace_scope)) {
    return null;
  }
  if (body.identifiers !== undefined && !isRecord(body.identifiers)) {
    return null;
  }

  return {
    title: body.title as string,
    mode: body.mode as WorkItemMode,
    conversationId: body.conversation_id as string,
    agentId: body.agent_id as string,
    workflowId: (body.workflow_id as string | null | undefined) ?? null,
    workflowRevision: null,
    workspaceScope: (body.workspace_scope as string[] | undefined) ?? [],
    identifiers: (body.identifiers as Record<string, unknown> | undefined) ?? {},
    riskLevel: "read_only",
    message: body.message as string,
  };
}

async function readJson(
  c: { req: { json: () => Promise<unknown> } },
): Promise<Record<string, unknown> | null> {
  const body = await c.req.json().catch(() => null);
  return isRecord(body) ? body : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function toApiWorkItem(workItem: WorkItem): Record<string, unknown> {
  return {
    schema_version: workItem.schemaVersion,
    id: workItem.id,
    title: workItem.title,
    status: workItem.status,
    mode: workItem.mode,
    conversation_id: workItem.conversationId,
    agent_id: workItem.agentId,
    workflow_id: workItem.workflowId,
    workflow_revision: workItem.workflowRevision,
    workspace_scope: workItem.workspaceScope,
    identifiers: workItem.identifiers,
    context_revision: workItem.contextRevision,
    risk_level: workItem.riskLevel,
    created_at: workItem.createdAt,
    updated_at: workItem.updatedAt,
  };
}

function toSseEvent(event: DomainEvent): string {
  return [
    `id: ${event.eventId}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify({
      schema_version: event.schemaVersion,
      event_id: event.eventId,
      sequence: event.sequence,
      work_item_id: event.workItemId,
      run_id: event.runId,
      type: event.type,
      occurred_at: event.occurredAt,
      actor: event.actor,
      target: event.target,
      input_hash: event.inputHash,
      result_ref: event.resultRef,
      payload: event.payload,
    })}`,
    "",
    "",
  ].join("\n");
}

function errorResponse(
  c: { json: (value: unknown, status: ErrorStatus) => Response },
  status: ErrorStatus,
  code: string,
  message: string,
  retryable = false,
) {
  return c.json(
    {
      error: {
        code,
        message,
        retryable,
        request_id: `req_${randomUUID().replaceAll("-", "")}`,
      },
    },
    status,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
