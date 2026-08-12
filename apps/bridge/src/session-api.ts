import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type {
  AgentProfile,
  AgentSession,
  SessionCatalogStore,
  UpdateSessionInput,
} from "@codebridge/session-catalog";
import type { SqliteEventStore } from "@codebridge/work-items";
import type { RunExecutor } from "@codebridge/run-executor";
import type { RunnerClient } from "@codebridge/runner-client";
import type { ProjectDiscovery } from "@codebridge/project-catalog";
import type { FlowCatalogStore, FlowRecord } from "@codebridge/flow-catalog";
import { compileWorkflow, WorkflowValidationError } from "@codebridge/workflow-engine";
import type { ApprovalService, CapabilityRegistry } from "@codebridge/policy";

export interface SessionApiOptions {
  catalog: SessionCatalogStore;
  agents: AgentProfile[] | (() => AgentProfile[]);
  workItems: SqliteEventStore;
  executor?: RunExecutor;
  runner?: RunnerClient;
  discovery?: ProjectDiscovery;
  flows?: FlowCatalogStore;
  capabilities?: CapabilityRegistry;
  approvals?: ApprovalService;
  defaultCwd?: string;
}

export function createSessionApp(options: SessionApiOptions, token: string) {
  const app = new Hono();
  const currentAgents = () => typeof options.agents === "function" ? options.agents() : options.agents;
  const currentProfiles = () => new Map(currentAgents().map((agent) => [agent.agentId, agent]));
  const historyHydrations = new Map<string, Promise<void>>();
  const historyRetryAfter = new Map<string, number>();
  const configOptionRequests = new Map<string, Promise<Awaited<ReturnType<RunnerClient["listConfigOptions"]>>>>();

  async function hydrateProviderHistory(session: AgentSession): Promise<AgentSession> {
    if (!options.runner || !session.providerSessionId) return session;
    if ((historyRetryAfter.get(session.id) ?? 0) > Date.now()) return session;
    const existingWorkItem = session.taskRecordId
      ? options.workItems.getWorkItem(session.taskRecordId)
      : undefined;
    let hydration = historyHydrations.get(session.id);
    if (!hydration) {
      hydration = (async () => {
        const history = await options.runner!.loadSessionHistory(
          session.agentId,
          session.cwd ?? options.defaultCwd ?? process.cwd(),
          session.providerSessionId!,
          session.additionalDirectories,
        );
        const workItem = existingWorkItem ?? options.workItems.createWorkItem({
            title: session.title ?? "Imported Session",
            mode: "auto",
            conversationId: `conv_${session.id.slice("sess_".length)}`,
            agentId: session.agentId,
            workflowId: session.flowId,
            workspaceScope: session.cwd ? [session.cwd] : [],
            riskLevel: "read_only",
          });
        const persistedInputHashes = options.workItems.listEventInputHashes(workItem.id);
        let persistedEvents: ReturnType<SqliteEventStore["listEvents"]> | undefined;
        const existingEvents = () => {
          if (!persistedEvents) {
            persistedEvents = persistedInputHashes.size > 0
              ? options.workItems.listRecentEvents(workItem.id, 2_000)
              : options.workItems.listEvents(workItem.id);
          }
          return persistedEvents;
        };
        const existingHistory = new Map<string, number>();
        let existingHistoryLoaded = false;
        const loadExistingHistory = () => {
          if (existingHistoryLoaded) return;
          existingHistoryLoaded = true;
          for (const event of existingEvents()) {
            const key = event.type === "MESSAGE_RECEIVED" && typeof event.payload.message === "string"
              ? `message:${event.payload.message}`
              : event.type === "AGENT_EVENT" && event.payload.event
                ? `agent:${JSON.stringify(event.payload.event)}`
                : undefined;
            if (key) existingHistory.set(key, (existingHistory.get(key) ?? 0) + 1);
          }
        };
        const historyInputHash = (position: string | number) => `sha256:${createHash("sha256")
          .update(`${session.agentId}\0${session.providerSessionId}\0${position}`)
          .digest("hex")}`;
        for (const [index, item] of history.entries()) {
          if (persistedInputHashes.has(historyInputHash(index))) continue;
          loadExistingHistory();
          const key = item.kind === "message"
            ? `message:${item.text}`
            : `agent:${JSON.stringify(item.event)}`;
          const remaining = existingHistory.get(key) ?? 0;
          if (remaining > 0) {
            existingHistory.set(key, remaining - 1);
            continue;
          }
          if (item.kind === "agent_event" && isProviderSnapshotCovered(existingEvents(), item.event)) continue;
          options.workItems.appendEventOnce(item.kind === "message"
            ? {
                workItemId: workItem.id,
                type: "MESSAGE_RECEIVED",
                actor: "user",
                inputHash: historyInputHash(index),
                payload: { message: item.text },
              }
            : {
                workItemId: workItem.id,
                type: "AGENT_EVENT",
                actor: "agent",
                inputHash: historyInputHash(index),
                payload: { event: item.event },
              });
        }
        if (history.some((item) => item.kind === "agent_event" && isAgentResponse(item.event))) {
          options.workItems.appendEventOnce({
            workItemId: workItem.id,
            type: "SESSION_HISTORY_HYDRATED",
            actor: "system",
            inputHash: historyInputHash("complete"),
            payload: { providerSessionId: session.providerSessionId },
          });
          historyRetryAfter.delete(session.id);
        } else {
          historyRetryAfter.set(session.id, Date.now() + 30_000);
        }
        options.catalog.updateSession(session.id, { taskRecordId: workItem.id });
      })();
      historyHydrations.set(session.id, hydration);
    }
    try {
      await hydration;
    } catch {
      // Provider history may be temporarily unavailable; a later Session open retries it.
      historyRetryAfter.set(session.id, Date.now() + 30_000);
    } finally {
      if (historyHydrations.get(session.id) === hydration) historyHydrations.delete(session.id);
    }
    return options.catalog.getSession(session.id) ?? session;
  }

  app.use("/v1/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/v1/agents", (c) => c.json({ agents: currentAgents().map(toApiAgent) }));

  app.get("/v1/agents/:agent_id", (c) => {
    const agent = currentProfiles().get(c.req.param("agent_id"));
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    return c.json(toApiAgent(agent));
  });

  app.get("/v1/attachments/:attachment_id", (c) => {
    const attachment = options.workItems.getMessageAttachment(c.req.param("attachment_id"));
    if (!attachment) return c.json({ error: "attachment_not_found" }, 404);
    return c.json(toApiAttachment(attachment));
  });

  app.get("/v1/sessions", async (c) => {
    const agentId = c.req.query("agent_id");
    const importSessions = c.req.query("import") === "true";
    const cwd = c.req.query("cwd") ?? options.defaultCwd;
    const profiles = currentProfiles();
    const sync = importSessions && cwd ? await syncProviderSessions(options, profiles, agentId, cwd) : undefined;
    return c.json({
      sessions: options.catalog.listSessions(agentId, {
        includeArchived: c.req.query("include_archived") === "true",
      }).map((session) => ({
        ...toApiSession(session),
        agent: profiles.get(session.agentId)?.displayName ?? session.agentId,
      })),
      provider_errors: sync?.errors ?? [],
    });
  });

  app.post("/v1/sessions", async (c) => {
    const body = await readJson(c);
    const agent = typeof body?.agent_id === "string" ? currentProfiles().get(body.agent_id) : undefined;
    if (!agent) {
      return c.json({ error: "agent_id must reference a registered Agent" }, 400);
    }
    if (agent.status !== "healthy") {
      return c.json({ error: "agent_unavailable", status: agent.status }, 409);
    }
    const idempotencyKey = c.req.header("idempotency-key");
    if (idempotencyKey) {
      const cached = options.workItems.getIdempotencyResponse("session:create", idempotencyKey);
      if (cached !== undefined) return c.json(cached, 201);
    }
    const sessionBody = body ?? {};
    const configOverrides = Object.hasOwn(sessionBody, "config_overrides")
      ? parseConfigOverrides(sessionBody.config_overrides)
      : {};
    if (!configOverrides) return c.json({ error: "config_overrides must contain only string or boolean values" }, 400);
    const requestedCwd = asNullableString(sessionBody.cwd) ?? options.defaultCwd ?? null;
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
      model: asNullableString(sessionBody.model),
      effort: asNullableString(sessionBody.effort),
      configOverrides,
      permissionMode: asNullableString(sessionBody.permission_mode),
      folderId: asNullableString(sessionBody.folder_id),
      cwd,
      title: asNullableString(sessionBody.title),
    });
    const response = toApiSession(session);
    if (idempotencyKey) options.workItems.putIdempotencyResponse("session:create", idempotencyKey, response);
    return c.json(response, 201);
  });

  app.post("/v1/channels/:channel/conversations/:conversation_id/messages", async (c) => {
    const body = await readJson(c);
    if (!body || typeof body.message !== "string" || !body.message.trim()) {
      return c.json({ error: "message is required" }, 400);
    }
    const channel = c.req.param("channel");
    const conversationId = c.req.param("conversation_id");
    let session = options.catalog.getChannelSession(channel, conversationId);
    if (!session) {
      const requestedAgent = typeof body.agent_id === "string" ? currentProfiles().get(body.agent_id) : undefined;
      const agent = requestedAgent ?? currentAgents().find((candidate) => candidate.status === "healthy");
      if (!agent) return c.json({ error: "agent_unavailable" }, 409);
      let cwd = asNullableString(body.cwd);
      if (cwd && options.runner) {
        const authorization = await options.runner.authorizeDirectory(cwd);
        if (!authorization.ok) {
          return c.json({ error: "workspace_not_authorized", detail: authorization.error ?? "目录无法访问" }, 403);
        }
        cwd = authorization.path ?? cwd;
      }
      session = options.catalog.createSession({
        agentId: agent.agentId,
        model: asNullableString(body.model),
        effort: asNullableString(body.effort),
        permissionMode: asNullableString(body.permission_mode),
        cwd: cwd ?? options.defaultCwd ?? null,
        title: asNullableString(body.title),
      });
      options.catalog.bindChannelConversation(channel, conversationId, session.id);
    }
    const idempotencyKey = c.req.header("idempotency-key");
    const childHeaders = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(idempotencyKey ? { "idempotency-key": `${idempotencyKey}:message` } : {}),
    };
    const messageResponse = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: childHeaders,
      body: JSON.stringify({
        message: body.message,
        flow_id: asNullableString(body.flow_id),
        model: asNullableString(body.model),
        attachments: body.attachments,
      }),
    });
    if (!messageResponse.ok) return c.json(await messageResponse.json(), messageResponse.status as 400 | 404 | 409 | 503);
    const messageResult = await messageResponse.json() as { task_record_id: string; sequence: number };
    const runResponse = await app.request(`/v1/sessions/${session.id}/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": `${idempotencyKey}:run` } : {}),
      },
      body: JSON.stringify({
        flow_id: asNullableString(body.flow_id),
        model: asNullableString(body.model),
      }),
    });
    if (!runResponse.ok) return c.json(await runResponse.json(), runResponse.status as 400 | 404 | 409 | 503);
    const runResult = await runResponse.json() as Record<string, unknown>;
    return c.json({
      channel,
      conversation_id: conversationId,
      session_id: session.id,
      task_record_id: messageResult.task_record_id,
      event_sequence: messageResult.sequence,
      ...runResult,
    }, 202);
  });

  app.post("/v1/channels/:channel/conversations/:conversation_id/cancel", async (c) => {
    const session = options.catalog.getChannelSession(c.req.param("channel"), c.req.param("conversation_id"));
    if (!session?.taskRecordId) return c.json({ stopped: false });
    const run = options.workItems.listRuns(session.taskRecordId).reverse().find((candidate) => ["queued", "running", "waiting"].includes(candidate.status));
    if (!run) return c.json({ stopped: false });
    if (options.executor) await options.executor.cancelRunAndWait(run.id);
    else {
      options.workItems.updateRunStatus(run.id, "cancelled");
      options.workItems.appendEvent({
        workItemId: run.workItemId,
        runId: run.id,
        type: "RUN_CANCELLED",
        actor: "channel",
        target: run.id,
      });
    }
    return c.json({ stopped: true, run_id: run.id });
  });

  app.post("/v1/channels/:channel/conversations/:conversation_id/reset", (c) => {
    return c.json({
      reset: options.catalog.unbindChannelConversation(
        c.req.param("channel"),
        c.req.param("conversation_id"),
      ),
    });
  });

  app.post("/v1/channels/:channel/conversations/:conversation_id/approval", async (c) => {
    if (!options.approvals) return c.json({ resolved: false, error: "approval_unavailable" }, 503);
    const session = options.catalog.getChannelSession(c.req.param("channel"), c.req.param("conversation_id"));
    if (!session?.taskRecordId) return c.json({ resolved: false });
    const run = options.workItems.listRuns(session.taskRecordId).reverse().find((candidate) => candidate.status === "waiting");
    if (!run) return c.json({ resolved: false });
    const pending = options.approvals.listForRun(run.id).find((approval) => approval.status === "requested");
    if (!pending) return c.json({ resolved: false });
    const body = await readJson(c);
    const approve = body?.approve === true;
    const record = approve ? options.approvals.grant(pending.id, "channel") : options.approvals.revoke(pending.id, "channel");
    if (!record || (approve ? record.status !== "granted" : record.status !== "revoked")) return c.json({ resolved: false });
    if (approve) {
      options.workItems.requeueRun(run.id);
      if (options.executor) void options.executor.execute(run.id).catch(() => {});
    } else {
      if (options.executor) options.executor.cancelRun(run.id);
      else {
        options.workItems.updateRunStatus(run.id, "cancelled");
        options.workItems.appendEvent({
          workItemId: run.workItemId,
          runId: run.id,
          type: "RUN_CANCELLED",
          actor: "channel",
          target: run.id,
          payload: { approval_id: record.id, reason: "approval_rejected" },
        });
      }
    }
    return c.json({ resolved: true, approval_id: record.id });
  });

  app.post("/v1/sessions/:session_id/directories", async (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    if (!options.runner) return c.json({ error: "runner_unavailable" }, 503);
    const body = await readJson(c);
    if (!body || typeof body.path !== "string" || !body.path.trim()) {
      return c.json({ error: "path is required" }, 400);
    }
    const authorization = await options.runner.authorizeDirectory(body.path);
    if (!authorization.ok) {
      return c.json({ error: "workspace_not_authorized", detail: authorization.error ?? "目录无法访问" }, 403);
    }
    const directory = authorization.path ?? body.path;
    const additionalDirectories = session.additionalDirectories.includes(directory)
      ? session.additionalDirectories
      : [...session.additionalDirectories, directory];
    return c.json(toApiSession(options.catalog.updateSession(session.id, { additionalDirectories })!));
  });

  app.post("/v1/sessions/:session_id/directories/pick", async (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    if (!options.runner) return c.json({ error: "runner_unavailable" }, 503);
    const selected = await options.runner.pickDirectory();
    if (!selected.ok) {
      return c.json({ error: "directory_picker_failed", detail: selected.error }, 503);
    }
    if (selected.cancelled || !selected.path) return c.json({ cancelled: true });
    const additionalDirectories = session.additionalDirectories.includes(selected.path)
      ? session.additionalDirectories
      : [...session.additionalDirectories, selected.path];
    return c.json(toApiSession(options.catalog.updateSession(session.id, { additionalDirectories })!));
  });

  app.get("/v1/sessions/:session_id/files", async (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    if (!options.runner) return c.json({ error: "runner_unavailable" }, 503);
    const roots = [session.cwd, ...session.additionalDirectories]
      .filter((value): value is string => Boolean(value));
    const root = c.req.query("root") ?? roots[0];
    if (!root) return c.json({ ok: true, entries: [], error: "workspace_required" });
    if (!roots.includes(root)) return c.json({ error: "workspace_not_authorized" }, 403);
    const result = await options.runner.listDirectory(root, c.req.query("path") ?? "");
    return c.json(result, result.ok ? 200 : 400);
  });

  app.delete("/v1/sessions/:session_id/directories", async (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const body = await readJson(c);
    if (!body || typeof body.path !== "string" || !body.path.trim()) {
      return c.json({ error: "path is required" }, 400);
    }
    const additionalDirectories = session.additionalDirectories.filter((directory) => directory !== body.path);
    return c.json(toApiSession(options.catalog.updateSession(session.id, { additionalDirectories })!));
  });

  app.get("/v1/sessions/:session_id", async (c) => {
    let session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    session = await hydrateProviderHistory(session);
    return c.json(toApiSession(session));
  });

  app.get("/v1/sessions/:session_id/config-options", async (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    if (!options.runner) return c.json({ error: "runner_unavailable" }, 503);
    const cwd = session.cwd ?? options.defaultCwd;
    if (!cwd) return c.json({ options: [], error: "workspace_required" });
    const cacheKey = `${session.agentId}\0${cwd}`;
    let request = configOptionRequests.get(cacheKey);
    if (!request) {
      request = options.runner.listConfigOptions(session.agentId, cwd);
      configOptionRequests.set(cacheKey, request);
      request.catch(() => {
        if (configOptionRequests.get(cacheKey) === request) configOptionRequests.delete(cacheKey);
      });
    }
    return c.json(await request);
  });

  app.get("/v1/sessions/:session_id/commands", async (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const cwd = session.cwd ?? options.defaultCwd;
    let native: Awaited<ReturnType<RunnerClient["listCommands"]>> = { commands: [] };
    if (options.runner && cwd) {
      try {
        native = await options.runner.listCommands(session.agentId, cwd);
      } catch (error) {
        native = { commands: [], error: error instanceof Error ? error.message : String(error) };
      }
    }
    const commands = new Map(native.commands.map((command) => [command.name, command]));
    if (session.taskRecordId) {
      const events = options.workItems.listEvents(session.taskRecordId).reverse();
      const update = events.find((event) => {
        const agentEvent = event.payload.event as Record<string, unknown> | undefined;
        return event.type === "AGENT_EVENT" && agentEvent?.type === "available_commands_update";
      });
      const available = (update?.payload.event as { availableCommands?: unknown } | undefined)?.availableCommands;
      if (Array.isArray(available)) {
        for (const value of available) {
          if (!value || typeof value !== "object") continue;
          const command = value as { name?: unknown; description?: unknown; input?: unknown };
          if (typeof command.name !== "string" || typeof command.description !== "string") continue;
          commands.set(command.name, {
            name: command.name,
            description: command.description,
            ...(command.input && typeof command.input === "object" ? { input: command.input as { hint: string } } : {}),
          });
        }
      }
    }
    return c.json({ commands: [...commands.values()], ...(native.error ? { error: native.error } : {}) });
  });

  app.patch("/v1/sessions/:session_id", async (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const body = await readJson(c);
    if (!body) return c.json({ error: "invalid_session_update" }, 400);
    const update: UpdateSessionInput = {};
    if (Object.hasOwn(body, "title")) {
      if (typeof body.title !== "string" || !body.title.trim()) {
        return c.json({ error: "title must be a non-empty string" }, 400);
      }
      update.title = body.title.trim();
    }
    if (Object.hasOwn(body, "model")) {
      if (body.model !== null && (typeof body.model !== "string" || !body.model.trim())) {
        return c.json({ error: "model must be a non-empty string or null" }, 400);
      }
      update.model = body.model === null ? null : (body.model as string).trim();
    }
    if (Object.hasOwn(body, "permission_mode")) {
      if (body.permission_mode !== null && (typeof body.permission_mode !== "string" || !body.permission_mode.trim())) {
        return c.json({ error: "permission_mode must be a non-empty string or null" }, 400);
      }
      update.permissionMode = body.permission_mode === null ? null : (body.permission_mode as string).trim();
    }
    if (Object.hasOwn(body, "effort")) {
      if (body.effort !== null && (typeof body.effort !== "string" || !body.effort.trim())) {
        return c.json({ error: "effort must be a non-empty string or null" }, 400);
      }
      update.effort = body.effort === null ? null : (body.effort as string).trim();
    }
    if (Object.hasOwn(body, "config_overrides")) {
      const configOverrides = parseConfigOverrides(body.config_overrides);
      if (!configOverrides) {
        return c.json({ error: "config_overrides must contain only string or boolean values" }, 400);
      }
      update.configOverrides = configOverrides;
    }
    for (const field of ["pinned", "archived"] as const) {
      if (!Object.hasOwn(body, field)) continue;
      if (typeof body[field] !== "boolean") {
        return c.json({ error: `${field} must be a boolean` }, 400);
      }
      update[field] = body[field];
    }
    if (!Object.keys(update).length) return c.json({ error: "invalid_session_update" }, 400);
    return c.json(toApiSession(options.catalog.updateSession(session.id, update)!));
  });

  app.post("/v1/sessions/:session_id/messages", async (c) => {
    let session = options.catalog.getSession(c.req.param("session_id"));
    const body = await readJson(c);
    if (!session) return c.json({ error: "session_not_found" }, 404);
    if (!body || typeof body.message !== "string" || !body.message.trim()) {
      return c.json({ error: "message is required" }, 400);
    }
    if (!session.cwd && options.defaultCwd) {
      session = options.catalog.updateSession(session.id, { cwd: options.defaultCwd })!;
    }
    const attachmentInput = parseMessageAttachments(body.attachments);
    if (!attachmentInput) return c.json({ error: "invalid_attachments" }, 400);
    const idempotencyKey = c.req.header("idempotency-key");
    if (idempotencyKey) {
      const cached = options.workItems.getIdempotencyResponse(`session:message:${session.id}`, idempotencyKey);
      if (cached !== undefined) return c.json(cached, 202);
    }

    const task = session.taskRecordId
      ? options.workItems.getWorkItem(session.taskRecordId)
      : undefined;
    const flowId = Object.hasOwn(body, "flow_id")
      ? asNullableString(body.flow_id)
      : session.flowId;
    const model = Object.hasOwn(body, "model") ? asNullableString(body.model) : session.model;
    const effort = Object.hasOwn(body, "effort") ? asNullableString(body.effort) : session.effort;
    const permissionMode = Object.hasOwn(body, "permission_mode")
      ? asNullableString(body.permission_mode)
      : session.permissionMode;
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
    let attachments;
    try {
      attachments = attachmentInput.map((attachment) => options.workItems.createMessageAttachment({
        workItemId: workItem.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        dataBase64: attachment.dataBase64,
      }));
    } catch (error) {
      return c.json({ error: "invalid_attachments", detail: error instanceof Error ? error.message : String(error) }, 400);
    }
    if (task && task.workflowId !== flowId) {
      options.workItems.updateWorkflowBinding(task.id, flowId);
    }
    const event = options.workItems.appendEvent({
      workItemId: workItem.id,
      type: "MESSAGE_RECEIVED",
      actor: "user",
      payload: { message: body.message, attachment_ids: attachments.map((attachment) => attachment.id) },
    });
    options.catalog.updateSession(session.id, {
      taskRecordId: workItem.id,
      flowId,
      model,
      effort,
      permissionMode,
      title: session.title ?? deriveTitle(body.message),
      status: "active",
    });
    if (!task && options.discovery && session.cwd) {
      void options.discovery.observe(session.cwd, workItem.id).catch((error) => {
        options.workItems.appendEvent({
          workItemId: workItem.id,
          type: "AGENT_EVENT",
          actor: "system",
          payload: {
            kind: "discovery_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    }
    const response = {
        request_id: `req_${randomUUID().replaceAll("-", "")}`,
        accepted: true,
        session_id: session.id,
        task_record_id: workItem.id,
        event_id: event.eventId,
        sequence: event.sequence,
        attachment_ids: attachments.map((attachment) => attachment.id),
      };
    if (idempotencyKey) options.workItems.putIdempotencyResponse(`session:message:${session.id}`, idempotencyKey, response);
    return c.json(response, 202);
  });

  app.get("/v1/sessions/:session_id/runs", (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    if (!session.taskRecordId) return c.json({ runs: [] });
    return c.json({ runs: options.workItems.listRuns(session.taskRecordId).map((run) => toApiRun(run, session.id)) });
  });

  app.post("/v1/sessions/:session_id/runs", async (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const body = await readJson(c);
    const task = session.taskRecordId ? options.workItems.getWorkItem(session.taskRecordId) : undefined;
    if (!task) return c.json({ error: "message_required", message: "先向 Session 发送消息" }, 409);
    const idempotencyKey = c.req.header("idempotency-key");
    if (idempotencyKey) {
      const cached = options.workItems.getIdempotencyResponse(`session:run:${session.id}`, idempotencyKey);
      if (cached !== undefined) return c.json(cached, 202);
    }
    const flowId = body && Object.hasOwn(body, "flow_id")
      ? asNullableString(body.flow_id)
      : session.flowId;
    const model = body && Object.hasOwn(body, "model") ? asNullableString(body.model) : session.model;
    const effort = body && Object.hasOwn(body, "effort") ? asNullableString(body.effort) : session.effort;
    const permissionMode = body && Object.hasOwn(body, "permission_mode")
      ? asNullableString(body.permission_mode)
      : session.permissionMode;
    const flow = flowId ? options.flows?.get(flowId) : undefined;
    if (flowId && !flow) {
      return c.json({ error: "flow_not_found", flow_id: flowId }, 404);
    }
    if (flow?.status === "deprecated") {
      return c.json({ error: "flow_deprecated", flow_id: flowId }, 409);
    }
    let plan;
    if (flow) {
      try {
        plan = compileWorkflow(toWorkflowDefinition(flow), {
          source: flow.source === "agent_generated" ? "agent_generated" : "workflow",
          definitionRevision: flow.definitionRevision,
        });
      } catch (error) {
        if (error instanceof WorkflowValidationError) {
          return c.json({ error: "invalid_flow", issues: error.issues }, 409);
        }
        throw error;
      }
      if (options.capabilities) {
        for (const step of plan.steps) {
          if (!step.capabilityId || options.capabilities.get(step.capabilityId)) continue;
          options.capabilities.register({
            id: step.capabilityId,
            risk: step.risk === "manual" ? "read_only" : step.risk,
            adapter: "agent",
            description: step.purpose ?? undefined,
          });
        }
      }
    }
    if (task.workflowId !== flowId || task.workflowRevision !== (flow?.definitionRevision ?? null)) {
      options.workItems.updateWorkflowBinding(task.id, flowId, flow?.definitionRevision ?? null);
    }
    options.catalog.updateSession(session.id, { flowId, model, effort, permissionMode });
    const runId = `run_${randomUUID().replaceAll("-", "")}`;
    if (plan) {
      options.workItems.savePlan({
        ...plan,
        sessionId: session.id,
        runId,
      });
    }
    const run = options.workItems.createRun({
      id: runId,
      workItemId: task.id,
      mode: "auto",
      agentId: session.agentId,
      planId: plan?.planId ?? null,
      workflowRevision: flow?.definitionRevision ?? null,
    });
    if (options.executor) void options.executor.execute(run.id).catch(() => {});
    const response = {
      run_id: run.id,
      status: run.status,
      plan_id: run.planId,
      workflow_revision: run.workflowRevision,
    };
    if (idempotencyKey) options.workItems.putIdempotencyResponse(`session:run:${session.id}`, idempotencyKey, response);
    return c.json(response, 202);
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
      model: asNullableString(body?.model) ?? session.model,
      effort: asNullableString(body?.effort) ?? session.effort,
      configOverrides: session.configOverrides,
      permissionMode: asNullableString(body?.permission_mode) ?? session.permissionMode,
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
    const after = Number(c.req.query("after_sequence") ?? c.req.header("last-event-id") ?? "0");
    if (!Number.isInteger(after) || after < 0) return c.json({ error: "invalid_after_sequence" }, 400);
    if (c.req.query("live") === "true") {
      return streamSSE(c, async (stream) => {
        let cursor = after;
        let open = true;
        stream.onAbort(() => { open = false; });
        while (open) {
          const current = options.catalog.getSession(session.id);
          const taskRecordId = current?.taskRecordId;
          if (!taskRecordId || !options.workItems.getWorkItem(taskRecordId)) {
            await stream.sleep(250);
            continue;
          }
          const events = options.workItems.listEvents(taskRecordId, cursor);
          for (const event of events) {
            await stream.writeSSE({
              id: event.eventId,
              event: event.type,
              data: JSON.stringify(toApiEvent(event)),
            });
            cursor = event.sequence;
          }
          if (!events.length) await stream.sleep(250);
        }
      });
    }
    if (!session.taskRecordId || !options.workItems.getWorkItem(session.taskRecordId)) {
      return new Response("", {
        headers: { "cache-control": "no-cache", "content-type": "text/event-stream; charset=utf-8" },
      });
    }
    const tail = Number(c.req.query("tail") ?? "0");
    const history = after > 0
      ? options.workItems.listEvents(session.taskRecordId, after)
      : Number.isInteger(tail) && tail > 0
        ? options.workItems.listRecentEvents(session.taskRecordId, tail)
        : options.workItems.listEvents(session.taskRecordId);
    const stream = history
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

  app.delete("/v1/sessions/:session_id", async (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    if (options.runner && session.providerSessionId && session.cwd) {
      const result = await options.runner.deleteSession(session.agentId, session.cwd, session.providerSessionId);
      if (!result.ok) return c.json(result, 409);
    }
    if (!options.catalog.deleteSession(session.id)) return c.json({ error: "session_not_found" }, 404);
    return c.body(null, 204);
  });

  return app;
}

function isAgentResponse(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const type = (event as { type?: unknown }).type;
  return typeof type === "string" && ![
    "available_commands_update",
    "current_mode_update",
    "config_option_update",
    "session_info_update",
    "usage_update",
  ].includes(type);
}

function isProviderSnapshotCovered(existingEvents: Array<{ payload?: Record<string, unknown> }>, candidate: Record<string, unknown>): boolean {
  const type = candidate.type;
  const text = candidate.text;
  if ((type !== "thought_delta" && type !== "text_delta") || typeof text !== "string") return false;
  for (let start = 0; start < existingEvents.length; start += 1) {
    let combined = "";
    let count = 0;
    for (let index = start; index < existingEvents.length; index += 1) {
      const value = existingEvents[index].payload?.event;
      if (!value || typeof value !== "object" || (value as Record<string, unknown>).type !== type || typeof (value as Record<string, unknown>).text !== "string") break;
      combined += String((value as Record<string, unknown>).text);
      count += 1;
      if (combined.length >= text.length) {
        if (count > 1 && combined === text) return true;
        break;
      }
    }
  }
  return false;
}

function toWorkflowDefinition(flow: FlowRecord): Record<string, unknown> {
  return {
    schema_version: 1,
    workflow_id: flow.flowId,
    name: flow.name ?? flow.flowId,
    kind: flow.kind === "runbook" ? "runbook" : "guide",
    status: flow.status === "published" ? "published" : "draft",
    inputs: [],
    steps: flow.steps.map((step) => ({
      id: step.id,
      capability: step.capability,
      purpose: step.purpose,
      depends_on: step.dependsOn ?? [],
      mode: step.mode,
      approval: step.approval ?? "none",
      branches: step.branches ?? [],
      retry: step.retry
        ? { max_attempts: step.retry.maxAttempts, delay_ms: step.retry.delayMs }
        : undefined,
    })),
  };
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
          updatedAt: provider.updatedAt,
        });
        options.catalog.updateSession(session.id, {
          providerSessionId: provider.id,
          cwd: provider.cwd,
          additionalDirectories: provider.additionalDirectories,
          title: provider.preview || session.title,
          status: "idle",
          updatedAt: provider.updatedAt,
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
    model: session.model,
    effort: session.effort,
    config_overrides: session.configOverrides,
    permission_mode: session.permissionMode,
    folder_id: session.folderId,
    cwd: session.cwd,
    additional_directories: session.additionalDirectories,
    title: session.title,
    status: session.status,
    pinned_at: session.pinnedAt,
    archived_at: session.archivedAt,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

function toApiRun(run: ReturnType<SqliteEventStore["getRun"]>, sessionId: string): Record<string, unknown> {
  if (!run) throw new Error("run is required");
  return {
    schema_version: run.schemaVersion,
    run_id: run.id,
    session_id: sessionId,
    work_item_id: run.workItemId,
    agent_id: run.agentId,
    plan_id: run.planId,
    workflow_revision: run.workflowRevision,
    mode: run.mode,
    status: run.status,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
}

function toApiAttachment(attachment: ReturnType<SqliteEventStore["getMessageAttachment"]>): Record<string, unknown> {
  if (!attachment) throw new Error("attachment is required");
  return {
    schema_version: attachment.schemaVersion,
    id: attachment.id,
    work_item_id: attachment.workItemId,
    name: attachment.name,
    mime_type: attachment.mimeType,
    byte_size: attachment.byteSize,
    content_hash: attachment.contentHash,
    created_at: attachment.createdAt,
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

function toApiEvent(event: {
  schemaVersion: number;
  eventId: string;
  sequence: number;
  workItemId: string;
  runId: string | null;
  type: string;
  occurredAt: string;
  actor: string;
  target: string | null;
  inputHash: string | null;
  resultRef: string | null;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  return {
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
  };
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

function parseConfigOverrides(value: unknown): Record<string, string | boolean> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const overrides: Record<string, string | boolean> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!key.trim()) return null;
    if (typeof candidate === "boolean") overrides[key] = candidate;
    else if (typeof candidate === "string" && candidate.trim()) overrides[key] = candidate;
    else return null;
  }
  return overrides;
}

function parseMessageAttachments(value: unknown): Array<{ name: string; mimeType: string; dataBase64: string }> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) return null;
  let totalBytes = 0;
  const attachments = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name.trim() || typeof record.data_base64 !== "string") return null;
    if (record.mime_type !== undefined && typeof record.mime_type !== "string") return null;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(record.data_base64) || record.data_base64.length % 4 === 1) return null;
    const byteSize = Buffer.byteLength(record.data_base64, "base64");
    if (byteSize === 0 || byteSize > 10_000_000) return null;
    totalBytes += byteSize;
    if (totalBytes > 25_000_000) return null;
    attachments.push({
      name: record.name,
      mimeType: typeof record.mime_type === "string" && record.mime_type ? record.mime_type : "application/octet-stream",
      dataBase64: record.data_base64,
    });
  }
  return attachments;
}

function deriveTitle(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 48 ? `${compact.slice(0, 47)}…` : compact;
}
