import { ApiError, api } from "./api.js";
import type { SendMessageInput, SubmitTurnReceipt } from "./types.js";

export async function submitSessionMessage(input: {
  send: typeof api.sendMessage;
  lookup: typeof api.submission;
  sessionId: string;
  idempotencyKey: string;
  input: Omit<SendMessageInput, "idempotencyKey">;
}): Promise<
  | { kind: "accepted"; receipt: SubmitTurnReceipt }
  | { kind: "rejected"; error: ApiError }
  | { kind: "unknown"; idempotencyKey: string }
> {
  const request = { ...input.input, idempotencyKey: input.idempotencyKey };
  try {
    return { kind: "accepted", receipt: await input.send(input.sessionId, request) };
  } catch (error) {
    if (error instanceof ApiError) return { kind: "rejected", error };
  }
  try {
    return { kind: "accepted", receipt: await input.send(input.sessionId, request) };
  } catch (error) {
    if (error instanceof ApiError) return { kind: "rejected", error };
  }
  try {
    return { kind: "accepted", receipt: await input.lookup(input.sessionId, input.idempotencyKey) };
  } catch {
    return { kind: "unknown", idempotencyKey: input.idempotencyKey };
  }
}
