import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type {
  AgentProfile,
  SessionCatalogStore,
  UpdateSessionInput,
} from "@codebridge/session-catalog";
import { AgentRegistry, cloneSetupManifest, projectAgentStatus, projectSetupState } from "@codebridge/agent-registry";
import type { ConfigStore, ChannelSlot } from "@codebridge/core";
import { canonicalWorkspaceKey, isSupportedAgentId } from "@codebridge/core";
import type { SqliteEventStore } from "@codebridge/work-items";
import type { RunExecutor } from "@codebridge/run-executor";
import type { RunnerClient } from "@codebridge/runner-client";
import type { ProjectDiscovery } from "@codebridge/project-catalog";
import type { FlowCatalogStore } from "@codebridge/flow-catalog";
import { WorkflowValidationError } from "@codebridge/workflow-engine";
import type { ApprovalService, CapabilityRegistry } from "@codebridge/policy";
import type { SessionCoordinator } from "@codebridge/session-coordinator";
import { ProviderHistoryImporter } from "./session-history-import.js";
import {
  registerSessionRuntimeCommandRoutes,
  registerSessionRuntimeReadRoutes,
} from "./session-runtime-api.js";
import { compileCatalogFlow, instantiateCatalogPlan } from "./flow-compile.js";
import { resolveFlowInvocation } from "./flow-invocation.js";

export interface SessionApiOptions {
  catalog: SessionCatalogStore;
  agents: AgentProfile[] | (() => AgentProfile[]);
  agentRegistry?: AgentRegistry;
  configStore?: ConfigStore;
  workItems: SqliteEventStore;
  executor?: RunExecutor;
  runner?: RunnerClient;
  discovery?: ProjectDiscovery;
  flows?: FlowCatalogStore;
  capabilities?: CapabilityRegistry;
  approvals?: ApprovalService;
  coordinator?: SessionCoordinator;
  defaultCwd?: string;
}

