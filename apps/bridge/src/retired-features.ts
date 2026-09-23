import type { Hono } from "hono";

/** Reject old clients before idempotency replay or any business mutation. */
export function rejectRetiredFlowRequests(app: Hono): void {
  app.use("/v1/*", async (c, next) => {
    if (/\/v1\/(?:flows|flow-save-requests|flow-batches|flow-invocation-drafts)(?:\/|$)/.test(c.req.path)
      || /\/sessions\/[^/]+\/(?:flow|flow-proposals|flow-recommendations|flow-save-requests)(?:\/|$)/.test(c.req.path)) {
      return c.json({ error: "flow_retired" }, 410);
    }
    const executionSubmission = /^\/v1\/(?:sessions\/[^/]+\/(?:messages|runs)|channels\/[^/]+\/conversations\/[^/]+\/messages|work-items(?:\/[^/]+\/(?:messages|runs))?)$/.test(c.req.path);
    if (c.req.method === "POST" && executionSubmission) {
      const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (body && (body.execution_kind === "flow" || body.dry_run === true
        || ["flow_id", "definition_revision", "workflow_id", "plan_id", "plan_ir_hash", "plan"].some(
          (key) => body[key] !== undefined && body[key] !== null,
        ))) {
        return c.json({ error: "flow_retired" }, 410);
      }
    }
    await next();
  });
}
