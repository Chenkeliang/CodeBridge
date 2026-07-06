import type { AgentEvent } from "@feishu-code-bridge/core";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

function textFromContent(content: {
  type: string;
  text?: string;
}): string | undefined {
  if (content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  return undefined;
}

/** Map ACP session/update payloads to bridge AgentEvent stream. */
export function mapSessionUpdate(update: SessionUpdate): AgentEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textFromContent(update.content);
      return text ? [{ type: "text_delta", text }] : [];
    }
    case "agent_thought_chunk": {
      const text = textFromContent(update.content);
      return text ? [{ type: "thought_delta", text }] : [];
    }
    case "tool_call": {
      const name = update.title || update.kind || "tool";
      return [
        {
          type: "tool_start",
          name,
          input: update.rawInput ?? update,
        },
      ];
    }
    case "tool_call_update": {
      if (update.status === "completed" || update.status === "failed") {
        const name = update.title || update.kind || "tool";
        return [
          {
            type: "tool_end",
            name,
            output: update.rawOutput ?? update,
          },
        ];
      }
      return [];
    }
    default:
      return [];
  }
}
