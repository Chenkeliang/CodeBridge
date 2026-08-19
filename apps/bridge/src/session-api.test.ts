import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore, canonicalWorkspaceKey, defaultConfig } from "@codebridge/core";
import { AgentRegistry, projectSetupState, supportedAgentSetupManifests } from "@codebridge/agent-registry";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionCoordinator } from "@codebridge/session-coordinator";
import { SessionCatalogStore, type AgentProfile } from "@codebridge/session-catalog";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import { CapabilityRegistry } from "@codebridge/policy";
import { SessionRouter } from "@codebridge/router";
import { FeishuBridge, type FeishuMessage } from "@codebridge/channel-feishu";
import { createSessionApp } from "./session-api.js";
import { createChannelSessionIngress } from "./channel-ingress.js";
import type { RunnerClient } from "@codebridge/runner-client";

const TOKEN = "session-token";
const agents: AgentProfile[] = [
  {
    agentId: "codex",
    displayName: "Codex",
    adapter: "acp",
    status: "healthy",
    capabilities: ["session"],
    models: [],
    sessionFeatures: ["resume"],
  },
  {
    agentId: "pi",
    displayName: "Pi",
    adapter: "sdk",
    status: "healthy",
    capabilities: ["session"],
    models: [],
    sessionFeatures: ["resume"],
  },
];

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function setupAgent(agentId: string, setup: AgentProfile["setup"]): AgentProfile {
  const manifest = supportedAgentSetupManifests.find((candidate) => candidate.agentId === agentId);
  return {
    agentId,
    displayName: manifest?.displayName ?? agentId,
    adapter: manifest?.adapter ?? "acp",
    status: setup?.installation === "installed" && setup.configuration === "configured"
      ? setup.runtime === "healthy" ? "healthy" : "unavailable"
      : "needs_setup",
    capabilities: [],
    models: [],
    sessionFeatures: [],
    setup,
    setupManifest: manifest,
  };
}

function createSetupFixture(
  options: {
    defaultAgentId?: string | null;
    runner?: RunnerClient;
  } = {},
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-session-api-"));
  tempDirs.push(dataDir);
  const configStore = new ConfigStore({ dataDir });
  configStore.update((current) => ({
    ...current,
    defaultAgent: options.defaultAgentId ?? "pi",
  }));
  const catalog = new SessionCatalogStore(":memory:");
  const workItems = new SqliteEventStore(":memory:");
  const registry = new AgentRegistry({ databasePath: path.join(dataDir, "agents.sqlite") });
  registry.register(setupAgent("codex", projectSetupState({
    installation: "installed",
    configuration: "configured",
    runtime: "healthy",
  })));
  registry.register(setupAgent("pi", projectSetupState({
    installation: "installed",
    configuration: "configured",
    runtime: "healthy",
  })));
  registry.register(setupAgent("opencode", projectSetupState({
    installation: "missing",
    configuration: "unknown",
    runtime: "not_started",
  })));
  registry.register(setupAgent("claude", projectSetupState({
    installation: "installed",
    configuration: "needs_configuration",
    runtime: "not_started",
  })));
  const app = createSessionApp({
    catalog,
    agents: () => registry.list(),
    agentRegistry: registry,
    configStore,
    workItems,
    runner: options.runner,
  }, TOKEN);
  return {
    app,
    catalog,
    workItems,
    registry,
    configStore,
  };
}

interface WriteCounters {
  totalChanges: number;
  eventCount: number;
  attachmentCount: number;
  runCount: number;
  historyImportCount: number;
}

function snapshotWriteCounters(
  store: SqliteEventStore,
  sessionId: string,
  providerSessionId: string,
): WriteCounters {
  const workItem = store.getWorkItemBySessionId(sessionId);
  if (!workItem) {
    throw new Error(`WorkItem not found for Session ${sessionId}`);
  }
  return {
    totalChanges: store.countAllChanges(),
    eventCount: store.listEvents(workItem.id).length,
    attachmentCount: store.listMessageAttachments(workItem.id).length,
    runCount: store.listRuns(workItem.id).length,
    historyImportCount: store.getProviderHistoryImport(sessionId, providerSessionId)
      ? 1
      : 0,
  };
}

async function createReadOnlyMatrixFixture() {
  const dataDir = fs.mkdtempSync(
    path.join(process.cwd(), ".codebridge-session-api-"),
  );
  tempDirs.push(dataDir);
  const catalog = new SessionCatalogStore(":memory:");
  const workItems = new SqliteEventStore(path.join(dataDir, "session.sqlite"));
  const coordinator = new SessionCoordinator(workItems, { maxQueuedTurns: 100 });
  const loadSessionHistory = vi.fn().mockResolvedValue([
    { kind: "message", text: "old question" },
    {
      kind: "agent_event",
      event: {
        type: "text_delta",
        blockId: "answer",
        text: "old answer",
      },
    },
  ]);
  const runner = {
    loadSessionHistory,
  } as unknown as RunnerClient;
  const app = createSessionApp({
    catalog,
    agents,
    workItems,
    coordinator,
    runner,
  }, TOKEN);
  const session = catalog.createSession({
    agentId: "pi",
    cwd: "/workspace",
    providerSessionId: "provider_1",
  });
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };

  const preview = await app.request(
    `/v1/sessions/${session.id}/provider-history/preview`,
    { method: "POST", headers },
  );
  expect(preview.status).toBe(200);

  const imported = await app.request(
    `/v1/sessions/${session.id}/provider-history/import`,
    {
      method: "POST",
      headers: {
        ...headers,
        "idempotency-key": "history-import-1",
      },
      body: JSON.stringify({ confirm: true }),
    },
  );
  expect(imported.status).toBe(200);

  const first = coordinator.submitTurn({
    sessionId: session.id,
    idempotencyKey: "message_1",
    attachments: [
      {
        id: "attachment_1",
        name: "context.txt",
        mimeType: "text/plain",
        dataBase64: Buffer.from("hello").toString("base64"),
      },
    ],
    message: {
      text: "请读取这个上下文",
      attachmentIds: [],
      flowId: null,
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    },
    workItem: {
      title: "请读取这个上下文",
      mode: "auto",
      conversationId: `conv_${session.id.slice("sess_".length)}`,
      agentId: session.agentId,
      workspaceScope: session.cwd ? [session.cwd] : [],
      riskLevel: "read_only",
    },
  });
  expect(first.run).toBeTruthy();

  const second = coordinator.submitTurn({
    sessionId: session.id,
    idempotencyKey: "message_2",
    message: {
      text: "继续追踪",
      attachmentIds: [],
      flowId: null,
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    },
    workItem: {
      title: "继续追踪",
      mode: "auto",
      conversationId: `conv_${session.id.slice("sess_".length)}`,
      agentId: session.agentId,
      workspaceScope: session.cwd ? [session.cwd] : [],
      riskLevel: "read_only",
    },
  });
  expect(second.run).toBeNull();
  loadSessionHistory.mockClear();

  return {
    app,
    catalog,
    workItems,
    loadSessionHistory,
    sessionId: session.id,
    providerSessionId: session.providerSessionId,
    close() {
      catalog.close();
      workItems.close();
    },
  };
}

