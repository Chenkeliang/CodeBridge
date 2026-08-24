import { Hono } from "hono";
import type {
  SkillAssignmentInput,
  SkillAssignmentPreview,
  SkillAssignmentResult,
  SkillCatalogSnapshot,
} from "@codebridge/runner-client";

const SKILL_AGENT_IDS = new Set(["codex", "claude", "cursor", "opencode", "pi"]);

export interface SkillRunner {
  listSkills(): Promise<SkillCatalogSnapshot>;
  addSkillSource(sourcePath: string): Promise<SkillCatalogSnapshot>;
  previewSkillAssignment(input: SkillAssignmentInput): Promise<SkillAssignmentPreview>;
  applySkillAssignment(input: SkillAssignmentInput): Promise<SkillAssignmentResult>;
  pickDirectory(): Promise<{
    ok: boolean;
    path?: string;
    cancelled?: boolean;
    error?: string;
  }>;
}

export function createSkillApp(runner: SkillRunner, token: string) {
  const app = new Hono();
  app.use("/v1/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/v1/skills", async (c) => {
    try {
      return c.json(await runner.listSkills());
    } catch (error) {
      return runnerErrorResponse(c, error);
    }
  });

  app.post("/v1/skills/sources", async (c) => {
    const body = await c.req.json().catch(() => null) as { path?: unknown } | null;
    if (!body || typeof body.path !== "string" || !body.path.trim()) {
      return c.json({ error: "invalid_skill_source", message: "path is required" }, 400);
    }
    try {
      return c.json(await runner.addSkillSource(body.path.trim()));
    } catch (error) {
      return runnerErrorResponse(c, error);
    }
  });

  app.post("/v1/skills/sources/pick", async (c) => {
    try {
      const picked = await runner.pickDirectory();
      if (picked.cancelled) return c.json({ cancelled: true });
      if (!picked.ok || !picked.path) {
        return c.json({
          error: "directory_picker_failed",
          message: picked.error ?? "目录选择失败",
        }, 503);
      }
      return c.json(await runner.addSkillSource(picked.path));
    } catch (error) {
      return runnerErrorResponse(c, error);
    }
  });

  app.post("/v1/skills/assignments/preview", async (c) => {
    const input = await readAssignment(c);
    if (!input) return c.json({ error: "invalid_skill_assignment" }, 400);
    try {
      return c.json(await runner.previewSkillAssignment(input));
    } catch (error) {
      return runnerErrorResponse(c, error);
    }
  });

  app.post("/v1/skills/assignments/apply", async (c) => {
    const input = await readAssignment(c);
    if (!input) return c.json({ error: "invalid_skill_assignment" }, 400);
    try {
      return c.json(await runner.applySkillAssignment(input));
    } catch (error) {
      return runnerErrorResponse(c, error);
    }
  });

  return app;
}

async function readAssignment(c: {
  req: { json: () => Promise<unknown> };
}): Promise<SkillAssignmentInput | null> {
  const body = await c.req.json().catch(() => null) as {
    skill_id?: unknown;
    agent_id?: unknown;
    enabled?: unknown;
  } | null;
  if (
    !body
    || typeof body.skill_id !== "string"
    || !body.skill_id.trim()
    || typeof body.agent_id !== "string"
    || !SKILL_AGENT_IDS.has(body.agent_id)
    || typeof body.enabled !== "boolean"
  ) {
    return null;
  }
  return {
    skill_id: body.skill_id.trim(),
    agent_id: body.agent_id as SkillAssignmentInput["agent_id"],
    enabled: body.enabled,
  };
}

function runnerErrorResponse(
  c: { json: (body: unknown, status?: number) => Response },
  error: unknown,
) {
  const value = error as { status?: unknown; code?: unknown; message?: unknown };
  const status = value?.status === 400 || value?.status === 404 || value?.status === 409
    ? value.status
    : 503;
  const code = typeof value?.code === "string" ? value.code : "runner_unavailable";
  const message = typeof value?.message === "string" ? value.message : String(error);
  return c.json({ error: code, message }, status);
}
