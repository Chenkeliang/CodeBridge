import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  FLOW_SAVE_SOURCE_SCOPE,
  FLOW_SAVE_TOOL_DESCRIPTION,
  PI_FLOW_SAVE_TOOL_NAME,
  flowSaveToolOutput,
  parseRequestFlowSaveInput,
  type FlowSaveSourceAvailability,
} from "@codebridge/core";

export function createPiFlowSaveTool(
  availability: FlowSaveSourceAvailability,
) {
  return defineTool({
    name: PI_FLOW_SAVE_TOOL_NAME,
    label: "Request Flow Save",
    description: FLOW_SAVE_TOOL_DESCRIPTION,
    promptSnippet: "Request a user-confirmed Flow save only after explicit save intent.",
    promptGuidelines: [
      "Use this tool only when the user explicitly asks to save a reusable Flow.",
      "Do not use it for ordinary file or result saving, and do not claim a Flow was created.",
    ],
    parameters: Type.Object({
      source_scope: Type.Literal(FLOW_SAVE_SOURCE_SCOPE),
      intent_summary: Type.Optional(Type.String({ maxLength: 240 })),
      name_hint: Type.Optional(Type.String({ maxLength: 80 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      parseRequestFlowSaveInput(params);
      const output = flowSaveToolOutput(availability);
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        details: output,
      };
    },
  });
}