describe("session API agent setup routing", () => {
  it("returns the saved and effective default agent ids", async () => {
    const fixture = createSetupFixture({ defaultAgentId: "pi" });
    const response = await fixture.app.request("/v1/agents", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      default_agent_id: "pi",
      effective_default_agent_id: "pi",
    });

    const updated = await fixture.app.request("/v1/settings/default-agent", {
      method: "PATCH",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "codex" }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      default_agent_id: "codex",
      effective_default_agent_id: "codex",
    });
    expect(fixture.configStore.get().defaultAgent).toBe("codex");
    expect(fixture.configStore.get().defaultBackend).toBe("codex");

    fixture.registry.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("retains an invalid saved default while falling back to an eligible Agent", async () => {
    const fixture = createSetupFixture({ defaultAgentId: "missing-default" });
    const response = await fixture.app.request("/v1/agents", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      default_agent_id: "missing-default",
      effective_default_agent_id: "codex",
    });

    const missing = await fixture.app.request("/v1/settings/default-agent", {
      method: "PATCH",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "opencode" }),
    });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error: "agent_not_installed" });

    const unconfigured = await fixture.app.request("/v1/settings/default-agent", {
      method: "PATCH",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "claude" }),
    });
    expect(unconfigured.status).toBe(409);
    expect(await unconfigured.json()).toMatchObject({ error: "agent_not_configured" });

    const unknown = await fixture.app.request("/v1/settings/default-agent", {
      method: "PATCH",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "missing" }),
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: "agent_not_found" });

    fixture.registry.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("relays detection and installation updates through the registry", async () => {
    const runner = {
      detectAgent: async () => ({
        agentId: "opencode",
        installation: "installed",
        configuration: "configured",
        runtime: "healthy",
        version: "1.2.3",
        executablePath: "opencode",
        canSelectDefault: true,
        canCreateSession: true,
      }),
      installAgent: async () => ({
        agentId: "opencode",
        ok: false,
        installation: "installed",
        configuration: "configured",
        runtime: "unavailable",
        diagnostic: {
          stage: "install",
          code: "install_failed",
          message: "install failed",
          details: "Authorization: ******",
          exitCode: 1,
        },
        canSelectDefault: true,
        canCreateSession: false,
      }),
    } as unknown as RunnerClient;
    const fixture = createSetupFixture({ runner });

    const detected = await fixture.app.request("/v1/agents/opencode/detect", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(detected.status).toBe(200);
    expect(await detected.json()).toMatchObject({
      agent_id: "opencode",
      status: "healthy",
      setup: {
        installation: "installed",
        configuration: "configured",
        runtime: "healthy",
        can_select_default: true,
        can_create_session: true,
      },
    });
    expect(fixture.registry.get("opencode")?.status).toBe("healthy");

    const install = await fixture.app.request("/v1/agents/opencode/install", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ strategy_id: "npm-global" }),
    });
    expect(install.status).toBe(409);
    expect(await install.json()).toMatchObject({
      error: "install_failed",
      message: "install failed",
      details: "Authorization: ******",
      agent: expect.objectContaining({
        agent_id: "opencode",
      }),
    });
    expect(fixture.registry.get("opencode")?.setup?.runtime).toBe("unavailable");

    fixture.registry.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("detects all Agents in one call and updates the registry", async () => {
    const runner = {
      detectAllAgents: async () => ({
        agents: [
          { agentId: "pi", installation: "installed", configuration: "configured", runtime: "healthy", version: "1.0", executablePath: "pi", canSelectDefault: true, canCreateSession: true },
          { agentId: "opencode", installation: "missing", configuration: "unknown", runtime: "not_started", canSelectDefault: false, canCreateSession: false },
        ],
      }),
    } as unknown as RunnerClient;
    const fixture = createSetupFixture({ runner });

    const response = await fixture.app.request("/v1/agents/detect", {
      method: "POST",
      headers: { authorization: "Bearer " + TOKEN },
    });
    expect(response.status).toBe(200);
    expect(fixture.registry.get("pi")?.setup).toMatchObject({ installation: "installed", runtime: "healthy" });
    expect(fixture.registry.get("opencode")?.setup?.installation).toBe("missing");

    fixture.registry.close();
    fixture.catalog.close();
    fixture.workItems.close();
  });
});

