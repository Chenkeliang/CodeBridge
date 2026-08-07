import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type {
  AgentProfile,
  SessionCatalogStore,
} from "@codebridge/session-catalog";
import type { SqliteEventStore } from "@codebridge/work-items";
import type { RunExecutor } from "@codebridge/run-executor";
import type { RunnerClient } from "@codebridge/runner-client";

export interface SessionApiOptions {
  catalog: SessionCatalogStore;
  agents: AgentProfile[];
  workItems: SqliteEventStore;
  executor?: RunExecutor;
  runner?: RunnerClient;
  defaultCwd?: string;
}

export function createSessionApp(options: SessionApiOptions, token: string) {
  const app = new Hono();
  const profiles = new Map(options.agents.map((agent) => [agent.agentId, agent]));

  app.use("/v1/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/v1/agents", (c) => c.json({ agents: options.agents.map(toApiAgent) }));

  app.get("/v1/agents/:agent_id", (c) => {
    const agent = profiles.get(c.req.param("agent_id"));
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    return c.json(toApiAgent(agent));
  });

  app.get("/v1/sessions", async (c) => {
    const agentId = c.req.query("agent_id");
    const importSessions = c.req.query("import") === "true";
    const cwd = c.req.query("cwd") ?? options.defaultCwd;
    const sync = importSessions && cwd ? await syncProviderSessions(options, profiles, agentId, cwd) : undefined;
    return c.json({
      sessions: options.catalog.listSessions(agentId).map((session) => ({
        ...toApiSession(session),
        agent: profiles.get(session.agentId)?.displayName ?? session.agentId,
      })),
      provider_errors: sync?.errors ?? [],
    });
  });

  app.post("/v1/sessions", async (c) => {
    const body = await readJson(c);
    const agent = typeof body?.agent_id === "string" ? profiles.get(body.agent_id) : undefined;
    if (!agent) {
      return c.json({ error: "agent_id must reference a registered Agent" }, 400);
    }
    if (agent.status !== "healthy") {
      return c.json({ error: "agent_unavailable", status: agent.status }, 409);
    }
    const sessionBody = body ?? {};
    const requestedCwd = asNullableString(sessionBody.cwd);
    let cwd = requestedCwd;
    if (requestedCwd && options.runner) {
      const authorization = await options.runner.authorizeDirectory(requestedCwd);
      if (!authorization.ok) {
        return c.json(
          { error: "workspace_not_authorized", detail: authorization.error ?? "目录无法访问" },
          403,
        );
      }
      cwd = authorization.path ?? requestedCwd;
    }
    const session = options.catalog.createSession({
      agentId: agent.agentId,
      folderId: asNullableString(sessionBody.folder_id),
      cwd,
      title: asNullableString(sessionBody.title),
    });
    return c.json(toApiSession(session), 201);
  });

  app.get("/v1/sessions/:session_id", (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    return c.json(toApiSession(session));
  });

  app.post("/v1/sessions/:session_id/messages", async (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    const body = await readJson(c);
    if (!session) return c.json({ error: "session_not_found" }, 404);
    if (!body || typeof body.message !== "string" || !body.message.trim()) {
      return c.json({ error: "message is required" }, 400);
    }

    const task = session.taskRecordId
      ? options.workItems.getWorkItem(session.taskRecordId)
      : undefined;
    const flowId = Object.hasOwn(body, "flow_id")
      ? asNullableString(body.flow_id)
      : session.flowId;
    const workItem =
      task ??
      options.workItems.createWorkItem({
        title: deriveTitle(body.message),
        mode: "auto",
        conversationId: `conv_${session.id.slice("sess_".length)}`,
        agentId: session.agentId,
        workflowId: flowId,
        workspaceScope: session.cwd ? [session.cwd] : [],
        riskLevel: "read_only",
      });
    if (task && task.workflowId !== flowId) {
      options.workItems.updateWorkflowBinding(task.id, flowId);
    }
    const event = options.workItems.appendEvent({
      workItemId: workItem.id,
      type: "MESSAGE_RECEIVED",
      actor: "user",
      payload: { message: body.message },
    });
    options.catalog.updateSession(session.id, {
      taskRecordId: workItem.id,
      flowId,
      title: session.title ?? deriveTitle(body.message),
      status: "active",
    });
    return c.json(
      {
        request_id: `req_${randomUUID().replaceAll("-", "")}`,
        accepted: true,
        session_id: session.id,
        task_record_id: workItem.id,
        event_id: event.eventId,
        sequence: event.sequence,
      },
      202,
    );
  });

  app.post("/v1/sessions/:session_id/runs", async (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const body = await readJson(c);
    const task = session.taskRecordId ? options.workItems.getWorkItem(session.taskRecordId) : undefined;
    if (!task) return c.json({ error: "message_required", message: "先向 Session 发送消息" }, 409);
    const flowId = body && Object.hasOwn(body, "flow_id")
      ? asNullableString(body.flow_id)
      : session.flowId;
    if (task.workflowId !== flowId) options.workItems.updateWorkflowBinding(task.id, flowId);
    options.catalog.updateSession(session.id, { flowId });
    const run = options.workItems.createRun({
      workItemId: task.id,
      mode: "auto",
      agentId: session.agentId,
    });
    if (options.executor) void options.executor.execute(run.id).catch(() => {});
    return c.json({ run_id: run.id, status: run.status }, 202);
  });

  app.post("/v1/sessions/:session_id/resume", (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    if (!session.providerSessionId) return c.json({ error: "provider_session_not_bound" }, 409);
    return c.json(toApiSession(options.catalog.updateSession(session.id, { status: "active" })!));
  });

  app.post("/v1/sessions/:session_id/fork", async (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    if (!options.runner) return c.json({ error: "runner_unavailable" }, 503);
    if (!session.providerSessionId || !session.cwd) {
      return c.json({ error: "provider_session_not_bound" }, 409);
    }
    const body = await readJson(c);
    const targetCwd = asNullableString(body?.target_cwd) ?? session.cwd;
    const result = await options.runner.forkSession(
      session.agentId,
      session.cwd,
      session.providerSessionId,
      targetCwd,
    );
    if (!result.ok || !result.sessionId) return c.json(result, 409);
    const forked = options.catalog.createSession({
      agentId: session.agentId,
      providerSessionId: result.sessionId,
      folderId: session.folderId,
      cwd: result.cwd ?? targetCwd,
      additionalDirectories: session.additionalDirectories,
      title: asNullableString(body?.title) ?? session.title,
    });
    return c.json(toApiSession(forked), 201);
  });

  app.post("/v1/directories/authorize", async (c) => {
    if (!options.runner) return c.json({ ok: false, error: "runner_unavailable" }, 503);
    const body = await readJson(c);
    if (!body || typeof body.path !== "string" || !body.path.trim()) return c.json({ ok: false, error: "path is required" }, 400);
    const result = await options.runner.authorizeDirectory(body.path);
    return c.json(result, result.ok ? 200 : 403);
  });

  app.get("/v1/sessions/:session_id/events", (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    if (!session.taskRecordId || !options.workItems.getWorkItem(session.taskRecordId)) {
      return new Response("", {
        headers: { "cache-control": "no-cache", "content-type": "text/event-stream; charset=utf-8" },
      });
    }
    const after = Number(c.req.query("after_sequence") ?? "0");
    if (!Number.isInteger(after) || after < 0) return c.json({ error: "invalid_after_sequence" }, 400);
    const stream = options.workItems
      .listEvents(session.taskRecordId, after)
      .map((event) => toSseEvent(event))
      .join("");
    return new Response(stream, {
      headers: { "cache-control": "no-cache", "content-type": "text/event-stream; charset=utf-8" },
    });
  });

  app.post("/v1/sessions/:session_id/close", async (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    if (options.runner && session.providerSessionId && session.cwd) {
      const result = await options.runner.closeSession(session.agentId, session.cwd, session.providerSessionId);
      if (!result.ok) return c.json(result, 409);
    }
    return c.json(toApiSession(options.catalog.updateSession(session.id, { status: "closed" })!));
  });

  app.delete("/v1/sessions/:session_id", (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    if (!options.catalog.deleteSession(session.id)) return c.json({ error: "session_not_found" }, 404);
    return c.body(null, 204);
  });

  return app;
}

