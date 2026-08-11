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
  toolKind?: string;
  input?: unknown;
  output?: unknown;
  locations?: Array<{ path: string; line?: number | null }>;
  runId: string | null;
}

export interface WorkTextProjection {
  kind: "commentary" | "thought";
  content: string;
}

export interface WorkProjection {
  kind: "work";
  id: string;
  entries: Array<WorkTextProjection | ToolProjection>;
  startedAt: string;
  endedAt: string;
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
  | WorkProjection
  | UserProjection
  | PlanProjection
  | ApprovalProjection
  | ErrorProjection;

type AgentEvent = Record<string, unknown> & { type?: string };

export function reduceConversationEvents(events: ConversationEvent[]): ConversationProjection[] {
  const projection: ConversationProjection[] = [];
  const toolsById = new Map<string, ToolProjection>();
  let activeAssistant: AssistantProjection | undefined;
  let activeWork: WorkProjection | undefined;

  const ensureWork = (event: ConversationEvent): WorkProjection => {
    if (!activeWork) {
      activeWork = {
        kind: "work",
        id: event.event_id,
        entries: [],
        startedAt: event.occurred_at,
        endedAt: event.occurred_at,
        runId: event.run_id,
      };
      projection.push(activeWork);
    }
    activeWork.endedAt = event.occurred_at;
    activeAssistant = undefined;
    return activeWork;
  };

  for (const event of normalizeConversationEvents(events)) {
    if (event.type === "MESSAGE_RECEIVED" && typeof event.payload?.message === "string") {
      activeAssistant = undefined;
      activeWork = undefined;
      projection.push({ kind: "user", content: event.payload.message, eventId: event.event_id });
      continue;
    }
    const agentEvent = event.payload?.event;
    if (!agentEvent || typeof agentEvent !== "object") continue;
    const value = agentEvent as AgentEvent;
    if (value.type === "text_delta" && typeof value.text === "string") {
      const phase = value.phase === "commentary" ? "commentary" : "final_answer";
      if (phase === "commentary") {
        const work = ensureWork(event);
        const current = work.entries.at(-1);
        if (current?.kind === "commentary") current.content += value.text;
        else work.entries.push({ kind: "commentary", content: value.text });
      } else {
        activeWork = undefined;
        if (activeAssistant?.phase === phase && activeAssistant.runId === event.run_id) {
          activeAssistant.content += value.text;
        } else {
          activeAssistant = { kind: "assistant", content: value.text, phase, runId: event.run_id };
          projection.push(activeAssistant);
        }
      }
      continue;
    }
    if (value.type === "thought_delta" && typeof value.text === "string") {
      const work = ensureWork(event);
      const current = work.entries.at(-1);
      if (current?.kind === "thought") current.content += value.text;
      else work.entries.push({ kind: "thought", content: value.text });
      continue;
    }
    if (value.type === "tool_start" || value.type === "tool_update" || value.type === "tool_end") {
      const work = ensureWork(event);
      const id = typeof value.toolCallId === "string" ? value.toolCallId : `${event.run_id ?? "run"}:${projection.length}`;
      const current = toolsById.get(id);
      if (current) {
        if (typeof value.name === "string") current.name = value.name;
        if (typeof value.kind === "string") current.toolKind = value.kind;
        if (value.input !== undefined) current.input = value.input;
        if (value.output !== undefined) current.output = value.output;
        if (Array.isArray(value.locations)) current.locations = toolLocations(value.locations);
        if (typeof value.status === "string") current.status = value.status;
        if (value.type === "tool_end" && typeof value.status !== "string") current.status = "completed";
      } else {
        const next: ToolProjection = {
          kind: "tool",
          id,
          name: typeof value.name === "string" ? value.name : "Tool",
          status: value.type === "tool_end" ? (typeof value.status === "string" ? value.status : "completed") : "running",
          toolKind: typeof value.kind === "string" ? value.kind : undefined,
          input: value.input,
          output: value.output,
          locations: Array.isArray(value.locations) ? toolLocations(value.locations) : undefined,
          runId: event.run_id,
        };
        toolsById.set(id, next);
        work.entries.push(next);
      }
      continue;
    }
    if (value.type === "plan" && Array.isArray(value.entries)) {
      activeAssistant = undefined;
      activeWork = undefined;
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
      activeAssistant = undefined;
      activeWork = undefined;
      projection.push({ kind: "approval", requestId: value.requestId, title: value.title, runId: event.run_id });
      continue;
    }
    if (value.type === "error" && typeof value.message === "string") {
      activeAssistant = undefined;
      activeWork = undefined;
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

function normalizeConversationEvents(events: ConversationEvent[]): ConversationEvent[] {
  const deduplicated: ConversationEvent[] = [];
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const previous = deduplicated.at(-1);
    if (previous && isHydratedTextDuplicate(previous, event)) {
      const previousValue = agentEventValue(previous);
      const currentValue = agentEventValue(event);
      if (typeof currentValue?.messageId === "string" && typeof previousValue?.messageId !== "string") {
        deduplicated[deduplicated.length - 1] = event;
      }
      continue;
    }
    deduplicated.push(event);
  }

  const normalized = [...deduplicated];
  let turnStart = 0;
  for (let index = 0; index <= normalized.length; index += 1) {
    if (index < normalized.length && normalized[index].type !== "MESSAGE_RECEIVED") continue;
    inferTurnTextPhases(normalized, turnStart, index);
    turnStart = index + 1;
  }
  return normalized;
}

function isHydratedTextDuplicate(previous: ConversationEvent, current: ConversationEvent): boolean {
  const previousValue = agentEventValue(previous);
  const currentValue = agentEventValue(current);
  if (previousValue?.type !== "text_delta" || currentValue?.type !== "text_delta") return false;
  if (previous.run_id !== current.run_id || previousValue.text !== currentValue.text || previousValue.phase !== currentValue.phase) return false;
  const messageIds = [previousValue.messageId, currentValue.messageId].filter((value): value is string => typeof value === "string");
  if (messageIds.length !== 1) return false;
  return Math.abs(new Date(current.occurred_at).getTime() - new Date(previous.occurred_at).getTime()) <= 100;
}

function inferTurnTextPhases(events: ConversationEvent[], start: number, end: number): void {
  const segments: number[][] = [];
  let current: number[] = [];
  for (let index = start; index < end; index += 1) {
    const value = agentEventValue(events[index]);
    if (value?.type === "text_delta") {
      current.push(index);
      continue;
    }
    if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);
  const finalSegment = segments.at(-1);
  for (const segment of segments) {
    const phase = segment === finalSegment ? "final_answer" : "commentary";
    for (const index of segment) {
      const event = events[index];
      const value = agentEventValue(event);
      if (!value || value.phase === "commentary" || value.phase === "final_answer") continue;
      events[index] = {
        ...event,
        payload: {
          ...event.payload,
          event: { ...value, phase },
        },
      };
    }
  }
}

function agentEventValue(event: ConversationEvent): AgentEvent | undefined {
  const value = event.payload?.event;
  return value && typeof value === "object" ? value as AgentEvent : undefined;
}

export function describeTool(
  tool: Pick<ToolProjection, "name" | "input" | "locations">,
  cwd?: string | null,
): { category: "command" | "file" | "tool"; label: string; target?: string } {
  const name = tool.name.toLowerCase();
  const input = tool.input && typeof tool.input === "object" ? tool.input as Record<string, unknown> : {};
  const command = stringValue(input.cmd) ?? stringValue(input.command);
  if (command || ["exec", "shell", "terminal", "command"].some((value) => name.includes(value))) {
    return { category: "command", label: "Ran command", ...(command ? { target: command } : {}) };
  }
  const rawPath = tool.locations?.[0]?.path
    ?? stringValue(input.path)
    ?? stringValue(input.file_path)
    ?? stringValue(input.filePath);
  if (rawPath || ["read", "write", "edit", "file"].some((value) => name.includes(value))) {
    const target = rawPath && cwd && !isAbsolutePath(rawPath)
      ? `${cwd.replace(/[\\/]+$/, "")}/${rawPath.replace(/^[\\/]+/, "")}`
      : rawPath;
    return { category: "file", label: fileToolLabel(name), ...(target ? { target } : {}) };
  }
  return { category: "tool", label: `Used ${tool.name}` };
}

function fileToolLabel(name: string): string {
  if (name.includes("read")) return "Read file";
  if (name.includes("write") || name.includes("create")) return "Wrote file";
  if (name.includes("edit") || name.includes("patch")) return "Edited file";
  return "Used file";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function toolLocations(values: unknown[]): Array<{ path: string; line?: number | null }> {
  return values.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const location = value as { path?: unknown; line?: unknown };
    if (typeof location.path !== "string") return [];
    return [{ path: location.path, ...(typeof location.line === "number" || location.line === null ? { line: location.line } : {}) }];
  });
}
