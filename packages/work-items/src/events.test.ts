import { describe, expect, it } from "vitest";
import {
  SqliteEventStore,
  type Attribution,
  type FlowRecommendedPayload,
  type FlowRejectedPayload,
  type ParamResolvedPayload,
  type RunSnapshotPayload,
  type VerificationFailedPayload,
} from "./index.js";

// Enforces spec rule PROTO-FLOW-SIGNAL-001 (learning-signal payload contracts) — docs/spec/RULES.md.
describe("learning-signal events", () => {
  it("accepts the five learning-signal event types", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "t", mode: "auto", conversationId: "c", riskLevel: "read_only",
    });
    const attribution: Attribution = {
      flow_revision: "sha256:plan",
      prompt_revision: "sha256:prompt",
      tool_schema_revision: "sha256:tools",
      capability_revisions: { "equity.deliver": "v3" },
      resolver_revision: "v1",
      authorization_revision: "sha256:auth",
    };
    const paramResolved: ParamResolvedPayload = {
      flow_id: "f", flow_revision: "sha256:plan", field: "company_id",
      candidate_value: "8821", final_value: "88214",
      resolution: "edited", source: "agent_extracted",
      evidence_ref: "evt_1", context: "权益交付",
    };
    const recommended: FlowRecommendedPayload = {
      flow_id: "f", flow_revision: "sha256:plan",
      match_reason: "repeated task shape", confidence: 0.82,
    };
    const rejected: FlowRejectedPayload = {
      flow_id: "f", reason: "wrong_intent", user_chose: "freeform",
    };
    const failed: VerificationFailedPayload = {
      step_id: "deliver", category: "verification",
      postcondition: "output.equity_order_id != null",
      actual: {}, truncated: false,
    };
    const snapshot: RunSnapshotPayload = {
      flow_id: "f", flow_revision: "sha256:plan",
      resolved_inputs: [{
        field: "company_id", value: "88214", source: "user",
        resolver_version: "v1",
      }],
      steps: [{
        step_id: "deliver", capability_id: "equity.deliver",
        capability_revision: "v3", output_ref: "artifact://a1",
        verification_status: "passed",
      }],
      outcome: "succeeded",
      attribution,
    };
    for (const [type, payload] of [
      ["PARAM_RESOLVED", paramResolved],
      ["FLOW_RECOMMENDED", recommended],
      ["FLOW_REJECTED", rejected],
      ["VERIFICATION_FAILED", failed],
      ["RUN_SNAPSHOT", snapshot],
    ] as const) {
      const event = store.appendEvent({ workItemId: item.id, type, actor: "system", payload: payload as unknown as Record<string, unknown> });
      expect(event.type).toBe(type);
    }
    store.close();
  });

  it("rejects FLOW_REJECTED with a non-enum reason at the type level", () => {
    const bad: FlowRejectedPayload = {
      flow_id: "f",
      // @ts-expect-error reason must be the enum, not free text
      reason: "didn't feel like it",
    };
    expect(bad.flow_id).toBe("f");
  });
});
