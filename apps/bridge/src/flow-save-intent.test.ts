import { describe, expect, it } from "vitest";
import type { DomainEvent, Run } from "@codebridge/work-items";
import { extractRunDefinition, type ExtractRunDefinitionInput } from "./flow-save-intent.js";

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
