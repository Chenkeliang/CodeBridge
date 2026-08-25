import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FLOW_SAVE_NO_SOURCE_MESSAGE,
  FLOW_SAVE_TOOL_MARKER,
  FLOW_SAVE_TOOL_NAME,
  PI_FLOW_SAVE_TOOL_NAME,
  type AgentEvent,
  type RunRequest,
} from "@codebridge/core";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import {
  SessionCoordinator,
  SessionLeaseService,
} from "@codebridge/session-coordinator";
import { RunExecutor } from "@codebridge/run-executor";
import { SqliteEventStore, type Run } from "@codebridge/work-items";
import { FlowSaveIntentService } from "./flow-save-intent.js";
import {
  createFlowSaveToolEventHandler,
  FlowSaveToolTranslator,
} from "./flow-save-tool-translator.js";

interface Fixture {
  sessions: SessionCatalogStore;
  events: SqliteEventStore;
  catalog: FlowCatalogStore;
  service: FlowSaveIntentService;
  translator: FlowSaveToolTranslator;
  sessionId: string;
  workItemId: string;
}

const openFixtures: Fixture[] = [];

afterEach(() => {
  for (const fixture of openFixtures.splice(0)) {
    fixture.catalog.close();
    fixture.events.close();
    fixture.sessions.close();
  }
  vi.restoreAllMocks();
});

function fixture(): Fixture {
  const sessions = new SessionCatalogStore(":memory:");
  const events = new SqliteEventStore(":memory:");
  const catalog = new FlowCatalogStore(":memory:");
  const sessionId = "sess_tool_translate";
  const workItemId = "wi_tool_translate";
  sessions.createSession({ id: sessionId, agentId: "codex", taskRecordId: workItemId });
  events.createWorkItem({
    id: workItemId,
    title: "Flow save tool translation",
    mode: "auto",
    conversationId: `conv_${sessionId}`,
    sessionId,
    agentId: "codex",
    riskLevel: "read_only",
  });
  events.withSessionTransaction((transaction) => transaction.ensureRuntime(sessionId));
  const service = new FlowSaveIntentService({ sessions, events, catalog });
  const translator = new FlowSaveToolTranslator({ intents: service });
  const value = {
    sessions,
    events,
    catalog,
    service,
    translator,
    sessionId,
    workItemId,
  };
  openFixtures.push(value);
  return value;
}

function seedRun(
  target: Fixture,
  input: {
    id: string;
    status?: "queued" | "running" | "succeeded";
    tools?: string[];
    text?: string;
  },
): Run {
  let runId = input.id;
  target.events.withSessionTransaction((transaction) => {
    const turn = transaction.insertTurn(target.sessionId, {
      text: input.text ?? `业务任务 ${input.id}`,
      attachmentIds: [],
      flowId: null,
      executionKind: "agent",
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    });
    runId = transaction.dispatchTurn(turn.turnId, {
      id: input.id,
      workItemId: target.workItemId,
      sessionId: target.sessionId,
      turnId: turn.turnId,
      agentId: "codex",
      mode: "auto",
      executionKind: "agent",
      planId: null,
      planIrHash: null,
      workflowRevision: null,
    }).run.id;
  });
  for (const [index, name] of (input.tools ?? []).entries()) {
    persistAgentEvent(target, runId, {
      type: "tool_start",
      toolCallId: `${runId}_business_${index}`,
      name,
    });
  }
  const status = input.status ?? "running";
  if (status !== "queued") target.events.updateRunStatus(runId, status);
  if (status === "succeeded") {
    target.events.appendEvent({
      workItemId: target.workItemId,
      runId,
      type: "RUN_SUCCEEDED",
      actor: "system",
      target: runId,
    });
  }
  return target.events.getRun(runId)!;
}

function persistAgentEvent(target: Fixture, runId: string, event: AgentEvent): void {
  target.events.appendEvent({
    workItemId: target.workItemId,
    runId,
    type: "AGENT_EVENT",
    actor: "adapter",
    target: event.type,
    payload: { event },
  });
}

function startEvent(
  toolCallId = "tool_save",
  input: unknown = { source_scope: "previous_completed_run" },
  name: string = PI_FLOW_SAVE_TOOL_NAME,
): AgentEvent {
  return {
    type: "tool_start",
    toolCallId,
    name,
    input,
  };
}

