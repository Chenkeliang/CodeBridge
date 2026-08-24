import { describe, expect, it } from "vitest";
import type { FlowRecord } from "@codebridge/flow-catalog";
import { buildFlowRecommendationGuidance } from "./flow-recommendation-guidance.js";

function flow(overrides: Partial<FlowRecord>): FlowRecord {
  const now = "2026-08-21T00:00:00.000Z";
  return {
    schemaVersion: 1, flowId: "flow_demo", name: "订单核验", description: null,
    kind: "runbook", status: "published", source: "git",
    definitionRevision: "sha256:one", planIrHash: "sha256:plan",
    inputs: [{ id: "oid", type: "integer", source: "user", required: true }],
    steps: [], reviewStatus: "approved", gitRevision: null, validationIssues: [],
    lineageRootFlowId: "flow_demo", parentFlowId: null, provenance: null,
    publicationSequence: 1, createdAt: now, updatedAt: now, ...overrides,
  };
}

describe("buildFlowRecommendationGuidance", () => {
  it("injects only consumable Flow identities and leaves the decision to the Agent", () => {
    const text = buildFlowRecommendationGuidance([
      flow({}),
      flow({ flowId: "guide", kind: "guide", status: "draft", definitionRevision: "sha256:guide" }),
      flow({ flowId: "candidate", status: "candidate", definitionRevision: "sha256:candidate" }),
    ]);
    expect(text).toContain("订单核验 | flow_demo | sha256:one");
    expect(text).toContain("fcb flow suggest");
    expect(text).toContain("fcb flow batch <draft-json-file>");
    expect(text).toContain("用户明确引用");
    expect(text).toContain("提交成功后停止调用业务工具");
    expect(text).toContain("高置信");
    expect(text).not.toContain("sha256:guide");
    expect(text).not.toContain("sha256:candidate");
  });

  it("does not change ordinary prompts when no consumable Flow exists", () => {
    expect(buildFlowRecommendationGuidance([
      flow({ kind: "guide", status: "draft" }),
    ])).toBe("");
  });
});
