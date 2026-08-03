import type { AgentEvent } from "@codebridge/core";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { mapSessionConfigOptions } from "./acp-config-options.js";

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
      return text
        ? [
            {
              type: "text_delta",
              text,
              ...(update.messageId ? { messageId: update.messageId } : {}),
            },
          ]
        : [];
    }
    case "agent_thought_chunk": {
      const text = textFromContent(update.content);
      return text
        ? [
            {
              type: "thought_delta",
              text,
              ...(update.messageId ? { messageId: update.messageId } : {}),
            },
          ]
        : [];
    }
    case "tool_call": {
      const name = update.title || update.kind || "tool";
      return [
        {
          type: "tool_start",
          toolCallId: update.toolCallId,
          name,
          ...(update.kind ? { kind: update.kind } : {}),
          ...(update.status ? { status: update.status } : {}),
          input: update.rawInput ?? update,
          ...(update.content ? { content: update.content } : {}),
          ...(update.locations ? { locations: update.locations } : {}),
        },
      ];
    }
    case "tool_call_update": {
      const name = update.title || update.kind;
      if (update.status === "completed" || update.status === "failed") {
        return [
          {
            type: "tool_end",
            toolCallId: update.toolCallId,
            ...(name ? { name } : {}),
            ...(update.status ? { status: update.status } : {}),
            ...(update.rawOutput !== undefined
              ? { output: update.rawOutput }
              : {}),
            ...(update.content ? { content: update.content } : {}),
            ...(update.locations ? { locations: update.locations } : {}),
          },
        ];
      }
      return [
        {
          type: "tool_update",
          toolCallId: update.toolCallId,
          ...(name ? { name } : {}),
          ...(update.status ? { status: update.status } : {}),
          ...(update.content ? { content: update.content } : {}),
          ...(update.locations ? { locations: update.locations } : {}),
          ...(update.rawOutput !== undefined
            ? { output: update.rawOutput }
            : {}),
        },
      ];
    }
    case "plan":
      return [{ type: "plan", entries: update.entries }];
    case "plan_update":
      return [{ type: "plan_update", plan: update.plan }];
    case "plan_removed":
      return [{ type: "plan_removed", planId: update.planId }];
    case "available_commands_update":
      return [
        {
          type: "available_commands_update",
          availableCommands: update.availableCommands,
        },
      ];
    case "current_mode_update":
      return [
        { type: "current_mode_update", currentModeId: update.currentModeId },
      ];
    case "config_option_update":
      return [
        {
          type: "config_option_update",
          configOptions: mapSessionConfigOptions(update.configOptions),
        },
      ];
    case "session_info_update":
      return [
        {
          type: "session_info_update",
          ...(update.title !== undefined ? { title: update.title } : {}),
          ...(update.updatedAt !== undefined
            ? { updatedAt: update.updatedAt }
            : {}),
        },
      ];
    case "usage_update":
      return [
        {
          type: "usage_update",
          used: update.used,
          size: update.size,
          ...(update.cost !== undefined ? { cost: update.cost } : {}),
        },
      ];
    default:
      return [];
  }
}
