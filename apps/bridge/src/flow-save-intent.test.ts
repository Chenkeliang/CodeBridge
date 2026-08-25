import { afterEach, describe, expect, it, vi } from "vitest";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SqliteEventStore, type DomainEvent, type Run } from "@codebridge/work-items";
import { definitionHash } from "@codebridge/workflow-engine";
import { compileCatalogFlow } from "./flow-compile.js";
import {
  candidateFlowId,
  extractRunDefinition,
  FlowSaveIntentService,
  type ExtractRunDefinitionInput,
} from "./flow-save-intent.js";

function run(overrides: Partial<Run> = {}): Run {
  return {
    schemaVersion: 1,
    id: "run_source",
    workItemId: "work_source",
    sessionId: "sess_source",
    turnId: "turn_source",
    mode: "auto",
    status: "succeeded",
    executionKind: "agent",
    agentId: "codex",
    planId: null,
    planIrHash: null,
    workflowRevision: null,
    terminalReason: null,
    replaySafety: "safe",
    leaseOwner: null,
    leaseExpiresAt: null,
    cancelRequestedAt: null,
    cancelDeadlineAt: null,
    createdAt: "2026-08-25T08:00:00.000Z",
    updatedAt: "2026-08-25T08:01:00.000Z",
    ...overrides,
  };
}

function event(
  sequence: number,
  type: DomainEvent["type"],
  payload: Record<string, unknown>,
): DomainEvent {
  return {
    schemaVersion: 1,
    eventId: `evt_${sequence}`,
    sequence,
    workItemId: "work_source",
    runId: "run_source",
    executionKind: "agent",
    type,
    occurredAt: `2026-08-25T08:00:${String(sequence).padStart(2, "0")}.000Z`,
    actor: "agent",
    target: null,
    inputHash: null,
    resultRef: null,
    payload,
  };
}

function input(
  events: DomainEvent[],
  overrides: Partial<ExtractRunDefinitionInput> = {},
): ExtractRunDefinitionInput {
  return {
    session: { id: "sess_source", agentId: "codex" },
    run: run(),
    title: "核对订单 6928674077056597072 https://internal.example/orders/1",
    events,
    ...overrides,
  };
}

