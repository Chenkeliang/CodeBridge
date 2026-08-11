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

export type ConversationProjection = AssistantProjection | ToolProjection;

type AgentEvent = Record<string, unknown> & { type?: string };

export function reduceConversationEvents(events: ConversationEvent[]): ConversationProjection[] {
  const projection: ConversationProjection[] = [];
  const assistantByKey = new Map<string, AssistantProjection>();
  const toolsById = new Map<string, ToolProjection>();

  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
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
    }
  }
  return projection;
}
