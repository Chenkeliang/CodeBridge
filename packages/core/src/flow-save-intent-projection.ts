const FLOW_SAVE_STATUS_BY_TYPE = {
  FLOW_SAVE_REQUESTED: "pending",
  FLOW_SAVE_DISMISSED: "dismissed",
  FLOW_CANDIDATE_CREATED: "completed",
  FLOW_SAVE_FAILED: "failed",
} as const;

const DISPLAY_FIELD_LIMIT_BYTES = 2_048;
const IDENTITY_FIELDS = [
  "session_id",
  "request_turn_id",
  "request_run_id",
  "source_turn_id",
  "source_run_id",
  "source",
  "created_at",
  "flow_id",
  "definition_revision",
] as const;
const DISPLAY_FIELDS = ["user_message", "intent_summary", "name_hint"] as const;

export interface FlowSaveIntentProjectionInput {
  type: string;
  sequence: number;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface FlowSaveIntentProjection {
  requestId: string;
  status: typeof FLOW_SAVE_STATUS_BY_TYPE[keyof typeof FLOW_SAVE_STATUS_BY_TYPE];
  metadata: Record<string, unknown>;
}

export function flowSaveIntentProjection(
  event: FlowSaveIntentProjectionInput,
): FlowSaveIntentProjection | null {
  const status = FLOW_SAVE_STATUS_BY_TYPE[
    event.type as keyof typeof FLOW_SAVE_STATUS_BY_TYPE
  ];
  const requestId = event.payload.request_id;
  if (!status || typeof requestId !== "string" || !requestId) return null;

  const metadata: Record<string, unknown> = {
    request_id: requestId,
    status,
    event_sequence: event.sequence,
    updated_at: event.occurredAt,
  };
  for (const field of IDENTITY_FIELDS) {
    const value = event.payload[field];
    if (typeof value === "string" && value) metadata[field] = value;
  }
  if (typeof event.payload.source_imported === "boolean") {
    metadata.source_imported = event.payload.source_imported;
  }

  let truncated = false;
  for (const field of DISPLAY_FIELDS) {
    const value = event.payload[field];
    if (value === null) {
      metadata[field] = null;
      continue;
    }
    if (typeof value !== "string") continue;
    const bounded = truncateUtf8(value, DISPLAY_FIELD_LIMIT_BYTES);
    metadata[field] = bounded.value;
    truncated ||= bounded.truncated;
  }

  const errorCode = typeof event.payload.error_code === "string"
    ? event.payload.error_code
    : typeof event.payload.code === "string"
      ? event.payload.code
      : null;
  if (errorCode) {
    metadata.code = errorCode;
    metadata.error_code = errorCode;
  }
  if (truncated) metadata.truncated = true;
  return { requestId, status, metadata };
}

function truncateUtf8(
  value: string,
  maximumBytes: number,
): { value: string; truncated: boolean } {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const characterBytes = codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
          ? 3
          : 4;
    if (bytes + characterBytes > maximumBytes) {
      return { value: value.slice(0, end), truncated: true };
    }
    bytes += characterBytes;
    end += character.length;
  }
  return { value, truncated: false };
}