describe("extractRunDefinition", () => {
  it("extracts the last valid structured plan without recommendation flags", () => {
    const result = extractRunDefinition(input([
      event(1, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "tool_1",
        name: "Read File",
      } }),
      event(2, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "tool_2",
        name: "Search",
      } }),
      event(3, "FLOW_PROPOSED", {
        definition_revision: "agent:source",
        flow: {
          workflow_id: "flow_ephemeral_run_source",
          name: "仓配复核 6928674077056597072",
          steps: [
            { id: "inspect", purpose: "读取 /Users/demo/private/order.json" },
            { id: "verify", purpose: "核对 https://internal.example/orders/6928674077056597072", depends_on: ["inspect"] },
          ],
        },
      }),
    ]));

    expect(result).toMatchObject({
      ok: true,
      kind: "structured_plan",
      steps: [
        { id: "step_1", dependsOn: [] },
        { id: "step_2", dependsOn: ["step_1"] },
      ],
      provenance: { sourceRunId: "run_source" },
    });
    expect(result).not.toHaveProperty("saveable");
    expect(result).not.toHaveProperty("recommended");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("6928674077056597072");
    expect(serialized).not.toContain("internal.example");
    expect(serialized).not.toContain("/Users/demo");
  });

  it("fails closed for positional ACP arguments and redacts UUIDv7 and tilde home paths", () => {
    const uuid = "01944f05-2d18-7935-8296-773caa8165fc";
    const secret = "alice_secret";
    const result = extractRunDefinition(input([
      event(1, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "tool_1",
        name: `lookup ${secret}`,
        input: { user: secret, session_id: uuid, path: "~/private/orders.json" },
      } }),
      event(2, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "tool_2",
        name: "Read File",
      } }),
    ], {
      title: `复核任务 ${uuid} ~/private/orders.json`,
    }));

    expect(result).toMatchObject({
      ok: true,
      kind: "observed_trace",
    });
    if (!result.ok) throw new Error("expected extractable ACP trace");
    expect(result.steps).toMatchObject([
      { purpose: "执行受控工具步骤" },
      { purpose: "使用 Read File" },
    ]);
    const presentation = JSON.stringify({
      name: result.name,
      description: result.description,
      steps: result.steps,
      warnings: result.warnings,
      provenance: result.provenance,
    });
    expect(presentation).not.toContain(secret);
    expect(presentation).not.toContain(uuid);
    expect(presentation).not.toContain("~/private");
  });

  it("fails closed for flagged ACP arguments without leaking their values", () => {
    const uuid = "83944f05-2d18-4935-8296-773caa8165fc";
    const secret = "alice_secret";
    const result = extractRunDefinition(input([
      event(1, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "tool_1",
        name: `lookup --user ${secret}`,
      } }),
      event(2, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "tool_2",
        name: "Read File",
      } }),
    ], {
      title: `复核任务 ${uuid} ~/private/orders.json`,
    }));

    expect(result).toMatchObject({ ok: true, kind: "observed_trace" });
    if (!result.ok) throw new Error("expected extractable ACP trace");
    expect(result.steps[0]).toMatchObject({ purpose: "执行受控工具步骤" });
    const presentation = JSON.stringify(result);
    expect(presentation).not.toContain(secret);
    expect(presentation).not.toContain(uuid);
    expect(presentation).not.toContain("~/private");
    expect(presentation).not.toContain("--user");
  });

  it("extracts an observed trace from two meaningful tools without raw arguments", () => {
    const result = extractRunDefinition(input([
      event(1, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "tool_1",
        name: "python3 /Users/demo/.agents/skills/meepo/scripts/meepo.py task-info --order-sn 6928674077056597072",
        input: { order_sn: "6928674077056597072", endpoint: "https://internal.example" },
      } }),
      event(2, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "tool_2",
        name: "Read File",
        input: { path: "/Users/demo/private/result.json" },
      } }),
    ]));

    expect(result).toMatchObject({ ok: true, kind: "observed_trace" });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("meepo");
    expect(serialized).not.toContain("6928674077056597072");
    expect(serialized).not.toContain("internal.example");
    expect(serialized).not.toContain("/Users/demo");
    expect(serialized).not.toContain("order_sn");
  });

  it("excludes correlated Flow save markers in object, JSON, and Pi content outputs regardless of status", () => {
    const marker = {
      codebridge_internal_tool: "flow_save_request/v1",
      accepted: true,
    };
    expect(extractRunDefinition(input([
      event(1, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "business_1",
        name: "Read File",
      } }),
      event(2, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "save_1",
        name: "vendor.opaque_command",
      } }),
      event(3, "AGENT_EVENT", { event: {
        type: "tool_end",
        toolCallId: "save_1",
        status: "failed",
        output: marker,
      } }),
      event(4, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "save_2",
        name: "vendor.json_result",
      } }),
      event(5, "AGENT_EVENT", { event: {
        type: "tool_end",
        toolCallId: "save_2",
        status: "completed",
        output: JSON.stringify(marker),
      } }),
      event(6, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "save_3",
        name: "vendor.pi_content",
      } }),
      event(7, "AGENT_EVENT", { event: {
        type: "tool_end",
        toolCallId: "save_3",
        status: "cancelled",
        output: { content: [{ type: "text", text: JSON.stringify(marker) }] },
      } }),
      event(8, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "save_4",
        name: "vendor.acp_content",
      } }),
      event(9, "AGENT_EVENT", { event: {
        type: "tool_end",
        toolCallId: "save_4",
        status: "completed",
        content: [{ type: "text", text: JSON.stringify(marker) }],
      } }),
    ]))).toEqual({
      ok: false,
      code: "run_not_extractable",
      reason: expect.any(String),
    });
  });

  it("does not expose identifier-shaped single-token tool names", () => {
    const sensitive = [
      "lookup_6928674077056597072",
      "01944f05-2d18-7935-8296-773caa8165fc",
      "13800138000",
    ];
    const result = extractRunDefinition(input(sensitive.map((name, index) =>
      event(index + 1, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: `tool_${index + 1}`,
        name,
      } })
    )));

    expect(result).toMatchObject({
      ok: false,
      code: "run_not_extractable",
    });
    const serialized = JSON.stringify(result);
    sensitive.forEach((value) => expect(serialized).not.toContain(value));
  });

  it("ignores interleaved events from another Run or work item", () => {
    const foreignStructured = {
      ...event(3, "FLOW_PROPOSED", {
        definition_revision: "agent:foreign",
        flow: {
          workflow_id: "flow_ephemeral_foreign",
          name: "污染计划",
          steps: [{ id: "foreign", purpose: "不应进入结果" }],
        },
      }),
      runId: "run_foreign",
    };
    const wrongWorkItem = {
      ...event(4, "RUN_SUCCEEDED", { imported: true }),
      workItemId: "work_foreign",
    };
    const result = extractRunDefinition(input([
      event(1, "AGENT_EVENT", { event: { type: "tool_start", toolCallId: "tool_1", name: "Read File" } }),
      event(2, "AGENT_EVENT", { event: { type: "tool_start", toolCallId: "tool_2", name: "Search" } }),
      foreignStructured,
      wrongWorkItem,
    ]));

    expect(result).toMatchObject({
      ok: true,
      kind: "observed_trace",
      sourceImported: false,
    });
    expect(JSON.stringify(result)).not.toContain("污染计划");
    expect(JSON.stringify(result)).not.toContain("不应进入结果");
  });

  it("bounds structured step count and purpose size with explicit warnings", () => {
    const hugePurpose = "核".repeat(10_000);
    const result = extractRunDefinition(input([
      event(1, "FLOW_PROPOSED", {
        definition_revision: "agent:oversized",
        flow: {
          workflow_id: "flow_ephemeral_run_source",
          name: "超大结构化计划",
          steps: Array.from({ length: 100 }, (_, index) => ({
            id: `raw_${index + 1}`,
            purpose: hugePurpose,
            depends_on: index ? [`raw_${index}`] : [],
          })),
        },
      }),
    ]));

    expect(result).toMatchObject({ ok: true, kind: "structured_plan" });
    if (!result.ok) throw new Error("expected bounded structured extraction");
    expect(result.steps).toHaveLength(24);
    expect(result.steps.every((step) => Array.from(step.purpose).length <= 240)).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("24"),
      expect.stringContaining("240"),
    ]));
  });

  it("applies the shared purpose bound to observed Skill script traces", () => {
    const longSkill = `skill-${"s".repeat(320)}`;
    const longScript = `script-${"p".repeat(320)}.py`;
    const result = extractRunDefinition(input([
      event(1, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "tool_1",
        name: `python3 /Users/demo/.agents/skills/${longSkill}/scripts/${longScript}`,
      } }),
      event(2, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "tool_2",
        name: "Read File",
      } }),
    ]));

    expect(result).toMatchObject({ ok: true, kind: "observed_trace" });
    if (!result.ok) throw new Error("expected observed Skill trace");
    expect(result.steps.every((step) => Array.from(step.purpose).length <= 240)).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("240"),
    ]));
  });

  it("preserves explicit Imported provenance without recommending the run", () => {
    const result = extractRunDefinition(input([
      event(1, "AGENT_EVENT", { event: { type: "tool_start", toolCallId: "tool_1", name: "Read File" } }),
      event(2, "AGENT_EVENT", { event: { type: "tool_start", toolCallId: "tool_2", name: "Search" } }),
      event(3, "RUN_SUCCEEDED", { imported: true }),
    ]));

    expect(result).toMatchObject({
      ok: true,
      sourceImported: true,
      provenance: { sourceRunId: "run_source", sourceSessionId: "sess_source" },
    });
    expect(result).not.toHaveProperty("saveable");
  });

  it("rejects unsuccessful and Flow Runtime runs", () => {
    expect(extractRunDefinition(input([], { run: run({ status: "failed" }) }))).toEqual({
      ok: false,
      code: "run_not_succeeded",
      reason: expect.any(String),
    });
    expect(extractRunDefinition(input([], { run: run({ executionKind: "flow" }) }))).toEqual({
      ok: false,
      code: "run_not_extractable",
      reason: expect.any(String),
    });
  });
});

