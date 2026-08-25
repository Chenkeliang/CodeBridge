import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FLOW_SAVE_NO_SOURCE_MESSAGE,
  FLOW_SAVE_TOOL_MARKER,
  FLOW_SAVE_TOOL_NAME,
  PI_FLOW_SAVE_TOOL_NAME,
} from "@codebridge/core";
import { FlowCatalogStore } from "@codebridge/flow-catalog";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SqliteEventStore, type DomainEvent, type Run } from "@codebridge/work-items";
import { definitionHash } from "@codebridge/workflow-engine";
import { compileCatalogFlow } from "./flow-compile.js";
import {
  candidateFlowId,
  extractRunDefinition,
  flowSaveToolOutputFromAgentValue,
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

function acpExecuteEvent(
  sequence: number,
  toolCallId: string,
  command: string,
): DomainEvent {
  return event(sequence, "AGENT_EVENT", { event: {
    type: "tool_start",
    toolCallId,
    name: command,
    kind: "execute",
    status: "in_progress",
    input: { command, cwd: "/Users/alice/projects" },
    content: [{ terminalId: toolCallId, type: "terminal" }],
  } });
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

  it("keeps distinct real ACP execute calls extractable without exposing command details", () => {
    const uuid = "01944f05-2d18-7935-8296-773caa8165fc";
    const secret = "private_search_term";
    const privatePath = "/Users/alice/projects/private-repository";
    const result = extractRunDefinition(input([
      acpExecuteEvent(
        1,
        "exec-11111111-1111-4111-8111-111111111111",
        `rtk cat ${privatePath}/AGENTS.md`,
      ),
      acpExecuteEvent(
        2,
        "exec-22222222-2222-4222-8222-222222222222",
        `rtk rg -n "${secret}" ${privatePath} --glob '*.ts'`,
      ),
      acpExecuteEvent(
        3,
        "exec-33333333-3333-4333-8333-333333333333",
        `rtk rg -n "flow save" ${privatePath} --context ${uuid}`,
      ),
    ], { title: "只读核对三个受控步骤" }));

    expect(result).toMatchObject({
      ok: true,
      kind: "observed_trace",
      steps: [
        { id: "step_1", purpose: "执行受控命令" },
        { id: "step_2", purpose: "执行受控命令" },
        { id: "step_3", purpose: "执行受控命令" },
      ],
    });
    const presentation = JSON.stringify(result);
    expect(presentation).not.toContain(privatePath);
    expect(presentation).not.toContain(secret);
    expect(presentation).not.toContain(uuid);
    expect(presentation).not.toContain("--glob");
    expect(presentation).not.toContain("--context");
    expect(presentation).not.toContain("*.ts");
  });

  it("retains same-title ACP calls by distinct invocation identity", () => {
    const command = "rtk rg -n secret /Users/alice/private --glob '*.ts'";
    const result = extractRunDefinition(input([
      acpExecuteEvent(1, "exec_distinct_1", command),
      acpExecuteEvent(2, "exec_distinct_2", command),
    ]));

    expect(result).toMatchObject({
      ok: true,
      kind: "observed_trace",
      steps: [
        { id: "step_1", purpose: "执行受控命令" },
        { id: "step_2", purpose: "执行受控命令" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(command);
  });

  it("retains distinct ACP execute identities even for the same single-token title", () => {
    const result = extractRunDefinition(input([
      acpExecuteEvent(1, "exec_bash_1", "bash"),
      acpExecuteEvent(2, "exec_bash_2", "bash"),
    ]));

    expect(result).toMatchObject({
      ok: true,
      steps: [
        { id: "step_1", purpose: "执行受控命令" },
        { id: "step_2", purpose: "执行受控命令" },
      ],
    });
  });

  it("does not count replayed ACP tool_start events as new invocations", () => {
    const command = "rtk rg -n secret /Users/alice/private --glob '*.ts'";

    expect(extractRunDefinition(input([
      acpExecuteEvent(1, "exec_replayed", command),
      acpExecuteEvent(2, "exec_replayed", command),
    ]))).toMatchObject({ ok: false, code: "run_not_extractable" });

    const withAnotherInvocation = extractRunDefinition(input([
      acpExecuteEvent(1, "exec_replayed", command),
      acpExecuteEvent(2, "exec_replayed", command),
      acpExecuteEvent(3, "exec_distinct", command),
    ]));
    expect(withAnotherInvocation).toMatchObject({
      ok: true,
      steps: [
        { id: "step_1", purpose: "执行受控命令" },
        { id: "step_2", purpose: "执行受控命令" },
      ],
    });
  });

  it("uses canonical event identity when an ACP invocation has no toolCallId", () => {
    const command = "rtk rg -n secret /Users/alice/private --glob '*.ts'";
    const first = event(1, "AGENT_EVENT", { event: {
      type: "tool_start",
      name: command,
      kind: "execute",
    } });
    const second = event(2, "AGENT_EVENT", { event: {
      type: "tool_start",
      name: command,
      kind: "execute",
    } });
    const result = extractRunDefinition(input([first, first, second]));

    expect(result).toMatchObject({
      ok: true,
      steps: [
        { id: "step_1", purpose: "执行受控命令" },
        { id: "step_2", purpose: "执行受控命令" },
      ],
    });
  });

  it("does not trust unknown tool kinds to distinguish opaque command titles", () => {
    const opaque = (sequence: number, name: string) => event(sequence, "AGENT_EVENT", {
      event: {
        type: "tool_start",
        toolCallId: `unknown_${sequence}`,
        name,
        kind: "vendor_unknown",
      },
    });
    expect(extractRunDefinition(input([
      opaque(1, "lookup private-one /Users/alice/one"),
      opaque(2, "lookup private-two /Users/alice/two"),
    ]))).toMatchObject({ ok: false, code: "run_not_extractable" });
  });

  it("excludes the Flow save management tool from ACP invocation evidence", () => {
    const marker = {
      codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
      accepted: false,
      source_scope: "previous_completed_run",
      code: "no_extractable_previous_run",
      message: FLOW_SAVE_NO_SOURCE_MESSAGE,
    };
    const result = extractRunDefinition(input([
      acpExecuteEvent(1, "exec_business_1", "rtk rg -n one /Users/alice/private"),
      acpExecuteEvent(2, "exec_save", `mcp.codebridge-internal.${FLOW_SAVE_TOOL_NAME}`),
      event(3, "AGENT_EVENT", { event: {
        type: "tool_end",
        toolCallId: "exec_save",
        status: "completed",
        output: {
          result: { content: [{ type: "text", text: JSON.stringify(marker) }] },
        },
      } }),
      acpExecuteEvent(4, "exec_business_2", "rtk rg -n two /Users/alice/private"),
    ]));
    expect(result).toMatchObject({
      ok: true,
      steps: [
        { id: "step_1", purpose: "执行受控命令" },
        { id: "step_2", purpose: "执行受控命令" },
      ],
    });
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
      source_scope: "previous_completed_run",
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

  it("does not count the provider-safe Pi save tool as a business extraction step", () => {
    expect(extractRunDefinition(input([
      event(1, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "business_1",
        name: "Read File",
      } }),
      event(2, "AGENT_EVENT", { event: {
        type: "tool_start",
        toolCallId: "save_1",
        name: PI_FLOW_SAVE_TOOL_NAME,
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

describe("flowSaveToolOutputFromAgentValue", () => {
  const accepted = {
    codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
    accepted: true as const,
    source_scope: "previous_completed_run" as const,
  };

  it.each([
    { structuredContent: accepted },
    { details: accepted },
    { content: [{ type: "text", text: JSON.stringify(accepted) }] },
    { result: { content: [{ type: "text", text: JSON.stringify(accepted) }] } },
  ])("accepts bounded ACP and Pi result wrappers", (value) => {
    expect(flowSaveToolOutputFromAgentValue(value)).toEqual(accepted);
  });

  it("fails closed when a canonical result wrapper exceeds the traversal limits", () => {
    let payload: unknown = accepted;
    for (let depth = 0; depth < 8; depth += 1) {
      payload = { result: payload };
    }

    expect(flowSaveToolOutputFromAgentValue(payload)).toBeNull();
  });

  it("fails closed when a marker is outside the shared traversal budget", () => {
    const payload = Array.from({ length: 256 }, (_, index) =>
      index === 255 ? accepted : { content: [{ type: "text", text: String(index) }] }
    );

    expect(flowSaveToolOutputFromAgentValue(payload)).toBeNull();
  });

  it("fails closed before parsing an oversized wrapper object", () => {
    const payload = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [`unused_${index}`, index]),
    ) as Record<string, unknown>;
    payload.details = accepted;

    expect(flowSaveToolOutputFromAgentValue(payload)).toBeNull();
  });

  it("shares one total-node budget across individually bounded wrappers", () => {
    const payload = [
      ...Array.from({ length: 13 }, () => ({
        content: [{ type: "text", text: "{}" }],
      })),
      { details: accepted },
    ];

    expect(flowSaveToolOutputFromAgentValue(payload)).toBeNull();
  });

  it("rejects a marker beyond the independent depth limit", () => {
    let payload: unknown = accepted;
    for (let depth = 0; depth < 8; depth += 1) {
      payload = { content: payload };
    }

    expect(flowSaveToolOutputFromAgentValue(payload)).toBeNull();
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
  options: {
    name?: string;
    input?: unknown;
  } = {},
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
        name: options.name ?? "codebridge.request_flow_save",
        input: options.input ?? { source_scope: "previous_completed_run" },
      },
    },
  });
}

function addRequestToolEnd(
  fixture: SaveIntentFixture,
  run: Run,
  toolCallId: string,
  options: {
    status?: string;
    output?: unknown;
    content?: unknown[];
  } = {},
): void {
  fixture.events.appendEvent({
    workItemId: fixture.workItemId,
    runId: run.id,
    type: "AGENT_EVENT",
    actor: "adapter",
    target: "tool_end",
    payload: {
      event: {
        type: "tool_end",
        toolCallId,
        status: options.status ?? "completed",
        output: options.output ?? {
          codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
          accepted: true,
          source_scope: "previous_completed_run",
        },
        ...(options.content ? { content: options.content } : {}),
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
  it("previews hundreds of non-extractable Runs from one canonical event read", () => {
    const fixture = saveIntentFixture();
    for (let index = 0; index < 210; index += 1) {
      seedSaveIntentRun(fixture, {
        id: `run_thin_${index}`,
        tools: ["Read File"],
      });
    }
    const current = seedSaveIntentRun(fixture, {
      id: "run_current",
      text: "把刚才任务存为 Flow",
      status: "running",
      tools: [],
    });
    const listEvents = vi.spyOn(fixture.events, "listEvents");

    expect(fixture.service.previewPreviousSource({
      sessionId: fixture.sessionId,
      currentRunId: current.id,
    })).toMatchObject({ available: false, code: "no_extractable_previous_run" });
    expect(listEvents).toHaveBeenCalledTimes(1);
  });

  it("selects the latest extractable source before many later thin Runs from one snapshot", () => {
    const fixture = saveIntentFixture();
    const latestExtractable = seedSaveIntentRun(fixture, { id: "run_latest_extractable" });
    for (let index = 0; index < 210; index += 1) {
      seedSaveIntentRun(fixture, {
        id: `run_later_thin_${index}`,
        tools: ["Read File"],
      });
    }
    const requestRun = seedSaveIntentRun(fixture, {
      id: "run_request",
      text: "存为 Flow",
      status: "running",
      tools: [],
    });
    addRequestToolStart(fixture, requestRun, "tool_save");
    addRequestToolEnd(fixture, requestRun, "tool_save");
    const listEvents = vi.spyOn(fixture.events, "listEvents");

    const request = fixture.service.requestFromTool({
      sessionId: fixture.sessionId,
      currentRunId: requestRun.id,
      toolCallId: "tool_save",
    });

    expect(request.sourceRunId).toBe(latestExtractable.id);
    expect(listEvents).toHaveBeenCalledTimes(1);
  });

  it("keeps manual request and confirm extraction on fresh event reads", async () => {
    const fixture = saveIntentFixture();
    const source = seedSaveIntentRun(fixture, { id: "run_source" });
    const observedEventCounts: number[] = [];
    const service = new FlowSaveIntentService({
      sessions: fixture.sessions,
      events: fixture.events,
      catalog: fixture.catalog,
      extract: (input) => {
        observedEventCounts.push(input.events.length);
        return extractRunDefinition(input);
      },
    });
    const request = service.requestManual({
      sessionId: fixture.sessionId,
      sourceRunId: source.id,
    }, "fresh-manual");

    await service.confirm(request.requestId, "fresh-confirm");

    expect(observedEventCounts).toHaveLength(2);
    expect(observedEventCounts[1]).toBeGreaterThan(observedEventCounts[0]!);
  });

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
    addRequestToolEnd(fixture, requestRun, "tool_save");
    const toolFirst = fixture.service.requestFromTool({
      sessionId: fixture.sessionId,
      currentRunId: requestRun.id,
      toolCallId: "tool_save",
    });
    const toolReplay = fixture.service.requestFromTool({
      sessionId: fixture.sessionId,
      currentRunId: requestRun.id,
      toolCallId: "tool_save",
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
    addRequestToolEnd(fixture, requestRun, "tool_latest");

    const request = fixture.service.requestFromTool({
      sessionId: fixture.sessionId,
      currentRunId: requestRun.id,
      toolCallId: "tool_latest",
    });

    expect(request.sourceRunId).toBe(latest.id);
    expect(request.requestRunId).toBe(requestRun.id);
  });

  it.each([
    ["MCP: tool", { content: [{
      type: "text",
      text: JSON.stringify({
        codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
        accepted: true,
        source_scope: "previous_completed_run",
      }),
    }] }],
    ["codebridge-internal/codebridge.request_flow_save", { structuredContent: {
      codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
      accepted: true,
      source_scope: "previous_completed_run",
    } }],
    [PI_FLOW_SAVE_TOOL_NAME, { details: {
      codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
      accepted: true,
      source_scope: "previous_completed_run",
    } }],
  ] as const)("correlates strict persisted start/end without trusting adapter title %s", (name, output) => {
    const fixture = saveIntentFixture();
    seedSaveIntentRun(fixture, { id: "run_source" });
    const requestRun = seedSaveIntentRun(fixture, {
      id: "run_request",
      text: "存为 Flow",
      status: "running",
      tools: [],
    });
    addRequestToolStart(fixture, requestRun, "tool_save", { name });
    addRequestToolEnd(fixture, requestRun, "tool_save", { output });

    expect(fixture.service.requestFromTool({
      sessionId: fixture.sessionId,
      currentRunId: requestRun.id,
      toolCallId: "tool_save",
    })).toMatchObject({ sourceRunId: "run_source" });
  });

  it("uses canonical ACP content when rawOutput is opaque", () => {
    const fixture = saveIntentFixture();
    seedSaveIntentRun(fixture, { id: "run_source" });
    const requestRun = seedSaveIntentRun(fixture, {
      id: "run_request",
      text: "存为 Flow",
      status: "running",
      tools: [],
    });
    addRequestToolStart(fixture, requestRun, "tool_save", { name: "MCP: tool" });
    addRequestToolEnd(fixture, requestRun, "tool_save", {
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

    expect(fixture.service.requestFromTool({
      sessionId: fixture.sessionId,
      currentRunId: requestRun.id,
      toolCallId: "tool_save",
    })).toMatchObject({ sourceRunId: "run_source" });
  });

  it.each([
    ["missing start", null, { status: "completed" }],
    ["invalid start input", { input: { source_scope: "previous_completed_run", run_id: "run_bad" } }, { status: "completed" }],
    ["accepted false", {}, { status: "completed", output: {
      codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
      accepted: false,
      source_scope: "previous_completed_run",
      code: "no_extractable_previous_run",
      message: FLOW_SAVE_NO_SOURCE_MESSAGE,
    } }],
    ["wrong marker", {}, { status: "completed", output: {
      codebridge_internal_tool: "wrong/v1",
      accepted: true,
      source_scope: "previous_completed_run",
    } }],
    ["failed tool end", {}, { status: "failed" }],
  ] as const)("rejects %s correlation without writing a request", (_label, start, end) => {
    const fixture = saveIntentFixture();
    seedSaveIntentRun(fixture, { id: "run_source" });
    const requestRun = seedSaveIntentRun(fixture, {
      id: "run_request",
      text: "存为 Flow",
      status: "running",
      tools: [],
    });
    if (start) addRequestToolStart(fixture, requestRun, "tool_save", start);
    addRequestToolEnd(fixture, requestRun, "tool_save", end);

    expect(() => fixture.service.requestFromTool({
      sessionId: fixture.sessionId,
      currentRunId: requestRun.id,
      toolCallId: "tool_save",
    })).toThrowError(expect.objectContaining({ code: "flow_save_tool_call_not_found" }));
    expect(fixture.events.listEvents(fixture.workItemId)
      .filter((entry) => entry.type === "FLOW_SAVE_REQUESTED")).toHaveLength(0);
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
