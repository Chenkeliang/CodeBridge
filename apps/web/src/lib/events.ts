export interface ConversationEvent {
  event_id: string;
  sequence: number;
  run_id: string | null;
  type: string;
  occurred_at: string;
  payload?: Record<string, unknown>;
}

export interface AssistantProjection {
  kind: "assistant";
  content: string;
  phase: "commentary" | "final_answer";
  runId: string | null;
}

export interface ToolProjection {
  kind: "tool";
  id: string;
  name: string;
  status: string;
  input?: unknown;
  output?: unknown;
  runId: string | null;
}

export interface UserProjection {
  kind: "user";
  content: string;
  eventId: string;
}

export interface PlanEntryProjection {
  content: string;
  priority: string;
  status: string;
}

export interface PlanProjection {
  kind: "plan";
  entries: PlanEntryProjection[];
  runId: string | null;
}

export interface ApprovalProjection {
  kind: "approval";
  requestId: string;
  title: string;
  runId: string | null;
}

export interface ErrorProjection {
  kind: "error";
  content: string;
  fatal: boolean;
  runId: string | null;
}

export type ConversationProjection =
  | AssistantProjection
  | ToolProjection
  | UserProjection
  | PlanProjection
  | ApprovalProjection
  | ErrorProjection;

type AgentEvent = Record<string, unknown> & { type?: string };

export function reduceConversationEvents(events: ConversationEvent[]): ConversationProjection[] {
  const projection: ConversationProjection[] = [];
  const assistantByKey = new Map<string, AssistantProjection>();
  const toolsById = new Map<string, ToolProjection>();

  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.type === "MESSAGE_RECEIVED" && typeof event.payload?.message === "string") {
      projection.push({ kind: "user", content: event.payload.message, eventId: event.event_id });
      continue;
    }
    const agentEvent = event.payload?.event;
    if (!agentEvent || typeof agentEvent !== "object") continue;
    const value = agentEvent as AgentEvent;
    if (value.type === "text_delta" && typeof value.text === "string") {
      const phase = value.phase === "commentary" ? "commentary" : "final_answer";
      const key = `${event.run_id ?? "session"}:${phase}`;
      const current = assistantByKey.get(key);
      if (current) current.content += value.text;
      else {
        const next: AssistantProjection = { kind: "assistant", content: value.text, phase, runId: event.run_id };
        assistantByKey.set(key, next);
        projection.push(next);
      }
      continue;
    }
    if (value.type === "tool_start" || value.type === "tool_update" || value.type === "tool_end") {
      const id = typeof value.toolCallId === "string" ? value.toolCallId : `${event.run_id ?? "run"}:${projection.length}`;
      const current = toolsById.get(id);
      if (current) {
        if (typeof value.name === "string") current.name = value.name;
        if (value.input !== undefined) current.input = value.input;
        if (value.output !== undefined) current.output = value.output;
        if (typeof value.status === "string") current.status = value.status;
        if (value.type === "tool_end" && typeof value.status !== "string") current.status = "completed";
      } else {
        const next: ToolProjection = {
          kind: "tool",
          id,
          name: typeof value.name === "string" ? value.name : "Tool",
          status: value.type === "tool_end" ? (typeof value.status === "string" ? value.status : "completed") : "running",
          input: value.input,
          output: value.output,
          runId: event.run_id,
        };
        toolsById.set(id, next);
        projection.push(next);
      }
      continue;
    }
    if (value.type === "plan" && Array.isArray(value.entries)) {
      const entries = value.entries.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const item = entry as Record<string, unknown>;
        if (typeof item.content !== "string") return [];
        return [{
          content: item.content,
          priority: typeof item.priority === "string" ? item.priority : "medium",
          status: typeof item.status === "string" ? item.status : "pending",
        }];
      });
      projection.push({ kind: "plan", entries, runId: event.run_id });
      continue;
    }
    if (value.type === "permission_request" && typeof value.requestId === "string" && typeof value.title === "string") {
      projection.push({ kind: "approval", requestId: value.requestId, title: value.title, runId: event.run_id });
      continue;
    }
    if (value.type === "error" && typeof value.message === "string") {
      projection.push({
        kind: "error",
        content: value.message,
        fatal: value.fatal === true,
        runId: event.run_id,
      });
    }
  }
  return projection;
}