interface SaveIntentFixture {
  sessions: SessionCatalogStore;
  events: SqliteEventStore;
  catalog: FlowCatalogStore;
  service: FlowSaveIntentService;
  sessionId: string;
  workItemId: string;
}

const openSaveIntentFixtures: SaveIntentFixture[] = [];

afterEach(() => {
  for (const fixture of openSaveIntentFixtures.splice(0)) {
    fixture.catalog.close();
    fixture.events.close();
    fixture.sessions.close();
  }
  vi.restoreAllMocks();
});

function saveIntentFixture(): SaveIntentFixture {
  const sessions = new SessionCatalogStore(":memory:");
  const events = new SqliteEventStore(":memory:");
  const catalog = new FlowCatalogStore(":memory:");
  const sessionId = "sess_flow_save";
  const workItemId = "wi_flow_save";
  sessions.createSession({ id: sessionId, agentId: "codex", taskRecordId: workItemId });
  events.createWorkItem({
    id: workItemId,
    title: "Flow save intent fixture",
    mode: "auto",
    conversationId: `conv_${sessionId}`,
    sessionId,
    agentId: "codex",
    riskLevel: "read_only",
  });
  events.withSessionTransaction((transaction) => transaction.ensureRuntime(sessionId));
  const service = new FlowSaveIntentService({ sessions, events, catalog });
  const fixture = { sessions, events, catalog, service, sessionId, workItemId };
  openSaveIntentFixtures.push(fixture);
  return fixture;
}