async function syncProviderSessions(
  options: SessionApiOptions,
  profiles: Map<string, AgentProfile>,
  agentId: string | undefined,
  cwd: string,
): Promise<{ errors: string[] }> {
  if (!options.runner) return { errors: [] };
  const ids = agentId ? [agentId] : [...profiles.keys()];
  const errors: string[] = [];
  for (const id of ids) {
    const profile = profiles.get(id);
    if (!profile || profile.status !== "healthy") continue;
    try {
      const result = await options.runner.listSessions(id, cwd, { all: true, limit: 100 });
      for (const provider of result.sessions) {
        const existing = options.catalog.getByProviderSession(id, provider.id);
        const session = existing ?? options.catalog.createSession({
          agentId: id,
          providerSessionId: provider.id,
          cwd: provider.cwd,
          additionalDirectories: provider.additionalDirectories,
          title: provider.preview || null,
        });
        options.catalog.updateSession(session.id, {
          providerSessionId: provider.id,
          cwd: provider.cwd,
          additionalDirectories: provider.additionalDirectories,
          title: provider.preview || session.title,
          status: "idle",
        });
      }
      if (result.error) errors.push(result.error);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { errors };
}

function toApiAgent(agent: AgentProfile): Record<string, unknown> {
  return {
    agent_id: agent.agentId,
    display_name: agent.displayName,
    adapter: agent.adapter,
    status: agent.status,
    capabilities: agent.capabilities,
    models: agent.models,
    session_features: agent.sessionFeatures,
  };
}

function toApiSession(session: ReturnType<SessionCatalogStore["getSession"]>): Record<string, unknown> {
  if (!session) throw new Error("session is required");
  return {
    schema_version: session.schemaVersion,
    session_id: session.id,
    agent_id: session.agentId,
    provider_session_id: session.providerSessionId,
    task_record_id: session.taskRecordId,
    flow_id: session.flowId,
    folder_id: session.folderId,
    cwd: session.cwd,
    additional_directories: session.additionalDirectories,
    title: session.title,
    status: session.status,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

function toSseEvent(event: {
  eventId: string;
  sequence: number;
  runId: string | null;
  type: string;
  occurredAt: string;
  actor: string;
  target: string | null;
  inputHash: string | null;
  resultRef: string | null;
  payload: Record<string, unknown>;
}): string {
  return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify({
    event_id: event.eventId,
    sequence: event.sequence,
    run_id: event.runId,
    type: event.type,
    occurred_at: event.occurredAt,
    actor: event.actor,
    target: event.target,
    input_hash: event.inputHash,
    result_ref: event.resultRef,
    payload: event.payload,
  })}\n\n`;
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function deriveTitle(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 48 ? `${compact.slice(0, 47)}…` : compact;
}
