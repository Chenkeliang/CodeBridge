import type { FlowRecord } from "./types";

export function latestCandidateForSession(
  flows: readonly FlowRecord[],
  sessionId: string | null,
): FlowRecord | null {
  if (!sessionId) return null;
  return flows
    .filter((flow) =>
      flow.status === "candidate"
      && flow.provenance?.source_session_id === sessionId
    )
    .sort((left, right) => {
      const byUpdatedAt = right.updated_at.localeCompare(left.updated_at);
      return byUpdatedAt || left.flow_id.localeCompare(right.flow_id);
    })[0] ?? null;
}