function seedSaveIntentRun(
  fixture: SaveIntentFixture,
  options: {
    id: string;
    text?: string;
    executionKind?: "agent" | "flow";
    status?: "running" | "succeeded" | "failed";
    imported?: boolean;
    tools?: string[];
  },
): Run {
  const executionKind = options.executionKind ?? "agent";
  let runId = options.id;
  fixture.events.withSessionTransaction((transaction) => {
    const turn = transaction.insertTurn(fixture.sessionId, {
      text: options.text ?? `业务任务 ${options.id}`,
      attachmentIds: [],
      flowId: executionKind === "flow" ? "flow_published" : null,
      executionKind,
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    });
    const dispatched = transaction.dispatchTurn(turn.turnId, {
      id: options.id,
      workItemId: fixture.workItemId,
      sessionId: fixture.sessionId,
      turnId: turn.turnId,
      agentId: "codex",
      mode: "auto",
      executionKind,
      planId: null,
      planIrHash: null,
      workflowRevision: null,
    });
    runId = dispatched.run.id;
  });
  for (const [index, name] of (options.tools ?? ["Read File", "Search"]).entries()) {
    fixture.events.appendEvent({
      workItemId: fixture.workItemId,
      runId,
      type: "AGENT_EVENT",
      actor: "adapter",
      target: "tool_start",
      payload: {
        imported: options.imported === true,
        event: { type: "tool_start", toolCallId: `${runId}_tool_${index}`, name },
      },
    });
  }
  const status = options.status ?? "succeeded";
  fixture.events.updateRunStatus(runId, status);
  if (status === "succeeded") {
    fixture.events.appendEvent({
      workItemId: fixture.workItemId,
      runId,
      type: "RUN_SUCCEEDED",
      actor: "system",
      target: runId,
      payload: { imported: options.imported === true },
    });
  }
  return fixture.events.getRun(runId)!;
}

function addRequestToolStart(
  fixture: SaveIntentFixture,
  run: Run,
  toolCallId: string,
): void {
  fixture.events.appendEvent({
    workItemId: fixture.workItemId,
    runId: run.id,
    type: "AGENT_EVENT",
    actor: "adapter",
    target: "tool_start",
    payload: {
      event: {
        type: "tool_start",
        toolCallId,
        name: "codebridge.request_flow_save",
      },
    },
  });
}

function saveMatchingLifecycleFlow(
  fixture: SaveIntentFixture,
  request: ReturnType<FlowSaveIntentService["requestManual"]>,
  status: "candidate" | "published" | "deprecated" = "candidate",
) {
  return fixture.catalog.save({
    flowId: candidateFlowId(request.requestId),
    name: `Matching ${request.requestId}`,
    kind: "runbook",
    status,
    source: "agent_generated",
    definitionRevision: `sha256:${request.requestId}`,
    reviewStatus: status === "candidate" ? "pending" : "approved",
    gitRevision: status === "candidate" ? null : `git:${status}`,
    steps: [{ id: "inspect", purpose: "核对来源" }],
    provenance: {
      sourceRunId: request.sourceRunId,
      sourceSessionId: request.sessionId,
      sourceFlowId: `flow_ephemeral_${request.sourceRunId}`,
      sourceDefinitionRevision: `agent:${request.sourceRunId}`,
      sourceRequestId: request.requestId,
    },
  });
}

