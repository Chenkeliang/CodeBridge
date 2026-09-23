import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionCoordinator } from "@codebridge/session-coordinator";
import { RunExecutor } from "@codebridge/run-executor";
import { createSessionApp } from "./session-api.js";
import { Hono } from "hono";
import { rejectRetiredFlowRequests } from "./retired-features.js";

describe("retired Flow integration", () => {
  it("does not register Flow services or inject Flow instructions into ordinary runs", () => {
    const source = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/new Flow(?:CatalogStore|BatchStore|SaveIntentService|BatchService)/);
    expect(source).not.toContain("flowSaveSourceAvailability:");
    expect(source).not.toContain("buildFlowRecommendationGuidance");
  });
});

describe("retired Flow requests", () => {
  it("does not reject another feature's plan payload", async () => {
    const app = new Hono();
    rejectRetiredFlowRequests(app);
    app.post("/v1/skills/example", async (c) => c.json(await c.req.json()));
    const response = await app.request("/v1/skills/example", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: "skill-installation" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plan: "skill-installation" });
  });
  const agent = { agentId: "pi", displayName: "Pi", adapter: "sdk" as const, status: "healthy" as const, capabilities: [], models: [], sessionFeatures: [] };
  it.each(["flow_id", "definition_revision", "plan_id", "workflow_id", "plan", "dry_run"])("rejects %s before creating a Run", async (key) => {
    const catalog = new SessionCatalogStore(":memory:");
    const store = new SqliteEventStore(":memory:");
    try {
      const session = catalog.createSession({ agentId: "pi", cwd: "/workspace" });
      const app = createSessionApp({ catalog, workItems: store, coordinator: new SessionCoordinator(store, { maxQueuedTurns: 100 }), agents: [agent] }, "token");
      const response = await app.request(`/v1/sessions/${session.id}/messages`, {
        method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json", "idempotency-key": "old-client" },
        body: JSON.stringify({ message: "execute", [key]: key === "dry_run" ? true : "legacy" }),
      });
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ error: "flow_retired" });
      expect(store.listWorkItems()).toEqual([]);
    } finally { catalog.close(); store.close(); }
  });

  it("accepts an ordinary message despite an old persisted Session binding", async () => {
    const catalog = new SessionCatalogStore(":memory:");
    const store = new SqliteEventStore(":memory:");
    try {
      const session = catalog.createSession({ agentId: "pi", cwd: "/workspace" });
      vi.spyOn(catalog, "getSession").mockReturnValue({ ...session, flowId: "old", flowDefinitionRevision: "old-revision" });
      const app = createSessionApp({ catalog, workItems: store, coordinator: new SessionCoordinator(store, { maxQueuedTurns: 100 }), agents: [agent] }, "token");
      const response = await app.request(`/v1/sessions/${session.id}/messages`, {
        method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json", "idempotency-key": "ordinary" },
        body: JSON.stringify({ message: "hello" }),
      });
      expect(response.status).toBe(202);
      const runs = store.listRuns(store.listWorkItems()[0]!.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ executionKind: "agent", planId: null });
    } finally { catalog.close(); store.close(); }
  });

  it("interrupts a legacy queued Flow without invoking the Agent", async () => {
    const store = new SqliteEventStore(":memory:");
    let calls = 0;
    try {
      const item = store.createWorkItem({ title: "legacy", conversationId: "legacy", mode: "auto", workspaceScope: [], riskLevel: "read_only" });
      const run = store.createRun({ workItemId: item.id, mode: "auto", executionKind: "flow" });
      const executor = new RunExecutor(store, { async *run() { calls++; yield { type: "done" as const, exitCode: 0 }; } }, {
        resolveRequest: () => { throw new Error("must not resolve"); },
      });
      expect(await executor.execute(run.id)).toMatchObject({ status: "interrupted", terminalReason: "flow_retired" });
      expect(calls).toBe(0);
    } finally { store.close(); }
  });
});