export function createSessionApp(options: SessionApiOptions, token: string) {
  const app = new Hono();
  const channelOriginToken = randomUUID();
  const currentAgents = () => options.agentRegistry?.list()
    ?? (typeof options.agents === "function" ? options.agents() : options.agents);
  const currentProfiles = () => new Map(currentAgents().map((agent) => [agent.agentId, agent]));
  const configOptionRequests = new Map<string, Promise<Awaited<ReturnType<RunnerClient["listConfigOptions"]>>>>();
  const historyImporter = options.runner
    ? new ProviderHistoryImporter({
        store: options.workItems,
        catalog: options.catalog,
        runner: options.runner,
        defaultCwd: options.defaultCwd,
      })
    : undefined;

  function agentListPayload() {
    const agents = currentAgents();
    const defaultAgentId = options.configStore?.get().defaultAgent ?? null;
    return {
      agents: agents.map(toApiAgent),
      default_agent_id: defaultAgentId,
      effective_default_agent_id: resolveEffectiveDefaultAgentId(agents, defaultAgentId),
    };
  }

  function applySetupToAgent(
    agent: AgentProfile,
    setup: Parameters<typeof projectSetupState>[0],
  ): AgentProfile {
    return options.agentRegistry?.updateSetup(agent.agentId, setup) ?? mergeAgentSetup(agent, setup);
  }

  app.use("/v1/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  registerSessionRuntimeReadRoutes(app, {
    catalog: options.catalog,
    workItems: options.workItems,
  });
  if (options.coordinator) {
    registerSessionRuntimeCommandRoutes(app, {
      catalog: options.catalog,
      workItems: options.workItems,
      coordinator: options.coordinator,
      executor: options.executor,
      flows: options.flows,
      capabilities: options.capabilities,
      channelOriginToken,
    });
  }

  app.get("/v1/agents", (c) => c.json(agentListPayload()));

  app.get("/v1/agents/:agent_id", (c) => {
    const agent = currentProfiles().get(c.req.param("agent_id"));
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    return c.json(toApiAgent(agent));
  });

  app.post("/v1/agents/detect", async (c) => {
    if (!options.runner) return c.json({ error: "runner_unavailable" }, 503);
    try {
      const setup = await options.runner.detectAllAgents();
      for (const agent of setup.agents) {
        const profile = currentProfiles().get(agent.agentId);
        if (profile) applySetupToAgent(profile, agent);
      }
      return c.json(agentListPayload());
    } catch (error) {
      return c.json({ error: "agent_setup_failed", message: error instanceof Error ? error.message : String(error) }, 503);
    }
  });

  app.post("/v1/agents/:agent_id/detect", async (c) => {
    const agentId = c.req.param("agent_id");
    const agent = currentProfiles().get(agentId);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    if (!options.runner) return c.json({ error: "runner_unavailable" }, 503);
    try {
      const setup = await options.runner.detectAgent(agentId);
      const nextAgent = applySetupToAgent(agent, setup);
      return c.json(toApiAgent(nextAgent));
    } catch (error) {
      const status = errorStatus(error, 500) as 400 | 401 | 403 | 404 | 409 | 500 | 503;
      return c.json(formatAgentSetupError(error, agent), status);
    }
  });

  app.post("/v1/agents/:agent_id/install", async (c) => {
    const agentId = c.req.param("agent_id");
    const agent = currentProfiles().get(agentId);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    if (!options.runner) return c.json({ error: "runner_unavailable" }, 503);
    const body = await c.req.json().catch(() => null) as { strategy_id?: unknown } | null;
    if (!body || typeof body.strategy_id !== "string" || !body.strategy_id.trim()) {
      return c.json({ error: "install_strategy_not_found" }, 400);
    }
    try {
      const result = await options.runner.installAgent(agentId, body.strategy_id.trim());
      const nextAgent = applySetupToAgent(agent, result);
      if (!result.ok) {
        return c.json({
          error: result.diagnostic?.code ?? "install_failed",
          message: result.diagnostic?.message ?? "Agent installation failed.",
          details: result.diagnostic?.details,
          agent: toApiAgent(nextAgent),
        }, result.diagnostic?.code === "install_not_supported" ? 400 : 409);
      }
      return c.json(toApiAgent(nextAgent));
    } catch (error) {
      const status = errorStatus(error, 500) as 400 | 401 | 403 | 404 | 409 | 500 | 503;
      return c.json(formatAgentSetupError(error, agent), status);
    }
  });

  app.patch("/v1/settings/default-agent", async (c) => {
    const body = await c.req.json().catch(() => null) as { agent_id?: unknown } | null;
    const agentId = typeof body?.agent_id === "string" ? body.agent_id.trim() : "";
    if (!agentId) return c.json({ error: "agent_not_found" }, 404);
    const agent = currentProfiles().get(agentId);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    const setup = agent.setup;
    if (!setup || setup.installation !== "installed") {
      return c.json({ error: "agent_not_installed", message: `${agent.displayName ?? agent.agentId} is not installed.` }, 409);
    }
    if (setup.configuration !== "configured") {
      return c.json({ error: "agent_not_configured", message: `${agent.displayName ?? agent.agentId} is not configured.` }, 409);
    }
    if (!options.configStore) {
      return c.json({ error: "config_store_unavailable" }, 503);
    }
    try {
      options.configStore.update((current) => ({
        ...current,
        defaultAgent: agentId,
        ...(isSupportedAgentId(agentId) ? { defaultBackend: agentId } : {}),
      }));
      return c.json(agentListPayload());
    } catch (error) {
      return c.json({
        error: "default_agent_persist_failed",
        message: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  });

  app.get("/v1/attachments/:attachment_id", (c) => {
    const attachment = options.workItems.getMessageAttachment(c.req.param("attachment_id"));
    if (!attachment) return c.json({ error: "attachment_not_found" }, 404);
    return c.json(toApiAttachment(attachment));
  });

  // Pi provider management, proxied to the runner (docs/orchestration/agent-providers.md).
  app.get("/v1/providers", async (c) => {
    if (!options.runner) return c.json({ error: "runner_unavailable" }, 503);
    return c.json(await options.runner.listPiProviders());
  });

  app.put("/v1/providers", async (c) => {
    if (!options.runner) return c.json({ error: "runner_unavailable" }, 503);
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "invalid_json" }, 400);
    try {
      const result = await options.runner.savePiProviders(body);
      configOptionRequests.clear();
      return c.json(result);
    } catch (error) {
      return c.json({ error: "invalid_providers", message: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.get("/v1/providers/presets", async (c) => {
    if (!options.runner) return c.json({ error: "runner_unavailable" }, 503);
    return c.json(await options.runner.listPiProviderPresets());
  });

  app.post("/v1/providers/test", async (c) => {
    if (!options.runner) return c.json({ error: "runner_unavailable" }, 503);
    const body = (await c.req.json().catch(() => null)) as { baseUrl?: string; apiKey?: string; authHeader?: boolean; api?: string; model?: string } | null;
    if (!body || typeof body.baseUrl !== "string") return c.json({ error: "baseUrl is required" }, 400);
    return c.json(await options.runner.testPiProvider({
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      authHeader: body.authHeader,
      api: typeof body.api === "string" ? body.api : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
    }));
  });

  app.get("/v1/sessions", (c) => {
    if (c.req.query("import") === "true") {
      return c.json({ error: "provider_import_moved" }, 410);
    }
    const agentId = c.req.query("agent_id");
    const profiles = currentProfiles();
    return c.json({
      sessions: options.catalog.listSessions(agentId, {
        includeArchived: c.req.query("include_archived") === "true",
      }).map((session) => ({
        ...toApiSession(session),
        agent: profiles.get(session.agentId)?.displayName ?? session.agentId,
      })),
      provider_errors: [],
    });
  });

  app.post("/v1/sessions/import", async (c) => {
    const body = await readJson(c);
    const cwd = typeof body?.cwd === "string"
      ? body.cwd
      : options.defaultCwd;
    if (!cwd) return c.json({ error: "workspace_required" }, 400);
    const agentId = typeof body?.agent_id === "string"
      ? body.agent_id
      : undefined;
    const sync = await syncProviderSessions(
      options,
      currentProfiles(),
      agentId,
      cwd,
    );
    return c.json({
      sessions: options.catalog
        .listSessions(agentId)
        .map(toApiSession),
      provider_errors: sync.errors,
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

  app.delete("/v1/sessions/:session_id/flow", (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    return c.json(toApiSession(options.catalog.unbindFlow(session.id)));
  });

  app.post("/v1/channels/:channel/conversations/:conversation_id/messages", async (c) => {
    const body = await readJson(c);
    if (!body || typeof body.message !== "string" || !body.message.trim()) {
      return c.json({ error: "message is required" }, 400);
    }
    const channel = c.req.param("channel");
    const conversationId = c.req.param("conversation_id");
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
    const generation = Number.isSafeInteger(body.generation)
      ? Number(body.generation)
      : 0;
    const hasFlowId = Object.hasOwn(body, "flow_id");
    const hasFlowRevision = Object.hasOwn(body, "definition_revision");
    if (hasFlowId !== hasFlowRevision) {
      return c.json({ error: "flow_invocation_incomplete" }, 400);
    }
    if (
      hasFlowId
      && (
        typeof body.flow_id !== "string"
        || !body.flow_id.trim()
        || typeof body.definition_revision !== "string"
        || !body.definition_revision.trim()
      )
    ) {
      return c.json({ error: "invalid_flow_invocation" }, 400);
    }
    const hasReplyToMessageId = Object.hasOwn(body, "reply_to_message_id");
    const hasShowThinking = Object.hasOwn(body, "show_thinking");
    if (hasReplyToMessageId !== hasShowThinking) {
      return c.json({ error: "channel_delivery_incomplete" }, 400);
    }
    if (
      hasReplyToMessageId
      && (
        typeof body.reply_to_message_id !== "string"
        || !body.reply_to_message_id.trim()
        || typeof body.show_thinking !== "boolean"
      )
    ) {
      return c.json({ error: "invalid_delivery" }, 400);
    }
    const rawActorRef = body.actor_ref && typeof body.actor_ref === "object"
      ? body.actor_ref as Record<string, unknown>
      : null;
    const actorRef = (channel === "feishu" || channel === "telegram")
      ? {
          channel,
          id: rawActorRef?.channel === channel && typeof rawActorRef.id === "string" && rawActorRef.id.trim()
            ? rawActorRef.id.trim()
            : "unknown",
        }
      : undefined;
    const slot: ChannelSlot = {
      channel,
      conversationId,
      agentId: agent.agentId,
      workspaceKey: canonicalWorkspaceKey(cwd ?? options.defaultCwd ?? "").key,
      generation,
    };
    const session = options.catalog.getOrCreateBoundSession(slot, {
      agentId: agent.agentId,
      model: asNullableString(body.model),
      effort: asNullableString(body.effort),
      permissionMode: asNullableString(body.permission_mode),
      cwd: slot.workspaceKey || null,
      title: asNullableString(body.title),
    });
    if (options.coordinator && typeof options.catalog.listChannelBindings === "function") {
      for (const binding of options.catalog.listChannelBindings(channel, conversationId)) {
        if (binding.sessionId === session.id) continue;
        options.coordinator.pauseQueue({
          sessionId: binding.sessionId,
          reason: "stale",
        });
      }
    }
    if (session.providerSessionId) {
      options.workItems.setSessionProviderSessionId(
        session.id,
        session.providerSessionId,
      );
    }
    const idempotencyKey = c.req.header("idempotency-key");
    const childHeaders = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-codebridge-channel-origin": channelOriginToken,
      ...(idempotencyKey ? { "idempotency-key": `${idempotencyKey}:message` } : {}),
    };
    const messageResponse = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: childHeaders,
      body: JSON.stringify({
        message: body.message,
        ...(hasFlowId ? { flow_id: String(body.flow_id).trim() } : {}),
        ...(hasFlowRevision
          ? { definition_revision: String(body.definition_revision).trim() }
          : {}),
        inputs: channelInputRecord(body.inputs),
        ...(actorRef ? { actor_ref: actorRef } : {}),
        model: asNullableString(body.model),
        attachments: body.attachments,
        delivery: hasReplyToMessageId
          ? {
              channel,
              conversation_id: conversationId,
              reply_to_message_id: String(body.reply_to_message_id).trim(),
              show_thinking: body.show_thinking,
            }
          : undefined,
      }),
    });
    if (!messageResponse.ok) return c.json(await messageResponse.json(), messageResponse.status as 400 | 404 | 409 | 503);
    if (options.coordinator) {
      const result = await messageResponse.json() as {
        acceptance: "queued" | "dispatched";
        run_id: string | null;
        turn: { turn_id: string };
        runtime: {
          active_run: { run_id: string } | null;
          queue_state: "ready" | "paused";
          last_event_sequence: number;
        };
      };
      const updatedSession = options.catalog.getSession(session.id);
      return c.json({
        channel,
        conversation_id: conversationId,
        session_id: session.id,
        task_record_id: updatedSession?.taskRecordId ?? null,
        event_sequence: result.runtime.last_event_sequence,
        acceptance: result.acceptance,
        queue_state: result.runtime.queue_state,
        turn_id: result.turn.turn_id,
        run_id: result.acceptance === "dispatched"
          ? result.run_id
          : null,
      }, 202);
    }
    const messageResult = await messageResponse.json() as { task_record_id: string; sequence: number };
    const runResponse = await app.request(`/v1/sessions/${session.id}/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-codebridge-channel-origin": channelOriginToken,
        ...(idempotencyKey ? { "idempotency-key": `${idempotencyKey}:run` } : {}),
      },
      body: JSON.stringify({
        ...(hasFlowId ? { flow_id: String(body.flow_id).trim() } : {}),
        ...(hasFlowRevision
          ? { definition_revision: String(body.definition_revision).trim() }
          : {}),
        inputs: channelInputRecord(body.inputs),
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

  app.post(
    "/v1/sessions/:session_id/provider-history/preview",
    async (c) => {
      if (!historyImporter) {
        return c.json({ error: "runner_unavailable" }, 503);
      }
      try {
        return c.json(
          await historyImporter.preview(c.req.param("session_id")),
        );
      } catch (error) {
        return providerHistoryError(c, error);
      }
    },
  );

  app.post(
    "/v1/sessions/:session_id/provider-history/import",
    async (c) => {
      if (!historyImporter) {
        return c.json({ error: "runner_unavailable" }, 503);
      }
      const idempotencyKey = c.req.header("idempotency-key");
      const body = await readJson(c);
      if (!idempotencyKey || body?.confirm !== true) {
        return c.json(
          { error: "confirmation_and_idempotency_key_required" },
          400,
        );
      }
      try {
        return c.json(
          await historyImporter.import(
            c.req.param("session_id"),
            idempotencyKey,
          ),
        );
      } catch (error) {
        return providerHistoryError(c, error);
      }
    },
  );

  app.get("/v1/sessions/:session_id", (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    return c.json(toApiSession(session));
  });

  app.get("/v1/sessions/:session_id/config-options", async (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    if (!options.runner) return c.json({ error: "runner_unavailable" }, 503);
    const cwd = session.cwd ?? options.defaultCwd;
    if (!cwd) return c.json({ options: [], error: "workspace_required" });
    const cacheKey = `${session.agentId}\0${cwd}\0${session.model ?? ""}`;
    let request = configOptionRequests.get(cacheKey);
    if (!request) {
      request = options.runner.listConfigOptions(session.agentId, cwd, session.model);
      configOptionRequests.set(cacheKey, request);
      void request.then(() => {
        if (configOptionRequests.get(cacheKey) === request) configOptionRequests.delete(cacheKey);
      }, () => {
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
    const hasFlowId = Object.hasOwn(body, "flow_id");
    if (
      hasFlowId
      && body.flow_id !== null
      && (typeof body.flow_id !== "string" || !body.flow_id.trim())
    ) {
      return c.json({ error: "invalid_flow_id" }, 400);
    }
    if (
      Object.hasOwn(body, "definition_revision")
      && (typeof body.definition_revision !== "string" || !body.definition_revision.trim())
    ) {
      return c.json({ error: "invalid_definition_revision" }, 400);
    }
    const flowResolution = resolveFlowInvocation({
      origin: c.req.header("x-codebridge-channel-origin") === channelOriginToken
        ? "channel"
        : "web",
      hasFlowId,
      requestedFlowId: hasFlowId
        ? body.flow_id === null ? null : String(body.flow_id).trim()
        : undefined,
      requestedDefinitionRevision: typeof body.definition_revision === "string"
        ? body.definition_revision.trim()
        : undefined,
      binding: session.flowId !== null || session.flowDefinitionRevision !== null
        ? {
            flowId: session.flowId,
            definitionRevision: session.flowDefinitionRevision,
          }
        : null,
      dryRun: false,
      getFlow: (flowId) => options.flows?.get(flowId),
    });
    if (flowResolution.kind === "error") {
      return c.json(flowResolution.body, flowResolution.status);
    }
    if (flowResolution.kind === "unbind") {
      options.catalog.unbindFlow(session.id);
    }
    const flow = flowResolution.kind === "flow" ? flowResolution.flow : undefined;
    const flowId = flow?.flowId ?? null;
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
        workflowRevision: flow?.definitionRevision ?? null,
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
    if (
      task
      && (task.workflowId !== flowId || task.workflowRevision !== (flow?.definitionRevision ?? null))
    ) {
      options.workItems.updateWorkflowBinding(task.id, flowId, flow?.definitionRevision ?? null);
    }
    const event = options.workItems.appendEvent({
      workItemId: workItem.id,
      type: "MESSAGE_RECEIVED",
      actor: "user",
      payload: { message: body.message, attachment_ids: attachments.map((attachment) => attachment.id) },
    });
    options.catalog.updateSession(session.id, {
      taskRecordId: workItem.id,
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

  app.post("/v1/sessions/:session_id/cancel", async (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    if (!session.taskRecordId) return c.json({ stopped: false });
    const run = options.workItems.listRuns(session.taskRecordId).reverse().find((candidate) => ["queued", "running", "waiting"].includes(candidate.status));
    if (!run) return c.json({ stopped: false });
    if (options.executor) await options.executor.cancelRunAndWait(run.id);
    else {
      options.workItems.updateRunStatus(run.id, "cancelled");
      options.workItems.appendEvent({
        workItemId: run.workItemId,
        runId: run.id,
        type: "RUN_CANCELLED",
        actor: "user",
        target: run.id,
      });
    }
    return c.json({ stopped: true, run_id: run.id });
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
    const runBody = body ?? {};
    const hasFlowId = Object.hasOwn(runBody, "flow_id");
    if (
      hasFlowId
      && runBody.flow_id !== null
      && (typeof runBody.flow_id !== "string" || !runBody.flow_id.trim())
    ) {
      return c.json({ error: "invalid_flow_id" }, 400);
    }
    if (
      Object.hasOwn(runBody, "definition_revision")
      && (typeof runBody.definition_revision !== "string" || !runBody.definition_revision.trim())
    ) {
      return c.json({ error: "invalid_definition_revision" }, 400);
    }
    const flowResolution = resolveFlowInvocation({
      origin: c.req.header("x-codebridge-channel-origin") === channelOriginToken
        ? "channel"
        : "web",
      hasFlowId,
      requestedFlowId: hasFlowId
        ? runBody.flow_id === null ? null : String(runBody.flow_id).trim()
        : undefined,
      requestedDefinitionRevision: typeof runBody.definition_revision === "string"
        ? runBody.definition_revision.trim()
        : undefined,
      binding: session.flowId !== null || session.flowDefinitionRevision !== null
        ? {
            flowId: session.flowId,
            definitionRevision: session.flowDefinitionRevision,
          }
        : null,
      dryRun: false,
      getFlow: (flowId) => options.flows?.get(flowId),
    });
    if (flowResolution.kind === "error") {
      return c.json(flowResolution.body, flowResolution.status);
    }
    if (flowResolution.kind === "unbind") {
      options.catalog.unbindFlow(session.id);
    }
    const flow = flowResolution.kind === "flow" ? flowResolution.flow : undefined;
    const flowId = flow?.flowId ?? null;
    const model = body && Object.hasOwn(body, "model") ? asNullableString(body.model) : session.model;
    const effort = body && Object.hasOwn(body, "effort") ? asNullableString(body.effort) : session.effort;
    const permissionMode = body && Object.hasOwn(body, "permission_mode")
      ? asNullableString(body.permission_mode)
      : session.permissionMode;
    let plan;
    if (flow) {
      try {
        plan = instantiateCatalogPlan(compileCatalogFlow(flow));
      } catch (error) {
        if (error instanceof WorkflowValidationError) {
          return c.json({ error: "invalid_flow", issues: error.issues }, 409);
        }
        throw error;
      }
    }
    if (task.workflowId !== flowId || task.workflowRevision !== (flow?.definitionRevision ?? null)) {
      options.workItems.updateWorkflowBinding(task.id, flowId, flow?.definitionRevision ?? null);
    }
    options.catalog.updateSession(session.id, { model, effort, permissionMode });
    const runId = `run_${randomUUID().replaceAll("-", "")}`;
    if (plan) {
      options.workItems.savePlan({
        ...plan,
        sessionId: session.id,
        runId,
        planIrHash: flow?.planIrHash ?? null,
      });
    }
    const run = options.workItems.createRun({
      id: runId,
      workItemId: task.id,
      mode: "auto",
      agentId: session.agentId,
      planId: plan?.planId ?? null,
      planIrHash: flow?.planIrHash ?? null,
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

  app.get("/v1/deliveries", (c) => {
    const channel = c.req.query("channel");
    if (!channel) return c.json({ error: "channel_required" }, 400);
    return c.json({
      deliveries: options.workItems.listDeliveries(channel),
    });
  });

  app.post("/v1/deliveries/:turn_id/claim", async (c) => {
    const body = await readJson(c);
    const owner = typeof body?.owner === "string" && body.owner
      ? body.owner
      : null;
    if (!owner) return c.json({ error: "owner_required" }, 400);
    const now = new Date();
    const claimed = options.workItems.withSessionTransaction((tx) =>
      tx.claimDelivery(
        c.req.param("turn_id"),
        owner,
        now.toISOString(),
        new Date(now.getTime() + 60_000).toISOString(),
      ),
    );
    return c.json({ claimed });
  });

  app.post("/v1/deliveries/:turn_id/ack", async (c) => {
    const body = await readJson(c);
    const owner = typeof body?.owner === "string" && body.owner
      ? body.owner
      : null;
    const surfaceMessageId = typeof body?.surface_message_id === "string"
      ? body.surface_message_id
      : null;
    const surfaceCardId = typeof body?.surface_card_id === "string"
      ? body.surface_card_id
      : undefined;
    if (!owner || !surfaceMessageId) {
      return c.json({ error: "owner_and_surface_message_id_required" }, 400);
    }
    const acked = options.workItems.withSessionTransaction((tx) =>
      tx.ackDelivery(
        c.req.param("turn_id"),
        owner,
        surfaceMessageId,
        surfaceCardId,
      ),
    );
    return c.json({ acked });
  });

  app.post("/v1/deliveries/:turn_id/complete", async (c) => {
    const body = await readJson(c);
    const owner = typeof body?.owner === "string" && body.owner
      ? body.owner
      : null;
    if (!owner) return c.json({ error: "owner_required" }, 400);
    const completed = options.workItems.withSessionTransaction((tx) =>
      tx.completeDelivery(c.req.param("turn_id"), owner),
    );
    return c.json({ completed });
  });

  app.post("/v1/sessions/:session_id/approval", async (c) => {
    if (!options.approvals) {
      return c.json({ resolved: false, error: "approval_unavailable" }, 503);
    }
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session?.taskRecordId) return c.json({ resolved: false });
    const body = await readJson(c);
    const runId = typeof body?.run_id === "string" ? body.run_id : undefined;
    const approvalId = typeof body?.approval_id === "string"
      ? body.approval_id
      : undefined;
    if (!runId || !approvalId) {
      return c.json({ error: "run_id_and_approval_id_required" }, 400);
    }
    const runs = options.workItems.listRuns(session.taskRecordId);
    const run = runs.find((candidate) => candidate.id === runId);
    if (!run) return c.json({ resolved: false });
    const pending = options.approvals
      .listForRun(run.id)
      .find((approval) =>
        approval.status === "requested"
        && approval.id === approvalId,
      );
    if (!pending) return c.json({ resolved: false });
    const approve = body?.approve === true;
    const record = approve
      ? options.approvals.grant(pending.id, "channel")
      : options.approvals.revoke(pending.id, "channel");
    if (
      !record
      || (approve ? record.status !== "granted" : record.status !== "revoked")
    ) {
      return c.json({ resolved: false });
    }
    if (approve) {
      options.workItems.requeueRun(run.id);
      if (options.executor) void options.executor.execute(run.id).catch(() => {});
    } else if (options.executor) {
      options.executor.cancelRun(run.id);
    } else {
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
    return c.json({ resolved: true, approval_id: record.id });
  });

  app.post("/v1/channels/:channel/conversations/:conversation_id/reset", async (c) => {
    const body = await readJson(c);
    const rawAgentId = body?.agent_id;
    const rawWorkspaceKey = body?.workspace_key;
    const rawGeneration = body?.generation;
    if (
      typeof rawAgentId !== "string"
      || typeof rawWorkspaceKey !== "string"
      || !Number.isSafeInteger(rawGeneration)
    ) {
      return c.json({ reset: false });
    }
    return c.json({
      reset: options.catalog.unbindChannelConversation({
        channel: c.req.param("channel"),
        conversationId: c.req.param("conversation_id"),
        agentId: rawAgentId,
        workspaceKey: rawWorkspaceKey,
        generation: Number(rawGeneration),
      }),
    });
  });

  // D6：/resume —— 幂等先于建 Session，Lease 预检（UX）后原子建+绑。
  // 真 Claim 由 executor 在 Run 前执行；此处 busy 只读预检，不影响旧 Run。
  app.post("/v1/channels/:channel/conversations/:conversation_id/resume", async (c) => {
    const body = await readJson(c);
    if (
      !body
      || typeof body.provider_session_id !== "string"
      || !body.provider_session_id.trim()
    ) {
      return c.json({ error: "provider_session_id is required" }, 400);
    }
    const channel = c.req.param("channel");
    const conversationId = c.req.param("conversation_id");
    // 禁止 fallback：agent 必须显式存在且健康，否则 lease 键 (agent_id, provider_session_id)
    // 会用错 agent，导致跨 agent 开同一 ACP session。
    const agent = typeof body.agent_id === "string"
      ? currentProfiles().get(body.agent_id)
      : undefined;
    if (!agent) {
      return c.json({ error: "agent_id must reference a registered Agent" }, 400);
    }
    if (agent.status !== "healthy") {
      return c.json({ error: "agent_unavailable", status: agent.status }, 409);
    }
    const generation = Number.isSafeInteger(body.generation)
      ? Number(body.generation)
      : 0;
    const slot: ChannelSlot = {
      channel,
      conversationId,
      agentId: agent.agentId,
      workspaceKey: typeof body.workspace_key === "string" && body.workspace_key
        ? body.workspace_key
        : canonicalWorkspaceKey(options.defaultCwd ?? "").key,
      generation,
    };
    const providerSessionId = body.provider_session_id;
    // 幂等：槽位已绑同 provider session → 直接返回，不重复建 Session。
    const bound = options.catalog.getChannelSession(slot);
    if (bound?.providerSessionId === providerSessionId) {
      return c.json({ session_id: bound.id });
    }
    // Lease 预检（UX，只读）：provider session 正被其他 run 持有 → busy。
    const liveLease = options.workItems.findLiveProviderLease(
      agent.agentId,
      providerSessionId,
      new Date().toISOString(),
    );
    if (liveLease) {
      return c.json({
        error: "provider_session_busy",
        detail: `provider session ${providerSessionId} 正被 run ${liveLease.runId} 使用`,
      }, 409);
    }
    try {
      const session = options.catalog.createAndBindHistoricalSession(
        slot,
        providerSessionId,
      );
      return c.json({ session_id: session.id });
    } catch (error) {
      if (error instanceof Error && error.message === "slot_already_bound") {
        return c.json({ error: "slot_already_bound" }, 409);
      }
      throw error;
    }
  });

  app.post("/v1/channels/command-context", async (c) => {
    const body = await readJson(c);
    const slot = parseChannelSlot(body?.slot);
    if (!slot) return c.json({ error: "invalid_slot" }, 400);
    const session = options.catalog.getChannelSession(slot);
    if (!session) {
      return c.json({
        session_id: null,
        active_run_id: null,
        provider_session_id: null,
      });
    }
    const runtime = options.workItems.getSessionRuntime(session.id);
    return c.json({
      session_id: session.id,
      active_run_id: runtime?.activeRunId ?? null,
      provider_session_id: session.providerSessionId,
    });
  });

  app.post("/v1/runs/:run_id/permission", async (c) => {
    if (!options.runner) {
      return c.json({ resolved: false, error: "runner_unavailable" }, 503);
    }
    const body = await readJson(c);
    if (typeof body?.approve !== "boolean") {
      return c.json({ error: "approve (boolean) is required" }, 400);
    }
    const resolved = await options.runner.resolvePermission(
      c.req.param("run_id"),
      body.approve,
    );
    return c.json({ resolved });
  });

  app.post("/v1/runs/:run_id/steer", async (c) => {
    if (!options.runner) {
      return c.json({ ok: false, error: "runner_unavailable" }, 503);
    }
    const body = await readJson(c);
    if (typeof body?.prompt !== "string" || !body.prompt.trim()) {
      return c.json({ ok: false, error: "prompt is required" }, 400);
    }
    // 按 runId 直接打 Runner，不依赖 orchestrator 的 activeChatRuns。
    return c.json(
      await options.runner.steer(c.req.param("run_id"), body.prompt),
    );
  });

  return app;
}

function providerHistoryError(c: Context, error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  if (code === "session_not_found") {
    return c.json({ error: code }, 404);
  }
  if (
    code === "provider_session_not_bound"
    || code === "provider_history_prefix_changed"
    || code === "provider_history_cursor_conflict"
  ) {
    return c.json({ error: code }, 409);
  }
  return c.json({ error: "provider_history_unavailable" }, 502);
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

function resolveEffectiveDefaultAgentId(
  agents: AgentProfile[],
  defaultAgentId: string | null,
): string | null {
  if (defaultAgentId) {
    const saved = agents.find((agent) => agent.agentId === defaultAgentId && agent.setup?.canSelectDefault);
    if (saved) return saved.agentId;
  }
  return agents.find((agent) => agent.setup?.canSelectDefault)?.agentId ?? null;
}

function mergeAgentSetup(
  agent: AgentProfile,
  setup: Parameters<typeof projectSetupState>[0],
): AgentProfile {
  const nextSetup = projectSetupState(setup);
  return {
    ...agent,
    status: projectAgentStatus(nextSetup),
    setup: nextSetup,
    setupManifest: cloneSetupManifest(agent.setupManifest),
    capabilities: [...agent.capabilities],
    models: [...agent.models],
    sessionFeatures: [...agent.sessionFeatures],
  };
}

function formatAgentSetupError(
  error: unknown,
  agent?: AgentProfile,
): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const details = error && typeof error === "object" && "details" in error && typeof (error as { details?: unknown }).details === "string"
    ? (error as { details: string }).details
    : undefined;
  const code = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "agent_setup_failed";
  return {
    error: code,
    message,
    details,
    ...(agent ? { agent: toApiAgent(agent) } : {}),
  };
}

function errorStatus(error: unknown, fallback: number): number {
  if (error && typeof error === "object" && "status" in error && typeof (error as { status?: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  return fallback;
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
    setup: agent.setup ? {
      installation: agent.setup.installation,
      configuration: agent.setup.configuration,
      runtime: agent.setup.runtime,
      version: agent.setup.version,
      executable_path: agent.setup.executablePath,
      diagnostic: agent.setup.diagnostic ? {
        stage: agent.setup.diagnostic.stage,
        code: agent.setup.diagnostic.code,
        message: agent.setup.diagnostic.message,
        details: agent.setup.diagnostic.details,
        exit_code: agent.setup.diagnostic.exitCode,
      } : undefined,
      can_select_default: agent.setup.canSelectDefault,
      can_create_session: agent.setup.canCreateSession,
    } : undefined,
    setup_manifest: agent.setupManifest ? {
      agent_id: agent.setupManifest.agentId,
      display_name: agent.setupManifest.displayName,
      adapter: agent.setupManifest.adapter,
      install_strategies: agent.setupManifest.installStrategies.map((strategy) => ({
        id: strategy.id,
        label: strategy.label,
        command: strategy.command,
        args: [...strategy.args],
        available: strategy.available,
        requires_confirmation: strategy.requiresConfirmation,
      })),
      configuration_owner: agent.setupManifest.configurationOwner,
      configuration_path: agent.setupManifest.configurationPath,
      documentation_url: agent.setupManifest.documentationUrl,
      supports_managed_configuration: agent.setupManifest.supportsManagedConfiguration,
    } : undefined,
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
    flow_definition_revision: session.flowDefinitionRevision,
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

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function channelInputRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseChannelSlot(value: unknown): {
  channel: string;
  conversationId: string;
  agentId: string;
  workspaceKey: string;
  generation: number;
} | undefined {
  if (!value || typeof value !== "object") return undefined;
  const slot = value as Record<string, unknown>;
  if (
    typeof slot.channel !== "string"
    || typeof slot.conversation_id !== "string"
    || typeof slot.agent_id !== "string"
    || typeof slot.workspace_key !== "string"
    || !Number.isSafeInteger(slot.generation)
  ) {
    return undefined;
  }
  return {
    channel: slot.channel,
    conversationId: slot.conversation_id,
    agentId: slot.agent_id,
    workspaceKey: slot.workspace_key,
    generation: Number(slot.generation),
  };
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
