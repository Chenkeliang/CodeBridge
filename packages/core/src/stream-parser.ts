import type { AgentEvent } from "./types.js";

/** Parse a single JSON line from agent CLI stream-json output. */
export function parseStreamJsonLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    return mapStreamObject(obj);
  } catch {
    return [];
  }
}

function mapStreamObject(obj: Record<string, unknown>): AgentEvent[] {
  const type = obj.type as string | undefined;
  if (!type) return [];

  if (type === "system" && obj.subtype === "init") {
    const sessionId = obj.session_id as string | undefined;
    if (sessionId) return [{ type: "session", sessionId }];
    return [];
  }

  if (type === "assistant") {
    const text = extractAssistantText(obj);
    if (text) return [{ type: "text_delta", text }];
  }

  if (type === "content_block_delta") {
    const text =
      (obj.text as string) ??
      ((obj.delta as Record<string, unknown>)?.text as string) ??
      "";
    if (text) return [{ type: "text_delta", text }];
  }

  if (type === "tool_call") {
    const subtype = obj.subtype as string | undefined;
    const toolCall = obj.tool_call as Record<string, unknown> | undefined;
    const name = toolCallName(toolCall) ?? "tool";
    if (subtype === "started") {
      return [{ type: "tool_start", name, input: toolCall }];
    }
    if (subtype === "completed") {
      return [{ type: "tool_end", name, output: toolCall }];
    }
    return [{ type: "tool_start", name, input: toolCall }];
  }

  if (type === "tool_use") {
    const name = (obj.name as string) ?? "tool";
    return [{ type: "tool_start", name, input: obj.input }];
  }

  if (type === "tool_result") {
    const name = (obj.name as string) ?? "tool";
    return [{ type: "tool_end", name, output: obj.output }];
  }

  if (type === "session" || type === "thread.started") {
    const sessionId =
      (obj.session_id as string) ??
      (obj.sessionId as string) ??
      (obj.thread_id as string);
    if (sessionId) return [{ type: "session", sessionId }];
  }

  if (type === "result" || type === "completion") {
    const sessionId =
      (obj.session_id as string) ?? (obj.sessionId as string);
    const events: AgentEvent[] = [];
    if (sessionId) events.push({ type: "session", sessionId });
    // stream-json + --stream-partial-output 已在 assistant/delta 中流式输出正文；
    // result 里的全文会重复，此处只发 done。
    const isError = obj.is_error === true;
    events.push({
      type: "done",
      exitCode: isError ? 1 : ((obj.exit_code as number) ?? 0),
    });
    return events;
  }

  if (type === "error") {
    return [
      {
        type: "error",
        message: (obj.message as string) ?? String(obj.error ?? "unknown"),
        fatal: true,
      },
    ];
  }

  if (obj.role === "assistant" && typeof obj.content === "string") {
    return [{ type: "text_delta", text: obj.content }];
  }

  return [];
}

function extractAssistantText(obj: Record<string, unknown>): string {
  const direct = obj.text as string | undefined;
  if (direct) return direct;

  const message = obj.message as
    | { content?: string | Array<{ type?: string; text?: string }> }
    | undefined;
  if (!message?.content) return "";

  if (typeof message.content === "string") return message.content;

  return message.content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text!)
    .join("");
}

function toolCallName(toolCall?: Record<string, unknown>): string | undefined {
  if (!toolCall) return undefined;
  for (const key of Object.keys(toolCall)) {
    const entry = toolCall[key] as { description?: string } | undefined;
    if (entry?.description) return entry.description;
    if (key.endsWith("ToolCall")) {
      return key.replace(/ToolCall$/, "");
    }
  }
  return undefined;
}

export async function* parseStreamFromReader(
  reader: AsyncIterable<string>,
): AsyncGenerator<AgentEvent> {
  for await (const line of reader) {
    for (const event of parseStreamJsonLine(line)) {
      yield event;
    }
  }
}
