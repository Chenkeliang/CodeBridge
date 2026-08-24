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
    previewSkillAssignment: vi.fn().mockResolvedValue({ action: "create_link" }),
    applySkillAssignment: vi.fn().mockResolvedValue({ action: "create_link", state: "linked" }),
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
  it("protects and proxies scan, source, preview, and apply", async () => {
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

    const input = { skill_id: "skill-1", agent_id: "codex", enabled: true };
    const preview = await app.request("/v1/skills/assignments/preview", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    expect(preview.status).toBe(200);
    expect(runner.previewSkillAssignment).toHaveBeenCalledWith(input);

    const apply = await app.request("/v1/skills/assignments/apply", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    expect(apply.status).toBe(200);
    expect(runner.applySkillAssignment).toHaveBeenCalledWith(input);
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
    const { app } = fixture({ applySkillAssignment: vi.fn().mockRejectedValue(conflict) });

    const malformed = await app.request("/v1/skills/assignments/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({ skill_id: "skill-1" }),
    });
    expect(malformed.status).toBe(400);

    const response = await app.request("/v1/skills/assignments/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({ skill_id: "skill-1", agent_id: "codex", enabled: true }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "skill_target_conflict",
      message: "target occupied",
    });
  });
});
