import { describe, expect, it, vi } from "vitest";
import { createSkillApp } from "./skill-api.js";

const TOKEN = "skill-api-token";

function fixture(overrides: Record<string, unknown> = {}) {
  const snapshot = {
    skills: [],
    targets: [],
    summary: { total: 0, sources: 0, linked: 0, issues: 0 },
    scanned_at: "2026-08-24T00:00:00.000Z",
  };
  const runner = {
    listSkills: vi.fn().mockResolvedValue(snapshot),
    addSkillSource: vi.fn().mockResolvedValue(snapshot),
    previewSkillAdopt: vi.fn().mockResolvedValue({ plan_id: "plan-1", kind: "adopt" }),
    previewSkillAssignment: vi.fn().mockResolvedValue({ plan_id: "plan-1", kind: "assignment" }),
    previewSkillGlobalState: vi.fn().mockResolvedValue({ plan_id: "plan-1", kind: "global_state" }),
    previewSkillUnmanage: vi.fn().mockResolvedValue({ plan_id: "plan-1", kind: "unmanage" }),
    applySkillPlan: vi.fn().mockResolvedValue({ plan_id: "plan-1", transaction_id: "tx-1", snapshot }),
    pickDirectory: vi.fn().mockResolvedValue({ ok: true, path: "/picked/skill" }),
    ...overrides,
  };
  return { app: createSkillApp(runner as never, TOKEN), runner, snapshot };
}

const headers = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
};

describe("Skill Bridge API", () => {
  it("protects and proxies scan, source, previews, and plan apply", async () => {
    const { app, runner, snapshot } = fixture();
    expect((await app.request("/v1/skills")).status).toBe(401);

    const list = await app.request("/v1/skills", { headers });
    expect(await list.json()).toEqual(snapshot);

    const source = await app.request("/v1/skills/sources", {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "/source" }),
    });
    expect(source.status).toBe(200);
    expect(runner.addSkillSource).toHaveBeenCalledWith("/source");

    const adopt = await app.request("/v1/skills/skill-1/adopt/preview", {
      method: "POST",
      headers,
    });
    expect(adopt.status).toBe(200);
    expect(runner.previewSkillAdopt).toHaveBeenCalledWith("skill-1", "local:web");

    const input = { skill_id: "skill-1", agent_id: "claude", enabled: true };
    const preview = await app.request("/v1/skills/assignments/preview", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    expect(preview.status).toBe(200);
    expect(runner.previewSkillAssignment).toHaveBeenCalledWith({ ...input, actor_id: "local:web" });

    const apply = await app.request("/v1/skills/assignment-plans/plan-1/apply", {
      method: "POST",
      headers,
    });
    expect(apply.status).toBe(200);
    expect(runner.applySkillPlan).toHaveBeenCalledWith("assignment", "plan-1", "local:web");
  });

  it("uses the Runner-native picker before adopting a Source", async () => {
    const { app, runner } = fixture();
    const response = await app.request("/v1/skills/sources/pick", {
      method: "POST",
      headers,
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(runner.pickDirectory).toHaveBeenCalledOnce();
    expect(runner.addSkillSource).toHaveBeenCalledWith("/picked/skill");
  });

  it("returns cancellation without adding a Source", async () => {
    const { app, runner } = fixture({
      pickDirectory: vi.fn().mockResolvedValue({ ok: false, cancelled: true }),
    });
    const response = await app.request("/v1/skills/sources/pick", {
      method: "POST",
      headers,
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true });
    expect(runner.addSkillSource).not.toHaveBeenCalled();
  });

  it("preserves structured Runner errors and validates request bodies", async () => {
    const conflict = Object.assign(new Error("target occupied"), {
      status: 409,
      code: "skill_target_conflict",
    });
    const { app } = fixture({ applySkillPlan: vi.fn().mockRejectedValue(conflict) });

    const malformed = await app.request("/v1/skills/assignments/preview", {
      method: "POST",
      headers,
      body: JSON.stringify({ skill_id: "skill-1" }),
    });
    expect(malformed.status).toBe(400);

    const response = await app.request("/v1/skills/assignment-plans/plan-1/apply", {
      method: "POST",
      headers,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "skill_target_conflict",
      message: "target occupied",
    });
  });
});
