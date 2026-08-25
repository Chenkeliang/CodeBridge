import { describe, expect, it } from "vitest";
import type { TimelineBlockView } from "@/lib/types";
import {
  flowSaveCommandId,
  reconcileFlowSaveCommands,
  type FlowSaveCommandRecord,
} from "./flow-save-command-state.js";

function saveBlock(input: {
  requestId?: string;
  sessionId?: string;
  sourceRunId?: string;
  status?: string;
  sequence?: unknown;
} = {}): TimelineBlockView {
  return {
    block_id: `flow_save:${input.requestId ?? "fsr_one"}`,
    block_index: 0,
    kind: "flow_save_request",
    status: input.status ?? "pending",
    metadata: {
      request_id: input.requestId ?? "fsr_one",
      session_id: input.sessionId ?? "sess-a",
      source_run_id: input.sourceRunId ?? "run-source",
      event_sequence: input.sequence ?? 11,
    },
    segments: [],
    next_segment_cursor: null,
  };
}

function command(key: string, startedAfterSequence = 10): FlowSaveCommandRecord {
  return { key, startedAfterSequence };
}

function applyCleanup(
  commands: Map<string, FlowSaveCommandRecord>,
  actions: Record<string, string>,
  cleanup: ReturnType<typeof reconcileFlowSaveCommands>,
) {
  for (const commandId of cleanup.commandIds) commands.delete(commandId);
  for (const requestId of cleanup.actionRequestIds) delete actions[requestId];
}

describe("reconcileFlowSaveCommands", () => {
  it("clears a request command only when its source is still canonically visible", () => {
    const visibleId = flowSaveCommandId("sess-a", "request", "run-visible");
    const paginatedId = flowSaveCommandId("sess-a", "request", "run-paginated");
    const commands = new Map([
      [visibleId, command("visible")],
      [paginatedId, command("paginated")],
    ]);
    const actions = { fsr_visible: "keep", fsr_paginated: "keep" };

    const cleanup = reconcileFlowSaveCommands({
      sessionId: "sess-a",
      commands,
      blocks: [
        saveBlock({ requestId: "fsr_visible", sourceRunId: "run-visible", sequence: 11 }),
        saveBlock({ requestId: "fsr_paginated", sourceRunId: "run-paginated", sequence: 12 }),
      ],
      canonicalRunIds: new Set(["run-visible"]),
    });
    applyCleanup(commands, actions, cleanup);

    expect(commands.has(visibleId)).toBe(false);
    expect(commands.has(paginatedId)).toBe(true);
    expect(actions).toEqual({ fsr_visible: "keep", fsr_paginated: "keep" });
  });

  it("reconciles terminal confirm and dismiss commands even when the source Turn paginated out", () => {
    const confirmId = flowSaveCommandId("sess-a", "confirm", "fsr_one");
    const dismissId = flowSaveCommandId("sess-a", "dismiss", "fsr_one");
    const unrelatedId = flowSaveCommandId("sess-a", "confirm", "fsr_other");
    const commands = new Map([
      [confirmId, command("confirm")],
      [dismissId, command("dismiss")],
      [unrelatedId, command("other")],
    ]);
    const actions = { fsr_one: "retry", fsr_other: "keep" };

    const cleanup = reconcileFlowSaveCommands({
      sessionId: "sess-a",
      commands,
      blocks: [saveBlock({ status: "completed", sourceRunId: "run-paginated", sequence: 11 })],
      canonicalRunIds: new Set(),
    });
    applyCleanup(commands, actions, cleanup);

    expect(commands.has(confirmId)).toBe(false);
    expect(commands.has(dismissId)).toBe(false);
    expect(commands.has(unrelatedId)).toBe(true);
    expect(actions).toEqual({ fsr_other: "keep" });
  });

  it.each([
    ["old terminal", saveBlock({ status: "dismissed", sequence: 10 })],
    ["foreign session", saveBlock({ status: "dismissed", sessionId: "sess-b", sequence: 11 })],
    ["foreign request", saveBlock({ requestId: "fsr_other", status: "dismissed", sequence: 11 })],
    ["missing sequence", saveBlock({ status: "dismissed", sequence: Number.NaN })],
  ])("does not clear commands or action state for %s", (_label, block) => {
    const confirmId = flowSaveCommandId("sess-a", "confirm", "fsr_one");
    const commands = new Map([[confirmId, command("confirm")]]);
    const actions = { fsr_one: "retry" };

    const cleanup = reconcileFlowSaveCommands({
      sessionId: "sess-a",
      commands,
      blocks: [block],
      canonicalRunIds: new Set(["run-source"]),
    });
    applyCleanup(commands, actions, cleanup);

    expect(commands.get(confirmId)).toEqual(command("confirm"));
    expect(actions).toEqual({ fsr_one: "retry" });
  });
});
