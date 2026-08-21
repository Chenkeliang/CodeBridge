import { describe, expect, it } from "vitest";
import { defaultsFromFlow, flowRunMessage } from "./flow-run-submit";
import type { FlowRecord } from "./types";

const flow: FlowRecord = {
  flow_id: "flow_demo_echo", name: "Demo Echo", kind: "runbook", status: "published",
  description: null,
  source: "user", definition_revision: "sha256:def", plan_ir_hash: "sha256:abcdef0123456789",
  review_status: "approved", git_revision: null, validation_issues: [],
  lineage_root_flow_id: "flow_demo_echo", parent_flow_id: null, provenance: null, publication_sequence: 1,
  created_at: "2026-08-21T00:00:00.000Z", updated_at: "2026-08-21T00:00:00.000Z",
  inputs: [{ id: "text", type: "string", source: "user", required: true, default: "hi" }],
  steps: [],
};

describe("flowRunMessage", () => {
  it("uses a non-empty draft", () => {
    expect(flowRunMessage("  go  ", flow)).toBe("go");
  });
  it("synthesizes a message when the composer draft is empty", () => {
    expect(flowRunMessage("   ", flow)).toBe("运行 Demo Echo");
  });
});

describe("defaultsFromFlow", () => {
  it("copies defined defaults", () => {
    expect(defaultsFromFlow(flow)).toEqual({ text: "hi" });
  });
});
