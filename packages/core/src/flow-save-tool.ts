import { z } from "zod";

export const FLOW_SAVE_TOOL_MARKER = "flow_save_request/v1" as const;
export const FLOW_SAVE_TOOL_NAME = "codebridge.request_flow_save" as const;
/** Provider function names cannot contain the canonical product namespace dot. */
export const PI_FLOW_SAVE_TOOL_NAME = "codebridge_request_flow_save" as const;
export const FLOW_SAVE_SOURCE_SCOPE = "previous_completed_run" as const;
export const FLOW_SAVE_AVAILABILITY_ENV =
  "CODEBRIDGE_FLOW_SAVE_SOURCE_AVAILABILITY" as const;
export const FLOW_SAVE_NO_SOURCE_MESSAGE =
  "找不到可提取的上一次成功任务，请在目标回复的菜单中选择‘存为 Flow’。" as const;

export const FLOW_SAVE_TOOL_DESCRIPTION =
  "仅当用户明确要求将上一次已完成任务保存为可复用 Flow 时，创建一个待确认请求。此工具只表达保存意图，不创建 Candidate、不写 Flow Catalog，也不表示 Flow 已经存好。调用成功后仅说明待确认请求已记录、尚未创建 Candidate；不要声称可在当前通道或当前界面确认，确认入口由客户端展示。";

export const RequestFlowSaveInputSchema = z.object({
  source_scope: z.literal(FLOW_SAVE_SOURCE_SCOPE),
  intent_summary: z.string().max(240).optional(),
  name_hint: z.string().max(80).optional(),
}).strict();

export interface RequestFlowSaveInput {
  source_scope: typeof FLOW_SAVE_SOURCE_SCOPE;
  intent_summary?: string;
  name_hint?: string;
}

const RequestFlowSaveAcceptedOutputSchema = z.object({
  codebridge_internal_tool: z.literal(FLOW_SAVE_TOOL_MARKER),
  accepted: z.literal(true),
  source_scope: z.literal(FLOW_SAVE_SOURCE_SCOPE),
}).strict();

const RequestFlowSaveRejectedOutputSchema = z.object({
  codebridge_internal_tool: z.literal(FLOW_SAVE_TOOL_MARKER),
  accepted: z.literal(false),
  source_scope: z.literal(FLOW_SAVE_SOURCE_SCOPE),
  code: z.literal("no_extractable_previous_run"),
  message: z.literal(FLOW_SAVE_NO_SOURCE_MESSAGE),
}).strict();

export const RequestFlowSaveOutputSchema = z.discriminatedUnion("accepted", [
  RequestFlowSaveAcceptedOutputSchema,
  RequestFlowSaveRejectedOutputSchema,
]);

export type RequestFlowSaveOutput = z.infer<typeof RequestFlowSaveOutputSchema>;

export type FlowSaveSourceAvailability =
  | { available: true }
  | {
      available: false;
      code: "no_extractable_previous_run";
      message: string;
    };

export interface StdioMcpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function parseRequestFlowSaveInput(value: unknown): RequestFlowSaveInput {
  return RequestFlowSaveInputSchema.parse(value);
}

export function parseRequestFlowSaveOutput(value: unknown): RequestFlowSaveOutput {
  return RequestFlowSaveOutputSchema.parse(value);
}

export function flowSaveToolOutput(
  availability: FlowSaveSourceAvailability,
): RequestFlowSaveOutput {
  if (availability.available) {
    return {
      codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
      accepted: true,
      source_scope: FLOW_SAVE_SOURCE_SCOPE,
    };
  }
  return {
    codebridge_internal_tool: FLOW_SAVE_TOOL_MARKER,
    accepted: false,
    source_scope: FLOW_SAVE_SOURCE_SCOPE,
    code: "no_extractable_previous_run",
    message: FLOW_SAVE_NO_SOURCE_MESSAGE,
  };
}
