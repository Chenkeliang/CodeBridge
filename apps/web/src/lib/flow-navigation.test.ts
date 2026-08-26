import { describe, expect, it } from "vitest";
import type { FlowRecord } from "./types";
import { latestCandidateForSession } from "./flow-navigation";

function flow(
  flowId: string,
  status: FlowRecord["status"],
  sessionId: string | null,
  updatedAt: string,
): FlowRecord {
  return {
    flow_id: flowId,
    name: flowId,
    description: null,
    kind: "runbook",
    status,
    source: "agent_generated",
    definition_revision: `revision_${flowId}`,
    plan_ir_hash: null,
    inputs: [],
    steps: [],
    review_status: "pending",
    git_revision: null,
    validation_issues: [],
    lineage_root_flow_id: flowId,
    parent_flow_id: null,
    provenance: sessionId ? {
      source_run_id: `run_${flowId}`,
      source_session_id: sessionId,
      source_flow_id: `source_${flowId}`,
      source_definition_revision: `source_revision_${flowId}`,
    } : null,
    publication_sequence: 0,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

describe("latestCandidateForSession", () => {
  it("selects only Candidates whose provenance belongs to the Session", () => {
    const result = latestCandidateForSession([
      flow("foreign", "candidate", "sess_b", "2026-08-26T05:00:00.000Z"),
      flow("related", "candidate", "sess_a", "2026-08-26T04:00:00.000Z"),
      flow("published", "published", "sess_a", "2026-08-26T06:00:00.000Z"),
      flow("manual", "candidate", null, "2026-08-26T07:00:00.000Z"),
    ], "sess_a");
    expect(result?.flow_id).toBe("related");
  });

  it("uses updated_at descending and flow_id ascending as a stable tie-break", () => {
    expect(latestCandidateForSession([
      flow("flow_b", "candidate", "sess_a", "2026-08-26T04:00:00.000Z"),
      flow("flow_a", "candidate", "sess_a", "2026-08-26T04:00:00.000Z"),
      flow("older", "candidate", "sess_a", "2026-08-26T03:00:00.000Z"),
    ], "sess_a")?.flow_id).toBe("flow_a");
  });

  it("returns null without a Session or a related Candidate", () => {
    expect(latestCandidateForSession([], null)).toBeNull();
    expect(latestCandidateForSession([
      flow("foreign", "candidate", "sess_b", "2026-08-26T04:00:00.000Z"),
    ], "sess_a")).toBeNull();
  });
});