function endEvent(
  overrides: Partial<Extract<AgentEvent, { type: "tool_end" }>> = {},
): Extract<AgentEvent, { type: "tool_end" }> {
  return {
    type: "tool_end",
    toolCallId: "tool_save",
    status: "completed",
    output: {
      codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
      accepted: true,
      source_scope: "previous_completed_run",
    },
    ...overrides,
  };
}

function translatePersisted(
  target: Fixture,
  run: Run,
  event: AgentEvent,
) {
  persistAgentEvent(target, run.id, event);
  return target.translator.translate(run, event);
}

function requests(target: Fixture) {
  return target.events.listEvents(target.workItemId)
    .filter((event) => event.type === "FLOW_SAVE_REQUESTED");
}

describe("FlowSaveToolTranslator", () => {
  it("ignores tool starts, failed completions, non-marker outputs, and rejected results", () => {
    const target = fixture();
    seedRun(target, {
      id: "run_source",
      status: "succeeded",
      tools: ["Read File", "Search"],
    });
    const current = seedRun(target, { id: "run_current" });

    expect(translatePersisted(target, current, startEvent())).toBeNull();
    expect(translatePersisted(target, current, endEvent({ status: "failed" }))).toBeNull();
    expect(translatePersisted(target, current, endEvent({ output: { ok: true } }))).toBeNull();
    expect(translatePersisted(target, current, endEvent({
      output: {
        codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
        accepted: false,
        source_scope: "previous_completed_run",
        code: "no_extractable_previous_run",
        message: FLOW_SAVE_NO_SOURCE_MESSAGE,
      },
    }))).toBeNull();

    expect(requests(target)).toHaveLength(0);
  });

  it("surfaces a missing persisted start to the Bridge error boundary", () => {
    const target = fixture();
    seedRun(target, {
      id: "run_source",
      status: "succeeded",
      tools: ["Read File", "Search"],
    });
    const current = seedRun(target, { id: "run_current" });

    expect(() => translatePersisted(target, current, endEvent())).toThrowError(
      expect.objectContaining({ code: "flow_save_tool_call_not_found" }),
    );
    expect(requests(target)).toHaveLength(0);
  });

  it("rejects arbitrary source Run ids through the service strict input contract", () => {
    const target = fixture();
    seedRun(target, {
      id: "run_source",
      status: "succeeded",
      tools: ["Read File", "Search"],
    });
    const current = seedRun(target, { id: "run_current" });
    translatePersisted(target, current, startEvent("tool_save", {
      source_scope: "previous_completed_run",
      run_id: "run_attacker_selected",
    }));

    expect(() => translatePersisted(target, current, endEvent())).toThrowError(
      expect.objectContaining({ code: "flow_save_tool_call_not_found" }),
    );
    expect(requests(target)).toHaveLength(0);
  });

  it("creates one request from a strict accepted result without trusting adapter titles", () => {
    const target = fixture();
    seedRun(target, {
      id: "run_source",
      status: "succeeded",
      tools: ["Read File", "Search"],
    });
    const current = seedRun(target, { id: "run_current", text: "把刚才任务存为 Flow" });
    translatePersisted(target, current, startEvent());
    const completion = endEvent({
      name: "unrelated provider display title",
      output: { opaque: true },
      content: [{
        type: "text",
        text: JSON.stringify({
          codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
          accepted: true,
          source_scope: "previous_completed_run",
        }),
      }],
    });

    const created = translatePersisted(target, current, completion);

    expect(created).toMatchObject({
      requestRunId: current.id,
      sourceRunId: "run_source",
      source: "agent_intent",
    });
    expect(requests(target)).toHaveLength(1);
  });

  it("creates one request from the canonical ACP result wrapper", () => {
    const target = fixture();
    seedRun(target, {
      id: "run_source",
      status: "succeeded",
      tools: ["Read File", "Search"],
    });
    const current = seedRun(target, { id: "run_current", text: "把刚才任务存为 Flow" });
    translatePersisted(target, current, startEvent("tool_save", {
      server: "codebridge-internal",
      tool: FLOW_SAVE_TOOL_NAME,
      arguments: {
        source_scope: "previous_completed_run",
        name_hint: "只读核对 Flow",
        intent_summary: "复用上一轮已完成的只读核对步骤",
      },
    }, "arbitrary ACP display title"));
    const marker = {
      codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
      accepted: true,
      source_scope: "previous_completed_run",
    };

    const completion = endEvent({
      name: "mcp.codebridge-internal.codebridge.request_flow_save",
      output: {
        result: { content: [{ type: "text", text: JSON.stringify(marker) }] },
      },
    });
    const created = translatePersisted(target, current, completion);
    const replay = translatePersisted(target, current, completion);

    expect(created).toMatchObject({
      requestRunId: current.id,
      sourceRunId: "run_source",
      source: "agent_intent",
      nameHint: "只读核对 Flow",
      intentSummary: "复用上一轮已完成的只读核对步骤",
    });
    expect(replay?.requestId).toBe(created?.requestId);
    expect(requests(target)).toHaveLength(1);
    expect(requests(target)[0]).toMatchObject({
      runId: current.id,
      type: "FLOW_SAVE_REQUESTED",
      payload: {
        request_run_id: current.id,
        source_run_id: "run_source",
        source: "agent_intent",
        name_hint: "只读核对 Flow",
        intent_summary: "复用上一轮已完成的只读核对步骤",
      },
    });
  });

  it("accepts an exact ACP envelope even when its display title equals the Pi wire name", () => {
    const target = fixture();
    seedRun(target, {
      id: "run_source",
      status: "succeeded",
      tools: ["Read File", "Search"],
    });
    const current = seedRun(target, { id: "run_current" });
    translatePersisted(target, current, startEvent("tool_save", {
      server: "codebridge-internal",
      tool: FLOW_SAVE_TOOL_NAME,
      arguments: { source_scope: "previous_completed_run" },
    }, PI_FLOW_SAVE_TOOL_NAME));

    expect(translatePersisted(target, current, endEvent())).toMatchObject({
      requestRunId: current.id,
      sourceRunId: "run_source",
      source: "agent_intent",
    });
    expect(requests(target)).toHaveLength(1);
  });

  it.each([
    ["top-level extra", {
      server: "codebridge-internal",
      tool: FLOW_SAVE_TOOL_NAME,
      arguments: { source_scope: "previous_completed_run" },
      extra: true,
    }],
    ["wrong server", {
      server: "untrusted-server",
      tool: FLOW_SAVE_TOOL_NAME,
      arguments: { source_scope: "previous_completed_run" },
    }],
    ["wrong tool", {
      server: "codebridge-internal",
      tool: "vendor.request_flow_save",
      arguments: { source_scope: "previous_completed_run" },
    }],
    ["nested extra", {
      server: "codebridge-internal",
      tool: FLOW_SAVE_TOOL_NAME,
      arguments: { source_scope: "previous_completed_run", run_id: "run_source" },
    }],
    ["non-object arguments", {
      server: "codebridge-internal",
      tool: FLOW_SAVE_TOOL_NAME,
      arguments: "previous_completed_run",
    }],
    ["arbitrary arguments wrapper", {
      arguments: { source_scope: "previous_completed_run" },
    }],
  ])("rejects the invalid ACP start envelope: %s", (_label, toolInput) => {
    const target = fixture();
    seedRun(target, {
      id: "run_source",
      status: "succeeded",
      tools: ["Read File", "Search"],
    });
    const current = seedRun(target, { id: "run_current" });
    translatePersisted(target, current, startEvent(
      "tool_save",
      toolInput,
      "arbitrary ACP display title",
    ));

    expect(() => translatePersisted(target, current, endEvent())).toThrowError(
      expect.objectContaining({ code: "flow_save_tool_call_not_found" }),
    );
    expect(requests(target)).toHaveLength(0);
  });

  it.each([
    ["marker-only third-party tool", "vendor.marker_only"],
    ["ordinary MCP tool", "mcp.vendor.lookup"],
  ])("rejects accepted Flow-save marker output from %s", (_label, name) => {
    const target = fixture();
    seedRun(target, {
      id: "run_source",
      status: "succeeded",
      tools: ["Read File", "Search"],
    });
    const current = seedRun(target, { id: "run_current" });
    translatePersisted(target, current, startEvent(
      "tool_save",
      { source_scope: "previous_completed_run" },
      name,
    ));
    const completion = endEvent({ name });
    persistAgentEvent(target, current.id, completion);
    const warn = vi.fn();
    const handle = createFlowSaveToolEventHandler(target.translator, warn);

    expect(handle(current, completion)).toBeNull();
    expect(requests(target)).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("flow_save_tool_call_not_found"));
  });

  it("does not translate a marker beyond the canonical result wrapper depth limit", () => {
    const target = fixture();
    seedRun(target, {
      id: "run_source",
      status: "succeeded",
      tools: ["Read File", "Search"],
    });
    const current = seedRun(target, { id: "run_current" });
    translatePersisted(target, current, startEvent());
    let payload: unknown = {
      codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
      accepted: true,
      source_scope: "previous_completed_run",
    };
    for (let depth = 0; depth < 8; depth += 1) payload = { result: payload };

    expect(translatePersisted(target, current, endEvent({ output: payload }))).toBeNull();
    expect(requests(target)).toHaveLength(0);
  });

  it("returns the same request when a Provider completion is replayed", () => {
    const target = fixture();
    seedRun(target, {
      id: "run_source",
      status: "succeeded",
      tools: ["Read File", "Search"],
    });
    const current = seedRun(target, { id: "run_current" });
    translatePersisted(target, current, startEvent());
    const completion = endEvent();
    const first = translatePersisted(target, current, completion);
    const replay = translatePersisted(target, current, completion);

    expect(replay?.requestId).toBe(first?.requestId);
    expect(requests(target)).toHaveLength(1);
  });

  it("never selects the request Run itself when no prior extractable Run exists", () => {
    const target = fixture();
    const current = seedRun(target, {
      id: "run_current",
      tools: ["Read File", "Search"],
    });
    translatePersisted(target, current, startEvent());

    expect(() => translatePersisted(target, current, endEvent())).toThrowError(
      expect.objectContaining({ code: "no_extractable_previous_run" }),
    );
    expect(requests(target)).toHaveLength(0);
  });

  it("logs domain correlation failures once at the shared Bridge event boundary", () => {
    const target = fixture();
    seedRun(target, {
      id: "run_source",
      status: "succeeded",
      tools: ["Read File", "Search"],
    });
    const current = seedRun(target, { id: "run_current" });
    const warn = vi.fn();
    const handle = createFlowSaveToolEventHandler(target.translator, warn);
    const completion = endEvent();
    persistAgentEvent(target, current.id, completion);

    expect(handle(current, completion)).toBeNull();
    expect(requests(target)).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("flow_save_tool_call_not_found"));
  });

  it("contains translator infrastructure failures so the Agent Run still succeeds", async () => {
    const events = new SqliteEventStore(":memory:");
    const coordinator = new SessionCoordinator(events, { maxQueuedTurns: 10 });
    const submitted = coordinator.submitTurn({
      sessionId: "sess_resilient",
      idempotencyKey: "message_1",
      message: {
        text: "存为 Flow",
        attachmentIds: [],
        flowId: null,
        executionKind: "agent",
        model: null,
        effort: null,
        permissionMode: null,
        plan: null,
      },
      workItem: {
        title: "Translator resilience",
        mode: "auto",
        conversationId: "conv_sess_resilient",
        agentId: "codex",
        workspaceScope: ["/workspace"],
        riskLevel: "read_only",
      },
    });
    const warn = vi.fn();
    const translator = new FlowSaveToolTranslator({
      intents: {
        requestFromTool: () => {
          throw new Error("catalog temporarily unavailable");
        },
      },
    });
    const handle = createFlowSaveToolEventHandler(translator, warn);
    const stream = new (class {
      async *run(_request: RunRequest): AsyncGenerator<AgentEvent> {
        yield startEvent();
        yield endEvent();
        yield { type: "done", exitCode: 0 };
      }
    })();
    const executor = new RunExecutor(events, stream, {
      sessionCoordinator: coordinator,
      sessionLeaseService: new SessionLeaseService(events),
      executorOwner: "test:translator",
      resolveRequest: (workItem, run) => ({
        runId: run.id,
        sessionKey: {
          chatId: workItem.conversationId,
          backendId: "codex",
          cwd: "/workspace",
        },
        prompt: workItem.title,
      }),
      onEvent: (run, event) => {
        handle(run, event);
      },
    });

    await executor.execute(submitted.run!.id);

    expect(events.getRun(submitted.run!.id)?.status).toBe("succeeded");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("catalog temporarily unavailable"));
    events.close();
  });
});