describe("FlowSaveIntentService", () => {
  it("deduplicates manual idempotency keys and Agent toolCallIds", () => {
    const fixture = saveIntentFixture();
    const source = seedSaveIntentRun(fixture, { id: "run_source" });
    const first = fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
    }, "manual-key");
    const replay = fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
    }, "manual-key");
    expect(replay.requestId).toBe(first.requestId);

    const requestRun = seedSaveIntentRun(fixture, {
      id: "run_request",
      text: "把刚才任务存为 Flow",
      status: "running",
      tools: [],
    });
    addRequestToolStart(fixture, requestRun, "tool_save");
    const toolFirst = fixture.service.requestFromTool({
      sessionId: fixture.sessionId,
      currentRunId: requestRun.id,
      toolCallId: "tool_save",
      sourceScope: "previous_completed_run",
    });
    const toolReplay = fixture.service.requestFromTool({
      sessionId: fixture.sessionId,
      currentRunId: requestRun.id,
      toolCallId: "tool_save",
      sourceScope: "previous_completed_run",
    });
    expect(toolReplay.requestId).toBe(toolFirst.requestId);
    expect(fixture.events.listEvents(fixture.workItemId)
      .filter((entry) => entry.type === "FLOW_SAVE_REQUESTED")).toHaveLength(2);
  });

  it("selects the latest preceding successful Agent Run by canonical sequence", () => {
    const fixture = saveIntentFixture();
    seedSaveIntentRun(fixture, { id: "run_old" });
    const latest = seedSaveIntentRun(fixture, { id: "run_latest" });
    seedSaveIntentRun(fixture, { id: "run_flow", executionKind: "flow" });
    seedSaveIntentRun(fixture, { id: "run_failed", status: "failed" });
    seedSaveIntentRun(fixture, {
      id: "run_management",
      text: "",
      tools: ["codebridge.request_flow_save", "codebridge.request_flow_save"],
    });
    const requestRun = seedSaveIntentRun(fixture, {
      id: "run_current",
      text: "存为 Flow",
      status: "running",
      tools: [],
    });
    addRequestToolStart(fixture, requestRun, "tool_latest");

    const request = fixture.service.requestFromTool({
      sessionId: fixture.sessionId,
      currentRunId: requestRun.id,
      toolCallId: "tool_latest",
      sourceScope: "previous_completed_run",
    });

    expect(request.sourceRunId).toBe(latest.id);
    expect(request.requestRunId).toBe(requestRun.id);
  });

  it("rejects invalid manual sources before writing any request event", () => {
    const fixture = saveIntentFixture();
    const failed = seedSaveIntentRun(fixture, { id: "run_failed", status: "failed" });
    const flow = seedSaveIntentRun(fixture, { id: "run_flow", executionKind: "flow" });
    const thin = seedSaveIntentRun(fixture, { id: "run_thin", tools: ["Read File"] });
    const before = fixture.events.listEvents(fixture.workItemId)
      .filter((entry) => entry.type === "FLOW_SAVE_REQUESTED").length;

    expect(() => fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: "run_missing",
    }, "missing")).toThrowError(expect.objectContaining({ code: "source_run_not_found" }));
    expect(() => fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: failed.id,
    }, "failed")).toThrowError(expect.objectContaining({ code: "source_run_not_succeeded" }));
    for (const [key, sourceRunId] of [["flow", flow.id], ["thin", thin.id]] as const) {
      expect(() => fixture.service.requestManual({
        sessionId: fixture.sessionId,
        sourceRunId,
      }, key)).toThrowError(expect.objectContaining({ code: "source_run_not_extractable" }));
    }
    expect(fixture.events.listEvents(fixture.workItemId)
      .filter((entry) => entry.type === "FLOW_SAVE_REQUESTED")).toHaveLength(before);
  });

  it("accepts explicit Imported sources and persists Imported provenance", async () => {
    const fixture = saveIntentFixture();
    const source = seedSaveIntentRun(fixture, { id: "run_imported", imported: true });
    const request = fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
    }, "imported");
    expect(request.sourceImported).toBe(true);

    const confirmed = await fixture.service.confirm(request.requestId, "confirm-imported");
    expect(confirmed.flow.provenance).toMatchObject({
      sourceRunId: source.id,
      sourceRequestId: request.requestId,
    });
  });

  it("makes dismiss idempotent and terminal", async () => {
    const fixture = saveIntentFixture();
    const source = seedSaveIntentRun(fixture, { id: "run_source" });
    const request = fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
    }, "dismiss-source");

    const first = fixture.service.dismiss(request.requestId, "dismiss-key");
    const replay = fixture.service.dismiss(request.requestId, "dismiss-key");
    expect(first.state).toBe("dismissed");
    expect(replay).toEqual(first);
    await expect(fixture.service.confirm(request.requestId, "confirm-after-dismiss"))
      .rejects.toMatchObject({ code: "flow_save_request_already_dismissed" });
  });

  it("converges concurrent confirms on one deterministic Candidate and terminal event", async () => {
    const fixture = saveIntentFixture();
    const source = seedSaveIntentRun(fixture, { id: "run_source" });
    const request = fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
      nameHint: "订单复核",
    }, "confirm-source");

    const [first, second] = await Promise.all([
      fixture.service.confirm(request.requestId, "confirm-one"),
      fixture.service.confirm(request.requestId, "confirm-two"),
    ]);
    expect(first.flow.flowId).toBe(candidateFlowId(request.requestId));
    expect(second.flow.flowId).toBe(first.flow.flowId);
    expect(definitionHash(compileCatalogFlow(first.flow))).toBe(first.flow.planIrHash);
    expect(fixture.catalog.list()).toHaveLength(1);
    expect(fixture.events.listEventsByTarget(request.requestId)
      .filter((entry) => entry.type === "FLOW_CANDIDATE_CREATED")).toHaveLength(1);

    const beforeReplayChanges = fixture.events.countAllChanges();
    const beforeReplayHistory = fixture.catalog.history(first.flow.flowId);
    const replay = await fixture.service.confirm(request.requestId, "brand-new-confirm-key");
    expect(replay.flow.flowId).toBe(first.flow.flowId);
    expect(fixture.events.countAllChanges()).toBe(beforeReplayChanges);
    expect(fixture.catalog.history(first.flow.flowId)).toEqual(beforeReplayHistory);
  });

  it("keeps a request pending when the Catalog is unavailable", async () => {
    const fixture = saveIntentFixture();
    const source = seedSaveIntentRun(fixture, { id: "run_source" });
    const request = fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
    }, "catalog-down-source");
    vi.spyOn(fixture.catalog, "save").mockImplementationOnce(() => {
      throw new Error("flow_catalog_unavailable");
    });

    await expect(fixture.service.confirm(request.requestId, "catalog-down"))
      .rejects.toMatchObject({ code: "flow_catalog_unavailable", status: 503 });
    expect(fixture.service.getRequestState(request.requestId).state).toBe("requested");
    expect(fixture.events.listEventsByTarget(request.requestId)
      .filter((entry) => entry.type === "FLOW_SAVE_FAILED")).toHaveLength(0);
  });

  it("records confirm-time deterministic failures once and requires a new request", async () => {
    const fixture = saveIntentFixture();
    const source = seedSaveIntentRun(fixture, { id: "run_source" });
    const request = fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
    }, "source-before-failure");
    fixture.events.updateRunStatus(source.id, "failed");

    await expect(fixture.service.confirm(request.requestId, "confirm-failed-source"))
      .rejects.toMatchObject({ code: "source_run_not_succeeded" });
    await expect(fixture.service.confirm(request.requestId, "confirm-failed-source-replay"))
      .rejects.toMatchObject({ code: "flow_save_request_state_conflict" });
    expect(fixture.events.listEventsByTarget(request.requestId)
      .filter((entry) => entry.type === "FLOW_SAVE_FAILED")).toHaveLength(1);

    fixture.events.updateRunStatus(source.id, "succeeded");
    const replacement = fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
    }, "new-request");
    expect(replacement.requestId).not.toBe(request.requestId);
  });

  it("records a confirm-time extraction invalidation once", async () => {
    const fixture = saveIntentFixture();
    const source = seedSaveIntentRun(fixture, { id: "run_source" });
    let extractionAvailable = true;
    const service = new FlowSaveIntentService({
      sessions: fixture.sessions,
      events: fixture.events,
      catalog: fixture.catalog,
      extract: (input) => extractionAvailable
        ? extractRunDefinition(input)
        : {
            ok: false,
            code: "run_not_extractable",
            reason: "source evidence was removed",
          },
    });
    const request = service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
    }, "extractable-before-confirm");
    extractionAvailable = false;

    await expect(service.confirm(request.requestId, "confirm-invalid"))
      .rejects.toMatchObject({ code: "source_run_not_extractable" });
    expect(service.getRequestState(request.requestId)).toMatchObject({
      state: "failed",
      code: "source_run_not_extractable",
    });
    expect(fixture.events.listEventsByTarget(request.requestId)
      .filter((entry) => entry.type === "FLOW_SAVE_FAILED")).toHaveLength(1);
  });

  it("rejects deterministic Candidate collisions without overwriting", async () => {
    const fixture = saveIntentFixture();
    const source = seedSaveIntentRun(fixture, { id: "run_source" });
    const request = fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
    }, "collision-source");
    const candidateId = candidateFlowId(request.requestId);
    fixture.catalog.save({
      flowId: candidateId,
      name: "Unrelated Candidate",
      kind: "runbook",
      status: "candidate",
      source: "agent_generated",
      definitionRevision: "sha256:unrelated",
      steps: [{ id: "unrelated", purpose: "不得覆盖" }],
      provenance: {
        sourceRunId: source.id,
        sourceSessionId: fixture.sessionId,
        sourceFlowId: "flow_unrelated",
        sourceDefinitionRevision: "sha256:unrelated",
        sourceRequestId: "fsr_other",
      },
    });

    await expect(fixture.service.confirm(request.requestId, "collision-confirm"))
      .rejects.toMatchObject({ code: "flow_save_candidate_conflict" });
    expect(fixture.catalog.get(candidateId)?.name).toBe("Unrelated Candidate");
    expect(fixture.service.getRequestState(request.requestId).state).toBe("failed");
  });

  it.each([
    { label: "Guide kind", kind: "guide" as const, status: "draft" as const },
    { label: "Runbook draft", kind: "runbook" as const, status: "draft" as const },
    { label: "wrong source Run", kind: "runbook" as const, status: "candidate" as const, sourceRunId: "run_other" },
    { label: "wrong source Session", kind: "runbook" as const, status: "candidate" as const, sourceSessionId: "sess_other" },
  ])("rejects an existing deterministic record with $label even when request provenance matches", async (variant) => {
    const fixture = saveIntentFixture();
    const source = seedSaveIntentRun(fixture, { id: "run_source" });
    const request = fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
    }, `collision-${variant.label}`);
    const candidateId = candidateFlowId(request.requestId);
    fixture.catalog.save({
      flowId: candidateId,
      name: "Wrong deterministic record",
      kind: variant.kind,
      status: variant.status,
      source: "agent_generated",
      definitionRevision: "sha256:wrong-record",
      steps: [{ id: "wrong", purpose: "不得作为该请求的 Candidate" }],
      provenance: {
        sourceRunId: variant.sourceRunId ?? source.id,
        sourceSessionId: variant.sourceSessionId ?? fixture.sessionId,
        sourceFlowId: "flow_ephemeral_run_source",
        sourceDefinitionRevision: "sha256:source",
        sourceRequestId: request.requestId,
      },
    });

    await expect(fixture.service.confirm(request.requestId, "confirm-wrong-record"))
      .rejects.toMatchObject({ code: "flow_save_candidate_conflict" });
    expect(fixture.catalog.get(candidateId)?.name).toBe("Wrong deterministic record");
    expect(fixture.events.listEventsByTarget(request.requestId)
      .filter((entry) => entry.type === "FLOW_SAVE_FAILED")).toHaveLength(1);
    expect(fixture.events.listEventsByTarget(request.requestId)
      .filter((entry) => entry.type === "FLOW_CANDIDATE_CREATED")).toHaveLength(0);
  });

  it.each(["published", "deprecated"] as const)(
    "repairs a requested intent from its matching deterministic %s Runbook",
    async (status) => {
      const fixture = saveIntentFixture();
      const source = seedSaveIntentRun(fixture, { id: "run_source" });
      const request = fixture.service.requestManual({
        sessionId: fixture.sessionId,
        sourceRunId: source.id,
      }, `pending-${status}-source`);
      const flowId = candidateFlowId(request.requestId);
      const flow = fixture.catalog.save({
        flowId,
        name: "Matching lifecycle Flow",
        kind: "runbook",
        status,
        source: "agent_generated",
        definitionRevision: `sha256:${status}`,
        reviewStatus: "approved",
        gitRevision: `git:${status}`,
        steps: [{ id: "inspect", purpose: "核对来源" }],
        provenance: {
          sourceRunId: request.sourceRunId,
          sourceSessionId: request.sessionId,
          sourceFlowId: "flow_ephemeral_run_source",
          sourceDefinitionRevision: "sha256:source",
          sourceRequestId: request.requestId,
        },
      });

      const confirmed = await fixture.service.confirm(request.requestId, "confirm-repair");

      expect(confirmed.flow).toEqual(flow);
      expect(fixture.service.getRequestState(request.requestId)).toMatchObject({
        state: "completed",
        flowId,
      });
      expect(fixture.events.listEventsByTarget(request.requestId)
        .filter((entry) => entry.type === "FLOW_SAVE_FAILED")).toHaveLength(0);
    },
  );

  it("isolates a corrupt request payload and repairs the next pending request", async () => {
    const fixture = saveIntentFixture();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fixture.events.appendEvent({
      workItemId: fixture.workItemId,
      type: "FLOW_SAVE_REQUESTED",
      actor: "system",
      target: "fsr_corrupt",
      payload: { request_id: "fsr_corrupt" },
    });
    const source = seedSaveIntentRun(fixture, { id: "run_source" });
    const healthy = fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
    }, "healthy-after-corrupt");
    saveMatchingLifecycleFlow(fixture, healthy);

    expect(await fixture.service.reconcilePendingAtStartup()).toBe(1);
    expect(fixture.service.getRequestState(healthy.requestId).state).toBe("completed");
    expect(errorLog).toHaveBeenCalledWith(
      "Flow save intent request reconciliation failed:",
      "fsr_corrupt",
      expect.any(Error),
    );
  });

  it("isolates one terminal append failure and repairs the next pending request", async () => {
    const fixture = saveIntentFixture();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const source = seedSaveIntentRun(fixture, { id: "run_source" });
    const first = fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
    }, "append-failure-first");
    const second = fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
    }, "append-failure-second");
    saveMatchingLifecycleFlow(fixture, first);
    saveMatchingLifecycleFlow(fixture, second);
    const originalAppend = fixture.events.appendEventOnce.bind(fixture.events);
    vi.spyOn(fixture.events, "appendEventOnce").mockImplementation((input) => {
      if (input.type === "FLOW_CANDIDATE_CREATED" && input.target === first.requestId) {
        throw new Error("injected_first_append_failure");
      }
      return originalAppend(input);
    });

    expect(await fixture.service.reconcilePendingAtStartup()).toBe(1);
    expect(fixture.service.getRequestState(first.requestId).state).toBe("requested");
    expect(fixture.service.getRequestState(second.requestId).state).toBe("completed");
    expect(errorLog).toHaveBeenCalledWith(
      "Flow save intent request reconciliation failed:",
      first.requestId,
      expect.objectContaining({ message: "injected_first_append_failure" }),
    );
  });

  it("propagates a Catalog read failure instead of treating it as one bad request", async () => {
    const fixture = saveIntentFixture();
    const source = seedSaveIntentRun(fixture, { id: "run_source" });
    const request = fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
    }, "catalog-read-failure");
    saveMatchingLifecycleFlow(fixture, request);
    vi.spyOn(fixture.catalog, "get").mockImplementationOnce(() => {
      throw new Error("catalog_read_unavailable");
    });

    await expect(fixture.service.reconcilePendingAtStartup())
      .rejects.toThrow("catalog_read_unavailable");
    expect(fixture.service.getRequestState(request.requestId).state).toBe("requested");
  });

  it.each(["published", "deprecated"] as const)(
    "replays a completed request after the Flow becomes %s without writing",
    async (status) => {
      const fixture = saveIntentFixture();
      const source = seedSaveIntentRun(fixture, { id: "run_source" });
      const request = fixture.service.requestManual({
        sessionId: fixture.sessionId,
        sourceRunId: source.id,
      }, `completed-${status}-source`);
      const confirmed = await fixture.service.confirm(request.requestId, "confirm-first");
      fixture.catalog.save({
        ...confirmed.flow,
        status,
        reviewStatus: "approved",
        gitRevision: `git:${status}`,
      });
      const lifecycleFlow = fixture.catalog.get(confirmed.flow.flowId)!;
      const beforeEvents = fixture.events.countAllChanges();
      const beforeHistory = fixture.catalog.history(lifecycleFlow.flowId);

      const replay = await fixture.service.confirm(request.requestId, `confirm-after-${status}`);

      expect(replay.flow).toEqual(lifecycleFlow);
      expect(fixture.events.countAllChanges()).toBe(beforeEvents);
      expect(fixture.events.listEventsByTarget(request.requestId)
        .filter((entry) => entry.type === "FLOW_SAVE_FAILED")).toHaveLength(0);
      expect(fixture.catalog.history(lifecycleFlow.flowId)).toEqual(beforeHistory);
    },
  );

  it.each([
    { label: "Guide kind", kind: "guide" as const, status: "draft" as const },
    { label: "wrong provenance", kind: "runbook" as const, status: "published" as const, sourceRunId: "run_other" },
  ])("rejects completed replay with $label", async (variant) => {
    const fixture = saveIntentFixture();
    const source = seedSaveIntentRun(fixture, { id: "run_source" });
    const request = fixture.service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
    }, `completed-conflict-${variant.label}`);
    const confirmed = await fixture.service.confirm(request.requestId, "confirm-first");
    fixture.catalog.save({
      ...confirmed.flow,
      kind: variant.kind,
      status: variant.status,
      reviewStatus: variant.status === "published" ? "approved" : "pending",
      gitRevision: variant.status === "published" ? "git:conflict" : null,
      provenance: confirmed.flow.provenance
        ? {
            ...confirmed.flow.provenance,
            sourceRunId: variant.sourceRunId ?? confirmed.flow.provenance.sourceRunId,
          }
        : null,
    });

    await expect(fixture.service.confirm(request.requestId, "confirm-after-conflict"))
      .rejects.toMatchObject({ code: "flow_save_candidate_conflict" });
    expect(fixture.events.listEventsByTarget(request.requestId)
      .filter((entry) => entry.type === "FLOW_SAVE_FAILED")).toHaveLength(1);
  });
});