describe("session API", () => {
  it("does not call the Runner or write SQLite when opening a Session", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const loadSessionHistory = vi.fn();
    const runner = {
      loadSessionHistory,
    } as unknown as RunnerClient;
    const session = catalog.createSession({
      agentId: "pi",
      cwd: "/workspace",
      providerSessionId: "provider_1",
    });
    const app = createSessionApp({
      catalog,
      agents,
      workItems,
      runner,
    }, TOKEN);
    const before = workItems.countAllChanges();

    const response = await app.request(
      `/v1/sessions/${session.id}`,
      { headers: { authorization: "Bearer " + TOKEN } },
    );

    expect(response.status).toBe(200);
    expect(loadSessionHistory).not.toHaveBeenCalled();
    expect(workItems.countAllChanges()).toBe(before);
    catalog.close();
    workItems.close();
  });

  it.each([
    "",
    "/timeline",
    "/queue",
    "/commands",
    "/events?after_sequence=0&limit=500",
  ] as const)("keeps GET %s read-only", async (suffix) => {
    const fixture = await createReadOnlyMatrixFixture();
    try {
      const path = `/v1/sessions/${fixture.sessionId}${suffix}`;
      const before = snapshotWriteCounters(
        fixture.workItems,
        fixture.sessionId,
        fixture.providerSessionId ?? "provider_1",
      );
      const loadCalls = fixture.loadSessionHistory.mock.calls.length;

      const response = await fixture.app.request(path, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.status).toBe(200);
      expect(snapshotWriteCounters(
        fixture.workItems,
        fixture.sessionId,
        fixture.providerSessionId ?? "provider_1",
      )).toEqual(before);
      expect(fixture.loadSessionHistory.mock.calls.length).toBe(loadCalls);
    } finally {
      fixture.close();
    }
  });

  it("previews and imports Provider history only through confirmed POSTs", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      loadSessionHistory: vi.fn().mockResolvedValue([
        { kind: "message", text: "old question" },
        {
          kind: "agent_event",
          event: {
            type: "text_delta",
            blockId: "answer",
            text: "old answer",
          },
        },
      ]),
    } as unknown as RunnerClient;
    const session = catalog.createSession({
      agentId: "pi",
      cwd: "/workspace",
      providerSessionId: "provider_1",
    });
    const app = createSessionApp({
      catalog,
      agents,
      workItems,
      runner,
    }, TOKEN);
    const headers = {
      authorization: "Bearer " + TOKEN,
      "content-type": "application/json",
    };

    const preview = await app.request(
      `/v1/sessions/${session.id}/provider-history/preview`,
      { method: "POST", headers },
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      importableEvents: 2,
    });

    const unconfirmed = await app.request(
      `/v1/sessions/${session.id}/provider-history/import`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ confirm: true }),
      },
    );
    expect(unconfirmed.status).toBe(400);

    const imported = await app.request(
      `/v1/sessions/${session.id}/provider-history/import`,
      {
        method: "POST",
        headers: {
          ...headers,
          "idempotency-key": "import_1",
        },
        body: JSON.stringify({ confirm: true }),
      },
    );
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({
      importedEvents: 2,
      importedTurns: 1,
    });
    expect(catalog.getSession(session.id)?.taskRecordId).toBeTruthy();
    catalog.close();
    workItems.close();
  });

  it("creates a session fixed to an Agent and maps messages to a TaskRecord", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);

    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "pi", model: "pi-model" }),
    });
    expect(create.status).toBe(201);
    const session = (await create.json()) as { session_id: string; agent_id: string; model: string | null };
    expect(session.agent_id).toBe("pi");
    expect(session.model).toBe("pi-model");

    const message = await app.request(`/v1/sessions/${session.session_id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "检查当前上下文", flow_id: "flow-a" }),
    });
    expect(message.status).toBe(202);
    const accepted = (await message.json()) as { task_record_id: string };
    expect(accepted.task_record_id).toMatch(/^wi_/);

    const current = await app.request(`/v1/sessions/${session.session_id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await current.json()).toMatchObject({
      session: {
        task_record_id: accepted.task_record_id,
        flow_id: "flow-a",
      },
    });
    expect(workItems.listEvents(accepted.task_record_id).map((event) => event.type)).toContain("MESSAGE_RECEIVED");
    catalog.close();
    workItems.close();
  });

  it("groups sessions through the Agent registry and protects the API", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    expect((await app.request("/v1/agents")).status).toBe(401);
    catalog.createSession({ agentId: "codex", title: "会话" });

    const response = await app.request("/v1/sessions?agent_id=codex", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { sessions: unknown[] }).sessions).toHaveLength(1);
    catalog.close();
    workItems.close();
  });

  it("renames, pins, and archives a Session through its metadata API", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "codex", title: "原始名称" }),
    });
    const session = await create.json() as { session_id: string };
    const renamed = await app.request(`/v1/sessions/${session.session_id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "重命名后的会话", pinned: true }),
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ title: "重命名后的会话", pinned_at: expect.any(String), archived_at: null });

    const archived = await app.request(`/v1/sessions/${session.session_id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ archived_at: expect.any(String), pinned_at: null });
    expect((await (await app.request("/v1/sessions", { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { sessions: unknown[] }).sessions).toHaveLength(0);
    expect((await (await app.request("/v1/sessions?include_archived=true", { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { sessions: unknown[] }).sessions).toHaveLength(1);
    catalog.close();
    workItems.close();
  });

  it("persists a selected model on the Session", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "codex" }),
    });
    const session = await create.json() as { session_id: string };
    const updated = await app.request(`/v1/sessions/${session.session_id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5-codex" }),
    });

    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ model: "openai/gpt-5-codex" });
    catalog.close();
    workItems.close();
  });

  it("persists a selected Agent permission mode on the Session", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const session = catalog.createSession({ agentId: "codex" });

    const updated = await app.request(`/v1/sessions/${session.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ permission_mode: "agent-full-access" }),
    });

    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ permission_mode: "agent-full-access" });
    catalog.close();
    workItems.close();
  });

  it("persists a selected reasoning effort on the Session", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const session = catalog.createSession({ agentId: "codex" });

    const updated = await app.request(`/v1/sessions/${session.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ effort: "xhigh" }),
    });

    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ effort: "xhigh" });
    catalog.close();
    workItems.close();
  });

  it("persists validated Agent config overrides on the Session", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const session = catalog.createSession({ agentId: "codex" });

    const updated = await app.request(`/v1/sessions/${session.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ config_overrides: { "fast-mode": true } }),
    });
    const invalid = await app.request(`/v1/sessions/${session.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ config_overrides: { "fast-mode": { enabled: true } } }),
    });

    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ config_overrides: { "fast-mode": true } });
    expect(invalid.status).toBe(400);
    catalog.close();
    workItems.close();
  });

  it("reads Agent health dynamically for later Session creation", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    let status: AgentProfile["status"] = "unavailable";
    const app = createSessionApp({
      catalog,
      agents: () => [{ ...agents[1]!, status }],
      workItems,
    }, TOKEN);
    const unavailable = await app.request("/v1/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "pi" }),
    });
    expect(unavailable.status).toBe(409);

    status = "healthy";
    const healthy = await app.request("/v1/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "pi" }),
    });
    expect(healthy.status).toBe(201);
    catalog.close();
    workItems.close();
  });

  it("maps channel conversations onto the same Session Message and Run contracts", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const send = (message: string) => app.request("/v1/channels/feishu/conversations/chat%3Atopic/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message, agent_id: "pi", cwd: "/tmp/project" }),
    });

    const first = await send("第一条");
    expect(first.status).toBe(202);
    const firstBody = await first.json() as { session_id: string; task_record_id: string; run_id: string };
    const secondBody = await (await send("第二条")).json() as typeof firstBody;
    expect(secondBody.session_id).toBe(firstBody.session_id);
    expect(secondBody.task_record_id).toBe(firstBody.task_record_id);
    expect(secondBody.run_id).not.toBe(firstBody.run_id);
    expect(catalog.getChannelSession({
      channel: "feishu",
      conversationId: "chat:topic",
      agentId: "pi",
      workspaceKey: canonicalWorkspaceKey("/tmp/project").key,
      generation: 0,
    })?.id).toBe(firstBody.session_id);
    expect(workItems.listRuns(firstBody.task_record_id)).toHaveLength(2);
    catalog.close();
    workItems.close();
  });

  it("submits channel messages atomically when the Session Coordinator is enabled", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const coordinator = new SessionCoordinator(workItems, {
      maxQueuedTurns: 8,
    });
    const app = createSessionApp({
      catalog,
      agents,
      workItems,
      coordinator,
    }, TOKEN);

    const response = await app.request(
      "/v1/channels/feishu/conversations/chat/messages",
      {
        method: "POST",
        headers: {
          authorization: ["Bearer", TOKEN].join(" "),
          "content-type": "application/json",
          "idempotency-key": "feishu-message-1",
        },
        body: JSON.stringify({ message: "继续", agent_id: "pi" }),
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      acceptance: "dispatched",
      session_id: expect.stringMatching(/^sess_/),
      run_id: expect.stringMatching(/^run_/),
      turn_id: expect.stringMatching(/^turn_/),
    });
    catalog.close();
    workItems.close();
  });

  it("syncs session_runtime.provider_session_id for a bound session", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const coordinator = new SessionCoordinator(workItems, { maxQueuedTurns: 8 });
    const app = createSessionApp({
      catalog,
      agents,
      workItems,
      coordinator,
    }, TOKEN);

    const session = catalog.createSession({
      agentId: "pi",
      cwd: "/tmp/project",
      providerSessionId: "provider_1",
    });
    catalog.bindChannelConversation({
      channel: "feishu",
      conversationId: "chat:topic",
      agentId: "pi",
      workspaceKey: canonicalWorkspaceKey("/tmp/project").key,
      generation: 0,
    }, session.id);

    const response = await app.request(
      "/v1/channels/feishu/conversations/chat%3Atopic/messages",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "idempotency-key": "provider-sync-1",
        },
        body: JSON.stringify({
          message: "继续",
          agent_id: "pi",
          cwd: "/tmp/project",
        }),
      },
    );

    expect(response.status).toBe(202);
    let providerSessionId: string | null = null;
    workItems.withSessionTransaction((tx) => {
      providerSessionId = tx.getSessionProviderSessionId(session.id);
    });
    expect(providerSessionId).toBe("provider_1");
    catalog.close();
    workItems.close();
  });

  it("resume binds a provider session to an unbound slot (D6)", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);

    const response = await app.request(
      "/v1/channels/feishu/conversations/chat%3Atopic/resume",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agent_id: "pi",
          workspace_key: canonicalWorkspaceKey("/tmp/project").key,
          generation: 0,
          provider_session_id: "provider_old",
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { session_id: string };
    const session = catalog.getChannelSession({
      channel: "feishu",
      conversationId: "chat:topic",
      agentId: "pi",
      workspaceKey: canonicalWorkspaceKey("/tmp/project").key,
      generation: 0,
    });
    expect(session?.id).toBe(body.session_id);
    expect(session?.providerSessionId).toBe("provider_old");
    catalog.close();
    workItems.close();
  });

  it("resume is idempotent for the same provider session", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const first = await app.request(
      "/v1/channels/feishu/conversations/chat%3Atopic/resume",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agent_id: "pi",
          workspace_key: canonicalWorkspaceKey("/tmp/project").key,
          generation: 0,
          provider_session_id: "provider_dup",
        }),
      },
    );
    const second = await app.request(
      "/v1/channels/feishu/conversations/chat%3Atopic/resume",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agent_id: "pi",
          workspace_key: canonicalWorkspaceKey("/tmp/project").key,
          generation: 0,
          provider_session_id: "provider_dup",
        }),
      },
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = await first.json() as { session_id: string };
    const b = await second.json() as { session_id: string };
    expect(b.session_id).toBe(a.session_id);
    expect(catalog.listSessions("pi")).toHaveLength(1);
    catalog.close();
    workItems.close();
  });

  it("resume returns busy when the provider session is leased to another run", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    workItems.claimProviderSession({
      agentId: "pi",
      providerSessionId: "provider_busy",
      runId: "run_old",
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const response = await app.request(
      "/v1/channels/feishu/conversations/chat%3Atopic/resume",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agent_id: "pi",
          workspace_key: canonicalWorkspaceKey("/tmp/project").key,
          generation: 0,
          provider_session_id: "provider_busy",
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "provider_session_busy",
    });
    // 旧 Run 不受影响：lease 仍被 run_old 持有（预检只读）。
    expect(
      workItems.findLiveProviderLease(
        "pi",
        "provider_busy",
        new Date().toISOString(),
      ),
    ).toEqual({ runId: "run_old" });
    catalog.close();
    workItems.close();
  });

  it("resume reports slot_already_bound for a different bound session", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const slot = {
      channel: "feishu",
      conversationId: "chat:topic",
      agentId: "pi",
      workspaceKey: canonicalWorkspaceKey("/tmp/project").key,
      generation: 0,
    };
    const existing = catalog.createSession({
      agentId: "pi",
      cwd: "/tmp/project",
      providerSessionId: "provider_x",
    });
    catalog.bindChannelConversation(slot, existing.id);

    const response = await app.request(
      "/v1/channels/feishu/conversations/chat%3Atopic/resume",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agent_id: "pi",
          workspace_key: slot.workspaceKey,
          generation: 0,
          provider_session_id: "provider_y",
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "slot_already_bound",
    });
    // 原绑定不被覆盖。
    expect(catalog.getChannelSession(slot)?.providerSessionId).toBe("provider_x");
    catalog.close();
    workItems.close();
  });

  it("resume rejects an unknown agent instead of falling back", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);

    const response = await app.request(
      "/v1/channels/feishu/conversations/chat%3Atopic/resume",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agent_id: "ghost-agent",
          workspace_key: canonicalWorkspaceKey("/tmp/project").key,
          generation: 0,
          provider_session_id: "provider_ghost",
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "agent_id must reference a registered Agent",
    });
    // 未 fallback：没有任何绑定落到其他 agent 名下。
    expect(catalog.getChannelSession({
      channel: "feishu",
      conversationId: "chat:topic",
      agentId: "pi",
      workspaceKey: canonicalWorkspaceKey("/tmp/project").key,
      generation: 0,
    })).toBeUndefined();
    catalog.close();
    workItems.close();
  });

  it("wires a real 409 busy response through ingress to the /resume busy reply", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    workItems.claimProviderSession({
      agentId: "pi",
      providerSessionId: "provider_busy",
      runId: "run_old",
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const ingress = createChannelSessionIngress(app, TOKEN);

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-resume-wire-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cb-resume-ws-"));
    try {
      const bridge = new FeishuBridge({
        config: defaultConfig(),
        dataDir,
      }) as unknown as {
        sessionIngress: unknown;
        orchestrator: {
          router: SessionRouter;
          listSessions: (
            _chatId: string,
            _topicId: string | undefined,
            _options?: { all?: boolean; limit?: number },
          ) => Promise<Array<{
            id: string;
            backend: string;
            cwd: string;
            preview: string;
            updatedAt: string;
          }>>;
        };
        channel: {
          send(
            _chatId: string,
            input: { markdown: string },
            _options: unknown,
          ): Promise<void>;
        };
        handleMessage(message: FeishuMessage): Promise<void>;
        disconnect(): Promise<void>;
      };
      bridge.sessionIngress = ingress;
      const router = new SessionRouter(dataDir);
      router.initFromConfig(defaultConfig());
      router.setBinding("chat-1", {
        backendId: "pi",
        cwd: workspace,
      });
      bridge.orchestrator = {
        router,
        listSessions: async () => [{
          id: "provider_busy",
          backend: "pi",
          cwd: workspace,
          preview: "busy session",
          updatedAt: "2026-07-07T00:00:00Z",
        }],
      };
      const replies: string[] = [];
      bridge.channel = {
        async send(_chatId, input) {
          replies.push(input.markdown);
        },
      };

      await bridge.handleMessage({
        messageId: "m1",
        chatId: "chat-1",
        chatType: "p2p",
        senderId: "user-1",
        content: "/resume 1",
      });

      expect(replies.join("\n")).toContain("正被其他任务占用");
    } finally {
      catalog.close();
      workItems.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("wires /steer through the slot activeRunId to the Runner", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      steer: vi.fn().mockResolvedValue({ ok: true, outcome: "injected" }),
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);
    const ingress = createChannelSessionIngress(app, TOKEN);

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-steer-wire-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cb-steer-ws-"));
    try {
      // 槽位绑定 + runtime active run（Catalog + runtime 为唯一事实源）。
      const session = catalog.createSession({
        agentId: "pi",
        cwd: workspace,
      });
      catalog.bindChannelConversation({
        channel: "feishu",
        conversationId: "chat-1|",
        agentId: "pi",
        workspaceKey: canonicalWorkspaceKey(workspace).key,
        generation: 0,
      }, session.id);
      workItems.withSessionTransaction((tx) => {
        tx.ensureRuntime(session.id);
        tx.updateRuntime(session.id, { activeRunId: "run_9" });
      });

      const bridge = new FeishuBridge({
        config: defaultConfig(),
        dataDir,
      }) as unknown as {
        sessionIngress: unknown;
        orchestrator: {
          router: SessionRouter;
        };
        channel: {
          send(
            _chatId: string,
            input: { markdown: string },
            _options: unknown,
          ): Promise<void>;
        };
        handleMessage(message: FeishuMessage): Promise<void>;
        disconnect(): Promise<void>;
      };
      bridge.sessionIngress = ingress;
      const router = new SessionRouter(dataDir);
      router.initFromConfig(defaultConfig());
      router.setBinding("chat-1", {
        backendId: "pi",
        cwd: workspace,
      });
      bridge.orchestrator = { router };
      const replies: string[] = [];
      bridge.channel = {
        async send(_chatId, input) {
          replies.push(input.markdown);
        },
      };

      await bridge.handleMessage({
        messageId: "m1",
        chatId: "chat-1",
        chatType: "p2p",
        senderId: "user-1",
        content: "/steer focus on tests",
      });

      expect(runner.steer).toHaveBeenCalledWith("run_9", "focus on tests");
      expect(replies.join("\n")).toContain("injected");
    } finally {
      catalog.close();
      workItems.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("persists a channel delivery when a reply_to_message_id is provided", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const coordinator = new SessionCoordinator(workItems, { maxQueuedTurns: 8 });
    const app = createSessionApp({
      catalog,
      agents,
      workItems,
      coordinator,
    }, TOKEN);

    const response = await app.request(
      "/v1/channels/feishu/conversations/chat/messages",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "idempotency-key": "feishu-delivery-1",
        },
        body: JSON.stringify({
          message: "继续",
          agent_id: "pi",
          reply_to_message_id: "msg-42",
        }),
      },
    );
    expect(response.status).toBe(202);

    const deliveries = workItems.listDeliveries("feishu");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      channel: "feishu",
      conversationId: "chat",
      replyToMessageId: "msg-42",
      status: "dispatched",
    });
    catalog.close();
    workItems.close();
  });

  it("serializes channel events with camelCase runId", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const coordinator = new SessionCoordinator(workItems, { maxQueuedTurns: 8 });
    const app = createSessionApp({
      catalog,
      agents,
      workItems,
      coordinator,
    }, TOKEN);

    const accepted = await app.request(
      "/v1/channels/feishu/conversations/chat/messages",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "idempotency-key": "feishu-events-1",
        },
        body: JSON.stringify({ message: "继续", agent_id: "pi" }),
      },
    );
    const body = await accepted.json() as { session_id: string };

    const eventsResponse = await app.request(
      `/v1/sessions/${encodeURIComponent(body.session_id)}/events`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const eventsBody = await eventsResponse.json() as {
      events: Array<{ type: string; runId: string | null }>;
    };
    const runCreated = eventsBody.events.find((event) => event.type === "RUN_CREATED");
    expect(runCreated?.runId).toMatch(/^run_/);
    catalog.close();
    workItems.close();
  });

  it("resolves command context per slot without cross-slot leakage", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const coordinator = new SessionCoordinator(workItems, { maxQueuedTurns: 8 });
    const app = createSessionApp({ catalog, agents, workItems, coordinator }, TOKEN);
    const submit = (agentId: string, key: string) =>
      app.request("/v1/channels/feishu/conversations/chat/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({ message: "hi", agent_id: agentId, cwd: "/tmp/project" }),
      });

    const pi = await (await submit("pi", "ctx-pi")).json() as { session_id: string; run_id: string };
    const codex = await (await submit("codex", "ctx-cursor")).json() as { session_id: string; run_id: string };

    const slotFor = (agentId: string) => ({
      channel: "feishu",
      conversation_id: "chat",
      agent_id: agentId,
      workspace_key: "/tmp/project",
      generation: 0,
    });
    const ctx = async (agentId: string) => {
      const response = await app.request("/v1/channels/command-context", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ slot: slotFor(agentId) }),
      });
      return await response.json() as {
        session_id: string;
        active_run_id: string | null;
        provider_session_id: string | null;
      };
    };

    const piCtx = await ctx("pi");
    const codexCtx = await ctx("codex");

    expect(piCtx.session_id).toBe(pi.session_id);
    expect(piCtx.active_run_id).toBe(pi.run_id);
    expect(codexCtx.session_id).toBe(codex.session_id);
    expect(codexCtx.active_run_id).toBe(codex.run_id);
    expect(piCtx.session_id).not.toBe(codexCtx.session_id);
    catalog.close();
    workItems.close();
  });

  it("returns a null command context for an unbound slot", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const response = await app.request("/v1/channels/command-context", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        slot: { channel: "feishu", conversation_id: "chat", agent_id: "pi", workspace_key: "/tmp/p", generation: 0 },
      }),
    });
    expect(await response.json()).toEqual({
      session_id: null,
      active_run_id: null,
      provider_session_id: null,
    });
    catalog.close();
    workItems.close();
  });

  it("returns the catalog provider session id in command context", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const slot = {
      channel: "feishu",
      conversationId: "chat",
      agentId: "pi",
      workspaceKey: "/tmp/p",
      generation: 0,
    };
    const session = catalog.createAndBindHistoricalSession(slot, "provider-1");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const response = await app.request("/v1/channels/command-context", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        slot: {
          channel: slot.channel,
          conversation_id: slot.conversationId,
          agent_id: slot.agentId,
          workspace_key: slot.workspaceKey,
          generation: slot.generation,
        },
      }),
    });
    expect(await response.json()).toEqual({
      session_id: session.id,
      active_run_id: null,
      provider_session_id: "provider-1",
    });
    catalog.close();
    workItems.close();
  });

  it("proxies runner permission resolution through the permission route", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const resolvePermission = vi.fn().mockResolvedValue(true);
    const app = createSessionApp({
      catalog,
      agents,
      workItems,
      runner: { resolvePermission } as unknown as RunnerClient,
    }, TOKEN);
    const approveResponse = await app.request("/v1/runs/run_1/permission", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ approve: true }),
    });
    expect(approveResponse.status).toBe(200);
    expect(await approveResponse.json()).toEqual({ resolved: true });
    expect(resolvePermission).toHaveBeenCalledWith("run_1", true);

    const denyResponse = await app.request("/v1/runs/run_1/permission", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ approve: false }),
    });
    expect(denyResponse.status).toBe(200);
    expect(resolvePermission).toHaveBeenCalledWith("run_1", false);

    const invalidResponse = await app.request("/v1/runs/run_1/permission", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toEqual({ error: "approve (boolean) is required" });
    catalog.close();
    workItems.close();
  });

  it("resets only the exact slot", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const submit = (agentId: string, key: string) =>
      app.request("/v1/channels/feishu/conversations/chat/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({ message: "hi", agent_id: agentId, cwd: "/tmp/project" }),
      });
    await submit("pi", "reset-pi");
    await submit("codex", "reset-codex");

    const reset = await app.request("/v1/channels/feishu/conversations/chat/reset", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "pi", workspace_key: "/tmp/project", generation: 0 }),
    });
    expect((await reset.json()) as { reset: boolean }).toEqual({ reset: true });

    const codexCtx = await app.request("/v1/channels/command-context", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ slot: { channel: "feishu", conversation_id: "chat", agent_id: "codex", workspace_key: "/tmp/project", generation: 0 } }),
    });
    expect(((await codexCtx.json()) as { session_id: string | null }).session_id).not.toBeNull();

    const piCtx = await app.request("/v1/channels/command-context", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ slot: { channel: "feishu", conversation_id: "chat", agent_id: "pi", workspace_key: "/tmp/project", generation: 0 } }),
    });
    expect(((await piCtx.json()) as { session_id: string | null }).session_id).toBeNull();
    catalog.close();
    workItems.close();
  });

  it("moves provider Session discovery off the GET route", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      listSessions: async () => ({ sessions: [{ id: "provider-1", backend: "codex", cwd: "/tmp/project", preview: "已有会话", updatedAt: "2026-08-07T00:00:00.000Z" }] }),
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner, defaultCwd: "/tmp/project" }, TOKEN);
    const response = await app.request("/v1/sessions?import=true&agent_id=codex", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: "provider_import_moved",
    });
    const refreshed = await app.request("/v1/sessions?import=true&agent_id=codex", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(refreshed.status).toBe(410);
    catalog.close();
    workItems.close();
  });

  it("keeps provider history out of the Session GET path", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      loadSessionHistory: async () => [
        { kind: "message", text: "查询手机号用户信息" },
        { kind: "agent_event", event: { type: "text_delta", text: "会员有效期为 30 天" } },
      ],
    } as unknown as RunnerClient;
    const session = catalog.createSession({
      agentId: "codex",
      providerSessionId: "provider-history",
      cwd: "/tmp/project",
      title: "查询手机号用户信息和会员状态",
    });
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);

    const response = await app.request(`/v1/sessions/${session.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(
      (await response.json() as {
        session: { task_record_id: string | null };
      }).session.task_record_id,
    ).toBeNull();

    const events = await app.request(`/v1/sessions/${session.id}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = await events.text();
    expect(body).not.toContain("MESSAGE_RECEIVED");
    expect(body).not.toContain("查询手机号用户信息");
    expect(body).not.toContain("text_delta");
    expect(body).not.toContain("会员有效期为 30 天");
    expect(body).not.toContain("SESSION_HISTORY_HYDRATED");
    catalog.close();
    workItems.close();
  });

  it("does not persist a provider snapshot after the same response was streamed", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const workItem = workItems.createWorkItem({
      title: "重复快照",
      mode: "auto",
      conversationId: "snapshot-dedupe",
      agentId: "pi",
      workspaceScope: ["/tmp/project"],
      riskLevel: "read_only",
    });
    workItems.appendEvent({ workItemId: workItem.id, type: "MESSAGE_RECEIVED", actor: "user", payload: { message: "问题" } });
    workItems.appendEvent({ workItemId: workItem.id, type: "AGENT_EVENT", actor: "agent", payload: { event: { type: "thought_delta", text: "**先确认" } } });
    workItems.appendEvent({ workItemId: workItem.id, type: "AGENT_EVENT", actor: "agent", payload: { event: { type: "thought_delta", text: "问题范围**" } } });
    const session = catalog.createSession({ agentId: "pi", providerSessionId: "provider-snapshot", taskRecordId: workItem.id, cwd: "/tmp/project" });
    const runner = {
      loadSessionHistory: async () => [
        { kind: "message" as const, text: "问题" },
        { kind: "agent_event" as const, event: { type: "thought_delta", text: "**先确认问题范围**" } },
      ],
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);

    await app.request(`/v1/sessions/${session.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });

    expect(workItems.listEvents(workItem.id).filter((event) => event.type === "AGENT_EVENT")).toHaveLength(2);
    catalog.close();
    workItems.close();
  });

  it("reads persisted events once while reconciling provider snapshots", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const workItem = workItems.createWorkItem({
      title: "Large imported history",
      mode: "auto",
      conversationId: "snapshot-linear-scan",
      agentId: "pi",
      workspaceScope: ["/tmp/project"],
      riskLevel: "read_only",
    });
    const session = catalog.createSession({ agentId: "pi", providerSessionId: "provider-linear-scan", taskRecordId: workItem.id, cwd: "/tmp/project" });
    const inputHash = (position: number) => `sha256:${createHash("sha256")
      .update(`${session.agentId}\0${session.providerSessionId}\0${position}`)
      .digest("hex")}`;
    workItems.appendEventOnce({ workItemId: workItem.id, type: "AGENT_EVENT", actor: "agent", inputHash: inputHash(0), payload: { event: { type: "thought_delta", text: "first second" } } });
    workItems.appendEventOnce({ workItemId: workItem.id, type: "AGENT_EVENT", actor: "agent", inputHash: inputHash(1), payload: { event: { type: "text_delta", text: "answer" } } });
    const runner = {
      loadSessionHistory: async () => [
        { kind: "agent_event" as const, event: { type: "thought_delta", text: "first second" } },
        { kind: "agent_event" as const, event: { type: "text_delta", text: "answer" } },
      ],
    } as unknown as RunnerClient;
    const listEvents = vi.spyOn(workItems, "listEvents");
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);

    await app.request(`/v1/sessions/${session.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });

    expect(listEvents).not.toHaveBeenCalled();
    catalog.close();
    workItems.close();
  });

  it("returns only the requested tail of historical events", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const workItem = workItems.createWorkItem({
      title: "Bounded history",
      mode: "auto",
      conversationId: "bounded-history",
      agentId: "pi",
      riskLevel: "read_only",
    });
    for (const message of ["first", "second", "third"]) {
      workItems.appendEvent({ workItemId: workItem.id, type: "MESSAGE_RECEIVED", actor: "user", payload: { message } });
    }
    const session = catalog.createSession({ agentId: "pi", taskRecordId: workItem.id });
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);

    const response = await app.request(`/v1/sessions/${session.id}/events?tail=2`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = await response.text();

    expect(body).not.toContain("first");
    expect(body).toContain("second");
    expect(body).toContain("third");
    catalog.close();
    workItems.close();
  });

  it("does not import appended provider messages during GET", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    let loads = 0;
    const initialHistory = [
      { kind: "message" as const, text: "初始问题" },
      { kind: "agent_event" as const, event: { type: "text_delta" as const, text: "初始回复" } },
    ];
    const runner = {
      loadSessionHistory: async () => {
        loads += 1;
        return loads === 1
          ? initialHistory
          : [
              ...initialHistory,
              { kind: "message" as const, text: "后来追加的问题" },
              { kind: "agent_event" as const, event: { type: "text_delta" as const, text: "后来追加的回复" } },
            ];
      },
    } as unknown as RunnerClient;
    const session = catalog.createSession({
      agentId: "codex",
      providerSessionId: "provider-growing-history",
      cwd: "/tmp/project",
    });
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);
    const headers = { authorization: `Bearer ${TOKEN}` };

    await app.request(`/v1/sessions/${session.id}`, { headers });
    await app.request(`/v1/sessions/${session.id}`, { headers });

    const taskId = catalog.getSession(session.id)?.taskRecordId;
    expect(loads).toBe(0);
    expect(taskId).toBeNull();
    catalog.close();
    workItems.close();
  });

  it("does not inspect partial provider history during GET", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    let loads = 0;
    const runner = {
      loadSessionHistory: async () => {
        loads += 1;
        return [{ kind: "message", text: "尚未完成的问题" }];
      },
    } as unknown as RunnerClient;
    const session = catalog.createSession({
      agentId: "claude",
      providerSessionId: "provider-partial-history",
      cwd: "/tmp/project",
    });
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);

    await app.request(`/v1/sessions/${session.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await app.request(`/v1/sessions/${session.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const taskId = catalog.getSession(session.id)?.taskRecordId;
    expect(taskId).toBeNull();
    expect(loads).toBe(0);
    catalog.close();
    workItems.close();
  });

  it("does not recheck legacy hydration markers during GET", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const task = workItems.createWorkItem({
      title: "Partial import",
      mode: "auto",
      conversationId: "conv-partial-import",
      agentId: "claude",
      riskLevel: "read_only",
    });
    workItems.appendEvent({
      workItemId: task.id,
      type: "MESSAGE_RECEIVED",
      actor: "user",
      payload: { message: "原始问题" },
    });
    workItems.appendEvent({
      workItemId: task.id,
      type: "SESSION_HISTORY_HYDRATED",
      actor: "system",
      payload: { providerSessionId: "provider-partial-history" },
    });
    let loads = 0;
    const runner = {
      loadSessionHistory: async () => {
        loads += 1;
        return [
          { kind: "message", text: "原始问题" },
          { kind: "agent_event", event: { type: "text_delta", text: "补齐的回复" } },
        ];
      },
    } as unknown as RunnerClient;
    const session = catalog.createSession({
      agentId: "claude",
      providerSessionId: "provider-partial-history",
      taskRecordId: task.id,
      cwd: "/tmp/project",
    });
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);

    await app.request(`/v1/sessions/${session.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(loads).toBe(0);
    expect(workItems.listEvents(task.id)).not.toContainEqual(expect.objectContaining({
      type: "AGENT_EVENT",
      payload: { event: { type: "text_delta", text: "补齐的回复" } },
    }));
    catalog.close();
    workItems.close();
  });

  it("does not repair an empty history binding during GET", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const task = workItems.createWorkItem({
      title: "Imported Session",
      mode: "auto",
      conversationId: "conv-imported",
      agentId: "claude",
      riskLevel: "read_only",
    });
    workItems.appendEvent({
      workItemId: task.id,
      type: "MESSAGE_RECEIVED",
      actor: "user",
      payload: { message: "当前消息" },
    });
    const runner = {
      loadSessionHistory: async () => [{ kind: "message", text: "原始问题" }],
    } as unknown as RunnerClient;
    const session = catalog.createSession({
      agentId: "claude",
      providerSessionId: "provider-empty-history",
      taskRecordId: task.id,
      cwd: "/tmp/project",
    });
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);

    await app.request(`/v1/sessions/${session.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(workItems.listEvents(task.id)).not.toContainEqual(expect.objectContaining({
      type: "MESSAGE_RECEIVED",
      payload: { message: "原始问题" },
    }));
    catalog.close();
    workItems.close();
  });

  it("does not add legacy hydration markers during GET", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const task = workItems.createWorkItem({
      title: "Imported Session",
      mode: "auto",
      conversationId: "conv-imported",
      agentId: "claude",
      riskLevel: "read_only",
    });
    workItems.appendEvent({
      workItemId: task.id,
      type: "MESSAGE_RECEIVED",
      actor: "user",
      payload: { message: "原始问题" },
    });
    const runner = {
      loadSessionHistory: async () => [
        { kind: "message", text: "原始问题" },
        { kind: "agent_event", event: { type: "text_delta", text: "原始回复" } },
      ],
    } as unknown as RunnerClient;
    const session = catalog.createSession({
      agentId: "claude",
      providerSessionId: "provider-legacy-history",
      taskRecordId: task.id,
      cwd: "/tmp/project",
    });
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);

    await app.request(`/v1/sessions/${session.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const events = workItems.listEvents(task.id);
    expect(events.filter((event) => event.type === "MESSAGE_RECEIVED")).toHaveLength(1);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "SESSION_HISTORY_HYDRATED" }),
    );
    catalog.close();
    workItems.close();
  });

  it("keeps an imported Session available when provider history cannot be loaded", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      loadSessionHistory: async () => {
        throw new Error("history unavailable");
      },
    } as unknown as RunnerClient;
    const session = catalog.createSession({
      agentId: "claude",
      providerSessionId: "provider-unavailable",
      cwd: "/tmp/project",
    });
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);

    const response = await app.request(`/v1/sessions/${session.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(
      (await response.json() as {
        session: { session_id: string };
      }).session.session_id,
    ).toBe(session.id);
    catalog.close();
    workItems.close();
  });

  it("creates a new Session from a provider-native fork", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      forkSession: async () => ({ ok: true, sessionId: "pi-forked", cwd: "/tmp/target" }),
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);
    const source = catalog.createSession({ agentId: "pi", cwd: "/tmp/source", providerSessionId: "pi-source" });

    const response = await app.request(`/v1/sessions/${source.id}/fork`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ target_cwd: "/tmp/target" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      agent_id: "pi",
      provider_session_id: "pi-forked",
      cwd: "/tmp/target",
      status: "idle",
    });
    expect(catalog.listSessions("pi")).toHaveLength(2);
    catalog.close();
    workItems.close();
  });

  it("authorizes and canonicalizes an optional Session workspace", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      authorizeDirectory: async (directory: string) => ({ ok: true, path: `/canonical${directory}` }),
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);

    const response = await app.request("/v1/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "pi", cwd: "/workspace" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ cwd: "/canonical/workspace" });
    catalog.close();
    workItems.close();
  });

  it("uses and authorizes the configured workspace when Session cwd is omitted", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      authorizeDirectory: async (directory: string) => ({ ok: true, path: `/canonical${directory}` }),
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner, defaultCwd: "/workspace" }, TOKEN);

    const response = await app.request("/v1/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "pi" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ cwd: "/canonical/workspace" });
    catalog.close();
    workItems.close();
  });

  it("repairs an existing Session without cwd from the configured workspace on first message", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const session = catalog.createSession({ agentId: "pi" });
    const app = createSessionApp({ catalog, agents, workItems, defaultCwd: "/workspace" }, TOKEN);

    const response = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "inspect" }),
    });

    expect(response.status).toBe(202);
    expect(catalog.getSession(session.id)?.cwd).toBe("/workspace");
    const taskId = catalog.getSession(session.id)?.taskRecordId;
    expect(taskId && workItems.getWorkItem(taskId)?.workspaceScope).toEqual(["/workspace"]);
    catalog.close();
    workItems.close();
  });

  it("rejects a Session workspace when Runner authorization fails", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      authorizeDirectory: async () => ({ ok: false, error: "permission denied" }),
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);

    const response = await app.request("/v1/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "pi", cwd: "/private" }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "workspace_not_authorized" });
    expect(catalog.listSessions("pi")).toHaveLength(0);
    catalog.close();
    workItems.close();
  });

  it("adds and removes authorized additional directories for a Session", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const authorized: string[] = [];
    const runner = {
      authorizeDirectory: async (directory: string) => {
        authorized.push(directory);
        return { ok: true, path: `/canonical${directory}` };
      },
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);
    const session = catalog.createSession({ agentId: "pi", cwd: "/workspace" });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

    const added = await app.request(`/v1/sessions/${session.id}/directories`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "/shared" }),
    });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({
      session_id: session.id,
      additional_directories: ["/canonical/shared"],
    });
    expect(authorized).toEqual(["/shared"]);

    const duplicate = await app.request(`/v1/sessions/${session.id}/directories`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "/shared" }),
    });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json() as { additional_directories: string[] }).additional_directories)
      .toEqual(["/canonical/shared"]);

    const removed = await app.request(`/v1/sessions/${session.id}/directories`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ path: "/canonical/shared" }),
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      session_id: session.id,
      additional_directories: [],
    });
    catalog.close();
    workItems.close();
  });

  it("picks an additional directory without accepting a path from the browser", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      pickDirectory: async () => ({ ok: true, path: "/canonical/shared" }),
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);
    const session = catalog.createSession({ agentId: "pi", cwd: "/workspace" });
    const response = await app.request(`/v1/sessions/${session.id}/directories/pick`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      session_id: session.id,
      additional_directories: ["/canonical/shared"],
    });
    catalog.close();
    workItems.close();
  });

  it("lists files only from the current Session workspaces", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const listDirectory = vi.fn().mockResolvedValue({
      ok: true,
      root: "/workspace",
      path: "/workspace/src",
      entries: [{ name: "index.ts", path: "src/index.ts", absolutePath: "/workspace/src/index.ts", kind: "file" }],
    });
    const runner = { listDirectory } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);
    const session = catalog.createSession({ agentId: "codex", cwd: "/workspace", additionalDirectories: ["/shared"] });

    const response = await app.request(`/v1/sessions/${session.id}/files?path=src`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ path: "/workspace/src" });
    expect(listDirectory).toHaveBeenCalledWith("/workspace", "src");

    const outside = await app.request(`/v1/sessions/${session.id}/files?root=${encodeURIComponent("/outside")}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outside.status).toBe(403);
    catalog.close();
    workItems.close();
  });

  it("returns live Agent config options for a Session", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      listConfigOptions: async () => ({
        options: [{ id: "model", name: "Model", type: "select", category: "model", values: [{ value: "model-1", name: "Model 1" }] }],
      }),
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner, defaultCwd: "/workspace" }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });
    const response = await app.request(`/v1/sessions/${session.id}/config-options`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ options: [{ id: "model" }] });
    catalog.close();
    workItems.close();
  });

  it("refreshes config options after a completed request", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    let calls = 0;
    const runner = {
      listConfigOptions: async () => {
        calls += 1;
        return { options: [{ id: "model", name: "Model", type: "select", category: "model", values: [] }] };
      },
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner, defaultCwd: "/workspace" }, TOKEN);
    const first = catalog.createSession({ agentId: "pi" });
    const second = catalog.createSession({ agentId: "pi" });
    for (const session of [first, second]) {
      const response = await app.request(`/v1/sessions/${session.id}/config-options`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(200);
    }
    expect(calls).toBe(2);
    catalog.close();
    workItems.close();
  });

  it("merges native and session-advertised Agent commands", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      listCommands: async () => ({ commands: [{ name: "skill:review", description: "Review" }] }),
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner, defaultCwd: "/workspace" }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });
    const message = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    const taskId = (await message.json() as { task_record_id: string }).task_record_id;
    workItems.appendEvent({
      workItemId: taskId,
      type: "AGENT_EVENT",
      actor: "adapter",
      payload: { event: { type: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact context" }] } },
    });

    const response = await app.request(`/v1/sessions/${session.id}/commands`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      commands: [
        { name: "skill:review", description: "Review" },
        { name: "compact", description: "Compact context" },
      ],
    });
    catalog.close();
    workItems.close();
  });

  it("keeps the command menu available when Runner command discovery fails", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const runner = {
      listCommands: async () => { throw new Error("Runner command endpoint unavailable"); },
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner, defaultCwd: "/workspace" }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });
    const message = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    const taskId = (await message.json() as { task_record_id: string }).task_record_id;
    workItems.appendEvent({
      workItemId: taskId,
      type: "AGENT_EVENT",
      actor: "adapter",
      payload: {
        event: {
          type: "available_commands_update",
          availableCommands: [{ name: "compact", description: "Compact context" }],
        },
      },
    });

    const response = await app.request(`/v1/sessions/${session.id}/commands`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      commands: [{ name: "compact", description: "Compact context" }],
      error: "Runner command endpoint unavailable",
    });
    catalog.close();
    workItems.close();
  });

  it("does not mutate additional directories when authorization is unavailable", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });
    const response = await app.request(`/v1/sessions/${session.id}/directories`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ path: "/shared" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "runner_unavailable" });
    expect(catalog.getSession(session.id)?.additionalDirectories).toEqual([]);
    catalog.close();
    workItems.close();
  });

  it("starts project discovery asynchronously on the first message in a workspace Session", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    let observed: { workspacePath: string; workItemId?: string } | undefined;
    const discovery = {
      observe: async (workspacePath: string, workItemId?: string) => {
        observed = { workspacePath, workItemId };
        return {};
      },
    } as unknown as import("@codebridge/project-catalog").ProjectDiscovery;
    const app = createSessionApp({ catalog, agents, workItems, discovery }, TOKEN);
    const session = catalog.createSession({ agentId: "pi", cwd: "/workspace" });

    const response = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "检查当前目录" }),
    });
    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed).toMatchObject({ workspacePath: "/workspace" });
    expect(observed?.workItemId).toMatch(/^wi_/);
    catalog.close();
    workItems.close();
  });

  it("deletes provider history before removing Session metadata", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const deleted: string[] = [];
    const runner = {
      deleteSession: async (agentId: string, cwd: string, providerSessionId: string) => {
        deleted.push(agentId, cwd, providerSessionId);
        return { ok: true };
      },
    } as unknown as RunnerClient;
    const app = createSessionApp({ catalog, agents, workItems, runner }, TOKEN);
    const session = catalog.createSession({ agentId: "pi", cwd: "/workspace", providerSessionId: "pi-session" });

    const response = await app.request(`/v1/sessions/${session.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(204);
    expect(deleted).toEqual(["pi", "/workspace", "pi-session"]);
    expect(catalog.getSession(session.id)).toBeUndefined();
    catalog.close();
    workItems.close();
  });

  it("resumes the Session event stream from Last-Event-ID", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });
    const message = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "事件恢复" }),
    });
    const taskId = (await message.json() as { task_record_id: string }).task_record_id;
    workItems.appendEvent({ workItemId: taskId, type: "AGENT_EVENT", actor: "agent", payload: { text: "继续" } });
    const response = await app.request(`/v1/sessions/${session.id}/events`, {
      headers: { authorization: `Bearer ${TOKEN}`, "Last-Event-ID": "1" },
    });
    expect(await response.text()).toContain("AGENT_EVENT");
    catalog.close();
    workItems.close();
  });

  it("keeps an opt-in Session SSE stream open for later events", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });
    const message = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "持续事件" }),
    });
    const taskId = (await message.json() as { task_record_id: string }).task_record_id;
    const response = await app.request(`/v1/sessions/${session.id}/events?after_sequence=2&live=true`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const reader = response.body!.getReader();
    workItems.appendEvent({
      workItemId: taskId,
      type: "AGENT_EVENT",
      actor: "agent",
      payload: { text: "later" },
    });
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timeout")), 2_000)),
    ]);
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("AGENT_EVENT");
    workItems.appendEvent({ workItemId: taskId, type: "VERIFICATION_COMPLETED", actor: "system" });
    const second = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timeout")), 2_000)),
    ]);
    expect(second.done).toBe(false);
    expect(new TextDecoder().decode(second.value)).toContain("VERIFICATION_COMPLETED");
    await reader.cancel();
    catalog.close();
    workItems.close();
  });

  it("keeps a new Session live stream open until its first message creates a work item", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });
    const response = await app.request(`/v1/sessions/${session.id}/events?after_sequence=0&live=true`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const reader = response.body!.getReader();
    const message = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "首条实时消息" }),
    });
    expect(message.status).toBe(202);
    let received = "";
    for (let attempt = 0; attempt < 8 && !received.includes("MESSAGE_RECEIVED"); attempt += 1) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timeout")), 2_000)),
      ]);
      expect(chunk.done).toBe(false);
      received += new TextDecoder().decode(chunk.value);
    }
    expect(received).toContain("MESSAGE_RECEIVED");
    await reader.cancel();
    catalog.close();
    workItems.close();
  });

  it("makes Session creation, messages and Runs idempotent", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const createInit = {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "Idempotency-Key": "session-1" },
      body: JSON.stringify({ agent_id: "pi" }),
    };
    const firstCreate = await app.request("/v1/sessions", createInit);
    const secondCreate = await app.request("/v1/sessions", createInit);
    const session = await firstCreate.json() as { session_id: string };
    expect((await secondCreate.json() as { session_id: string }).session_id).toBe(session.session_id);
    const messageInit = {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "Idempotency-Key": "message-1" },
      body: JSON.stringify({ message: "同一个消息" }),
    };
    const firstMessage = await app.request(`/v1/sessions/${session.session_id}/messages`, messageInit);
    const secondMessage = await app.request(`/v1/sessions/${session.session_id}/messages`, messageInit);
    const firstMessageBody = await firstMessage.json() as { task_record_id: string };
    expect(await secondMessage.json()).toEqual(firstMessageBody);
    const runInit = {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "Idempotency-Key": "run-1" },
      body: JSON.stringify({}),
    };
    const firstRun = await app.request(`/v1/sessions/${session.session_id}/runs`, runInit);
    const secondRun = await app.request(`/v1/sessions/${session.session_id}/runs`, runInit);
    expect(await secondRun.json()).toEqual(await firstRun.json());
    expect(workItems.listRuns(firstMessageBody.task_record_id)).toHaveLength(1);
    catalog.close();
    workItems.close();
  });

  it("lists Runs for a Session as a stable status projection", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "检查状态" }),
    });
    const created = await app.request(`/v1/sessions/${session.id}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    const runId = (await created.json() as { run_id: string }).run_id;

    const response = await app.request(`/v1/sessions/${session.id}/runs`, { headers });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runs: [{ run_id: runId, session_id: session.id, status: "queued", agent_id: "pi" }],
    });
    catalog.close();
    workItems.close();
  });

  it("stores Session message attachments and returns reference metadata", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const app = createSessionApp({ catalog, agents, workItems }, TOKEN);
    const session = catalog.createSession({ agentId: "pi" });
    const response = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: "请读取这个上下文",
        attachments: [{ name: "context.txt", mime_type: "text/plain", data_base64: Buffer.from("hello").toString("base64") }],
      }),
    });
    expect(response.status).toBe(202);
    const body = await response.json() as { attachment_ids: string[]; task_record_id: string };
    expect(body.attachment_ids).toHaveLength(1);
    expect(workItems.listEvents(body.task_record_id).at(-1)?.payload).toMatchObject({ attachment_ids: body.attachment_ids });

    const detail = await app.request(`/v1/attachments/${body.attachment_ids[0]}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ name: "context.txt", mime_type: "text/plain", content_hash: expect.stringMatching(/^sha256:/) });
    catalog.close();
    workItems.close();
  });

  it("compiles the selected Workflow revision into a persisted Run Plan", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const workItems = new SqliteEventStore(":memory:");
    const flows = new FlowCatalogStore(":memory:");
    const capabilities = new CapabilityRegistry();
    flows.save({
      flowId: "review-change",
      name: "Review change",
      kind: "runbook",
      status: "published",
      source: "git",
      definitionRevision: "git:abc123",
      reviewStatus: "approved",
      gitRevision: "abc123",
      steps: [
        { id: "inspect", capability: "context.inspect", mode: "read_only" },
        {
          id: "change",
          capability: "workspace.change",
          mode: "workspace_write",
          dependsOn: ["inspect"],
        },
      ],
    });
    const app = createSessionApp({ catalog, agents, workItems, flows, capabilities }, TOKEN);
    const session = catalog.createSession({ agentId: "pi", cwd: "/workspace" });
    const message = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "检查后修改", flow_id: "review-change" }),
    });
    const taskId = (await message.json() as { task_record_id: string }).task_record_id;

    const response = await app.request(`/v1/sessions/${session.id}/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ flow_id: "review-change" }),
    });

    expect(response.status).toBe(202);
    const body = await response.json() as { run_id: string; plan_id: string; workflow_revision: string };
    const run = workItems.getRun(body.run_id)!;
    expect(body).toMatchObject({ plan_id: run.planId, workflow_revision: "git:abc123" });
    expect(workItems.getWorkItem(taskId)).toMatchObject({
      workflowId: "review-change",
      workflowRevision: "git:abc123",
    });
    expect(workItems.getPlanForRun(run.id)).toMatchObject({
      planId: run.planId,
      workflowId: "review-change",
      definitionRevision: "git:abc123",
      sessionId: session.id,
      steps: [
        { id: "inspect", capabilityId: "context.inspect" },
        { id: "change", capabilityId: "workspace.change", dependsOn: ["inspect"] },
      ],
    });
    expect(workItems.listEvents(taskId).map((event) => event.type)).toContain("PLAN_VALIDATED");
    expect(capabilities.get("context.inspect")).toMatchObject({ adapter: "agent", risk: "read_only" });
    expect(capabilities.get("workspace.change")).toMatchObject({ adapter: "agent", risk: "workspace_write" });
    capabilities.close();
    flows.close();
    catalog.close();
    workItems.close();
  });
});
