import { describe, expect, it } from "vitest";
import type { FlowInput, FlowRecord } from "@codebridge/flow-catalog";
import {
  FlowBatchValidationError,
  validateFlowBatchDraft,
} from "./flow-batch-validation.js";

function flow(inputs: FlowInput[]): FlowRecord {
  return {
    schemaVersion: 1,
    flowId: "flow_orders",
    name: "订单核验",
    description: null,
    kind: "runbook",
    status: "published",
    source: "user_selected",
    definitionRevision: "sha256:def",
    planIrHash: "sha256:plan",
    inputs,
    reviewStatus: "approved",
    gitRevision: null,
    validationIssues: [],
    steps: [],
    lineageRootFlowId: "flow_orders",
    parentFlowId: null,
    provenance: null,
    publicationSequence: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

const evidence = {
  source: "agent_extracted",
  evidence_ref: "event:message-1#line:1",
  inferred: false,
};

describe("validateFlowBatchDraft", () => {
  it.each([
    [
      "integer string",
      [{ id: "oid", type: "integer", source: "user", required: true } satisfies FlowInput],
      { oid: "1644460" },
      { oid: 1644460 },
      [],
    ],
    [
      "bad integer",
      [{ id: "oid", type: "integer", source: "user", required: true } satisfies FlowInput],
      { oid: "x" },
      {},
      ["invalid_type", "missing"],
    ],
    [
      "enum",
      [{ id: "region", type: "enum", source: "user", values: ["cn", "us"] } satisfies FlowInput],
      { region: "cn" },
      { region: "cn" },
      [],
    ],
    [
      "bad enum",
      [{ id: "region", type: "enum", source: "user", values: ["cn", "us"] } satisfies FlowInput],
      { region: "xx" },
      {},
      ["invalid_value"],
    ],
  ])("normalizes %s", (_name, definitions, inputs, expected, issueCodes) => {
    const result = validateFlowBatchDraft(flow(definitions), {
      global_inputs: {},
      source_refs: ["event:message-1"],
      items: [{
        item_id: "one",
        inputs,
        evidence: Object.fromEntries(Object.keys(inputs).map((key) => [key, evidence])),
      }],
    });
    expect(result.items[0]?.inputs).toEqual(expected);
    expect(result.items[0]?.issues.map((issue) => issue.code)).toEqual(issueCodes);
  });

  it("merges normalized global values and item overrides", () => {
    const result = validateFlowBatchDraft(flow([
      { id: "region", type: "enum", source: "user", values: ["cn", "us"], required: true },
      { id: "oid", type: "integer", source: "user", required: true },
    ]), {
      global_inputs: { region: "cn" },
      source_refs: ["event:message-1"],
      items: [{
        item_id: "one",
        inputs: { oid: "1" },
        evidence: { region: evidence, oid: evidence },
      }],
    });

    expect(result.status).toBe("ready");
    expect(result.globalInputs).toEqual({ region: "cn" });
    expect(result.items[0]?.inputs).toEqual({ oid: 1 });
  });

  it("blocks missing required and agent-extracted secret values", () => {
    const result = validateFlowBatchDraft(flow([
      { id: "oid", type: "integer", source: "user", required: true },
      { id: "token", type: "secret_ref", source: "user", required: true },
    ]), {
      global_inputs: {},
      source_refs: ["event:message-1"],
      items: [{
        item_id: "one",
        inputs: { token: "raw-secret" },
        evidence: { token: evidence },
      }],
    });

    expect(result.items[0]?.inputs).not.toHaveProperty("token");
    expect(result.items[0]?.issues.map((issue) => [issue.code, issue.field]))
      .toEqual(expect.arrayContaining([
        ["missing", "oid"],
        ["invalid_value", "token"],
      ]));
    expect(result.status).toBe("needs_input");
  });

  it("drops undeclared inputs and marks duplicate rows as blocking", () => {
    const result = validateFlowBatchDraft(flow([
      { id: "oid", type: "integer", source: "user", required: true },
    ]), {
      global_inputs: { ignored: "value" },
      source_refs: ["event:message-1"],
      items: [1, 2].map((ordinal) => ({
        item_id: `item_${ordinal}`,
        inputs: { oid: "1", ignored: "value" },
        evidence: { oid: evidence },
      })),
    });

    expect(result.globalInputs).toEqual({});
    expect(result.items[0]?.inputs).toEqual({ oid: 1 });
    expect(result.items[1]?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate", blocking: true }),
    ]));
    expect(result.status).toBe("needs_input");
  });

  it("preserves LLM ambiguity only with an evidence reference", () => {
    const result = validateFlowBatchDraft(flow([
      { id: "oid", type: "integer", source: "user", required: true },
    ]), {
      global_inputs: {},
      source_refs: ["event:message-1"],
      items: [{
        item_id: "one",
        inputs: { oid: 1 },
        evidence: { oid: { ...evidence, evidence_ref: "" } },
        issues: [{
          code: "ambiguous",
          field: "oid",
          message: "存在两个订单号",
          blocking: true,
        }],
      }],
    });

    expect(result.items[0]?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ambiguous", field: "oid" }),
      expect.objectContaining({ code: "invalid_value", field: "oid" }),
    ]));
    expect(result.status).toBe("needs_input");
  });

  it("rejects more than the configured number of rows", () => {
    expect(() => validateFlowBatchDraft(flow([]), {
      global_inputs: {},
      items: [{ item_id: "one", inputs: {} }, { item_id: "two", inputs: {} }],
    }, { maxItems: 1 })).toThrowError(
      expect.objectContaining<Partial<FlowBatchValidationError>>({
        code: "batch_limit_exceeded",
      }),
    );
  });
});
