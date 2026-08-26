import { describe, expect, it } from "vitest";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import type { Tool } from "@earendil-works/pi-ai";
import {
  FLOW_SAVE_NO_SOURCE_MESSAGE,
  PI_FLOW_SAVE_TOOL_NAME,
  FLOW_SAVE_TOOL_MARKER,
  FLOW_SAVE_TOOL_NAME,
} from "@codebridge/core";
import { createPiFlowSaveTool } from "./pi-flow-save-tool.js";

async function execute(
  available: boolean,
  input: Record<string, unknown> = { source_scope: "previous_completed_run" },
) {
  const tool = createPiFlowSaveTool(available
    ? { available: true }
    : {
        available: false,
        code: "no_extractable_previous_run",
        message: FLOW_SAVE_NO_SOURCE_MESSAGE,
      });
  return tool.execute("tool-1", input as never, undefined, undefined, {} as never);
}

describe("Pi Flow save request tool", () => {
  it("projects the shared name, description, and closed input schema", () => {
    const tool = createPiFlowSaveTool({ available: true });

    expect(FLOW_SAVE_TOOL_NAME).toBe("codebridge.request_flow_save");
    expect(tool.name).toBe(PI_FLOW_SAVE_TOOL_NAME);
    expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(FLOW_SAVE_TOOL_NAME).not.toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(tool.description).toContain("明确");
    expect(tool.description).toContain("确认入口由客户端展示");
    expect(tool.promptGuidelines).toEqual(expect.arrayContaining([
      expect.stringContaining("Never claim the current chat can confirm"),
    ]));
    expect(tool.description).not.toContain("已保存");
    expect(tool.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["source_scope"],
      properties: {
        source_scope: { const: "previous_completed_run" },
        intent_summary: { maxLength: 240 },
        name_hint: { maxLength: 80 },
      },
    });
  });

  it("survives the real OpenAI Responses provider tool conversion", () => {
    const tool = createPiFlowSaveTool({ available: true });
    const converted = convertResponsesTools([{
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    } as Tool]);

    expect(converted).toEqual([
      expect.objectContaining({
        type: "function",
        name: PI_FLOW_SAVE_TOOL_NAME,
      }),
    ]);
  });

  it("returns the canonical accepted marker without mutating external state", async () => {
    const result = await execute(true, {
      source_scope: "previous_completed_run",
      intent_summary: "以后复用",
    });

    expect(result.details).toEqual({
      codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
      accepted: true,
      source_scope: "previous_completed_run",
    });
    expect(result.content).toEqual([{
      type: "text",
      text: JSON.stringify(result.details),
    }]);
  });

  it("returns the fixed Turn-menu fallback when no prior source exists", async () => {
    const result = await execute(false);

    expect(result.details).toEqual({
      codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
      accepted: false,
      source_scope: "previous_completed_run",
      code: "no_extractable_previous_run",
      message: FLOW_SAVE_NO_SOURCE_MESSAGE,
    });
  });

  it("rejects arbitrary Run identifiers even if an adapter bypasses schema validation", async () => {
    await expect(execute(true, {
      source_scope: "previous_completed_run",
      run_id: "run_forbidden",
    })).rejects.toThrow();
  });
});
