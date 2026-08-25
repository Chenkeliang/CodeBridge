export interface SessionEventWire {
  schema_version: 1;
  event_id: string;
  sequence: number;
  work_item_id: string;
  run_id: string | null;
  type: string;
  occurred_at: string;
  actor: string;
  target: string | null;
  input_hash: string | null;
  result_ref: string | null;
  payload: Record<string, unknown>;
}

export function parseSessionEventWire(input: unknown): SessionEventWire {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("session_event_schema_mismatch");
  }
  const event = input as Record<string, unknown>;
  if (
    event.schema_version !== 1
    || typeof event.event_id !== "string"
    || !Number.isInteger(event.sequence)
    || typeof event.work_item_id !== "string"
    || !(typeof event.run_id === "string" || event.run_id === null)
    || typeof event.type !== "string"
    || typeof event.occurred_at !== "string"
    || typeof event.actor !== "string"
    || !(typeof event.target === "string" || event.target === null)
    || !(typeof event.input_hash === "string" || event.input_hash === null)
    || !(typeof event.result_ref === "string" || event.result_ref === null)
    || !event.payload
    || typeof event.payload !== "object"
    || Array.isArray(event.payload)
  ) {
    throw new Error("session_event_schema_mismatch");
  }
  return event as unknown as SessionEventWire;
}
