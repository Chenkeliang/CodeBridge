import { describe, expect, it } from "vitest";
import {
  FLOW_SAVE_NO_SOURCE_MESSAGE,
  PI_FLOW_SAVE_TOOL_NAME,
  FLOW_SAVE_TOOL_DESCRIPTION,
  FLOW_SAVE_TOOL_MARKER,
  FLOW_SAVE_TOOL_NAME,
  flowSaveToolOutput,
  parseRequestFlowSaveInput,
  parseRequestFlowSaveOutput,
} from "./flow-save-tool.js";

describe("Flow save request tool contract", () => {
  it("accepts only the previous completed Run scope and bounded hints", () => {
    expect(parseRequestFlowSaveInput({
      source_scope: "previous_completed_run",
      intent_summary: "把刚才的排查流程保存下来",
      name_hint: "订单排查",
    })).toEqual({
      source_scope: "previous_completed_run",
      intent_summary: "把刚才的排查流程保存下来",
      name_hint: "订单排查",
    });

    expect(() => parseRequestFlowSaveInput({
      source_scope: "current_run",
    })).toThrow();
    expect(() => parseRequestFlowSaveInput({
      source_scope: "previous_completed_run",
      intent_summary: "x".repeat(241),
    })).toThrow();
    expect(() => parseRequestFlowSaveInput({
      source_scope: "previous_completed_run",
      name_hint: "x".repeat(81),
    })).toThrow();
  });

  it("rejects source identifiers, Candidate fields, and extra properties", () => {
    for (const extra of [
      { run_id: "run_1" },
      { session_id: "sess_1" },
      { flow_id: "flow_1" },
      { status: "published" },
      { steps: [] },
    ]) {
      expect(() => parseRequestFlowSaveInput({
        source_scope: "previous_completed_run",
        ...extra,
      })).toThrow();
    }
  });

  it("describes an explicit-intent-only request and never claims the Flow is saved", () => {
    expect(FLOW_SAVE_TOOL_NAME).toBe("codebridge.request_flow_save");
    expect(PI_FLOW_SAVE_TOOL_NAME).toBe("codebridge_request_flow_save");
    expect(FLOW_SAVE_TOOL_MARKER).toBe("flow_save_request/v1");
    expect(FLOW_SAVE_TOOL_DESCRIPTION).toContain("明确");
    expect(FLOW_SAVE_TOOL_DESCRIPTION).toContain("保存");
    expect(FLOW_SAVE_TOOL_DESCRIPTION).not.toContain("已保存");
    expect(FLOW_SAVE_TOOL_DESCRIPTION).not.toContain("已创建");
  });

  it("strictly discriminates accepted and rejected adapter outputs", () => {
    const accepted = {
      codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
      accepted: true,
      source_scope: "previous_completed_run",
    } as const;
    const rejected = {
      codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
      accepted: false,
      source_scope: "previous_completed_run",
      code: "no_extractable_previous_run",
      message: FLOW_SAVE_NO_SOURCE_MESSAGE,
    } as const;

    expect(parseRequestFlowSaveOutput(accepted)).toEqual(accepted);
    expect(parseRequestFlowSaveOutput(rejected)).toEqual(rejected);
    for (const invalid of [
      FLOW_SAVE_TOOL_MARKER,
      { ...accepted, code: "no_extractable_previous_run" },
      { ...accepted, message: FLOW_SAVE_NO_SOURCE_MESSAGE },
      { ...rejected, code: "other" },
      { ...rejected, message: "动态错误文案" },
      { ...rejected, message: undefined },
      { ...accepted, extra: true },
    ]) {
      expect(() => parseRequestFlowSaveOutput(invalid)).toThrow();
    }
  });

  it("returns one canonical result for available and unavailable sources", () => {
    expect(flowSaveToolOutput({ available: true })).toEqual({
      codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
      accepted: true,
      source_scope: "previous_completed_run",
    });
    expect(flowSaveToolOutput({
      available: false,
      code: "no_extractable_previous_run",
      message: FLOW_SAVE_NO_SOURCE_MESSAGE,
    })).toEqual({
      codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
      accepted: false,
      source_scope: "previous_completed_run",
      code: "no_extractable_previous_run",
      message: FLOW_SAVE_NO_SOURCE_MESSAGE,
    });
  });
});
