import type { AgentEvent } from "@codebridge/core";
import type { Run } from "@codebridge/work-items";
import {
  flowSaveToolOutputFromAgentValue,
  type FlowSaveRequest,
  type FlowSaveIntentService,
} from "./flow-save-intent.js";

interface FlowSaveIntentWriter {
  requestFromTool(
    input: Parameters<FlowSaveIntentService["requestFromTool"]>[0],
  ): FlowSaveRequest;
}

export interface FlowSaveToolTranslatorOptions {
  intents: FlowSaveIntentWriter;
}

/**
 * Converts an already-persisted, accepted internal tool completion into the
 * canonical Save Intent command. Persisted correlation and strict input
 * validation remain owned by FlowSaveIntentService.
 */
export class FlowSaveToolTranslator {
  constructor(private readonly options: FlowSaveToolTranslatorOptions) {}

  translate(run: Run, event: AgentEvent): FlowSaveRequest | null {
    const toolCallId = acceptedFlowSaveToolCallId(event);
    if (!toolCallId) return null;
    if (!run.sessionId) {
      throw new Error("flow_save_session_not_found");
    }
    return this.options.intents.requestFromTool({
      sessionId: run.sessionId,
      currentRunId: run.id,
      toolCallId,
    });
  }
}

/** The single Bridge onEvent error boundary used by production and tests. */
export function createFlowSaveToolEventHandler(
  translator: FlowSaveToolTranslator,
  warn: (message: string) => void,
): (run: Run, event: AgentEvent) => FlowSaveRequest | null {
  return (run, event) => {
    try {
      return translator.translate(run, event);
    } catch (error) {
      const toolCallId = event.type === "tool_end" && event.toolCallId
        ? event.toolCallId
        : "unknown";
      warn(flowSaveTranslationWarning(run.id, toolCallId, error));
      return null;
    }
  };
}

function acceptedFlowSaveToolCallId(event: AgentEvent): string | null {
  if (
    event.type !== "tool_end"
    || event.status !== "completed"
    || typeof event.toolCallId !== "string"
    || !event.toolCallId.trim()
  ) return null;
  const result = flowSaveToolOutputFromAgentValue(event.output)
    ?? flowSaveToolOutputFromAgentValue(event.content);
  return result?.accepted === true ? event.toolCallId : null;
}

function flowSaveTranslationWarning(
  runId: string,
  toolCallId: string,
  error: unknown,
): string {
  const detail = error && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : error instanceof Error
      ? error.message
      : String(error);
  return `Flow save tool translation skipped (${runId}/${toolCallId}): ${detail}`;
}
