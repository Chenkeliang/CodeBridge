import type { FlowRecord } from "./types";

export function flowRunMessage(draft: string, flow: FlowRecord): string {
  const text = draft.trim();
  return text || `运行 ${flow.name || flow.flow_id}`;
}

export function defaultsFromFlow(flow: FlowRecord): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const input of flow.inputs) {
    if (input.default !== undefined) values[input.id] = input.default;
  }
  return values;
}