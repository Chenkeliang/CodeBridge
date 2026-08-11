import { describe, expect, it } from "vitest";
import { isModelOption, orderSessions } from "./workbench-logic";
import type { AgentSession } from "./types";

describe("workbench logic", () => {
  it("keeps non-model Agent configuration out of the model selector", () => {
    expect(isModelOption({ id: "permission", name: "Permission", type: "select", category: "mode", values: [] })).toBe(false);
    expect(isModelOption({ id: "model", name: "Model", type: "select", category: "model", values: [] })).toBe(true);
    expect(isModelOption({ id: "legacy-model-picker", name: "Model", type: "select", values: [] })).toBe(true);
  });

  it("places pinned Sessions before the most recently updated Sessions", () => {
    const session = (id: string, updatedAt: string, pinnedAt: string | null): AgentSession => ({
      session_id: id,
      agent_id: "codex",
      provider_session_id: null,
      task_record_id: null,
      flow_id: null,
      model: null,
      cwd: null,
      additional_directories: [],
      title: id,
      status: "idle",
      pinned_at: pinnedAt,
      archived_at: null,
      created_at: updatedAt,
      updated_at: updatedAt,
    });

    const ordered = orderSessions([
      session("older", "2026-08-10T00:00:00.000Z", null),
      session("pinned", "2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z"),
      session("recent", "2026-08-11T00:00:00.000Z", null),
    ]);

    expect(ordered.map((value) => value.session_id)).toEqual(["pinned", "recent", "older"]);
  });
});
