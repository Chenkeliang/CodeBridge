import { describe, expect, it } from "vitest";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionCoordinator } from "@codebridge/session-coordinator";
import { createSessionApp } from "./session-api.js";

const token = "runtime-token";

function setup() {
  const catalog = new SessionCatalogStore(":memory:");
  const workItems = new SqliteEventStore(":memory:");
  const coordinator = new SessionCoordinator(workItems, {
    maxQueuedTurns: 100,
  });
  const session = catalog.createSession({
    agentId: "pi",
    cwd: "/workspace",
  });
  const app = createSessionApp({
    catalog,
    workItems,
    coordinator,
    agents: [{
      agentId: "pi",
      displayName: "Pi",
      adapter: "sdk",
      status: "healthy",
      capabilities: ["session"],
      models: [],
      sessionFeatures: ["resume"],
    }],
  }, token);
  return { app, catalog, workItems, coordinator, session };
}

function request(message: string, key?: string) {
  return {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify({ message }),
  };
}

describe("Session runtime command API", () => {
  it("atomically dispatches the first message", async () => {
    const fixture = setup();
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      request("检查项目", "message_1"),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      acceptance: "dispatched",
      turn: { status: "dispatched" },
      runtime: { active_run: { status: "queued" } },
    });
    expect(
      fixture.workItems.getSessionRuntime(fixture.session.id)?.activeRunId,
    ).toBeTruthy();
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("returns the committed receipt for an ambiguous retry", async () => {
    const fixture = setup();
    const first = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      request("检查项目", "message_1"),
    );
    const second = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      request("检查项目", "message_1"),
    );
    expect(await second.json()).toEqual(await first.json());
    expect(
      fixture.workItems.listRuns(
        fixture.workItems.getWorkItemBySessionId(fixture.session.id)!.id,
      ),
    ).toHaveLength(1);
    fixture.catalog.close();
    fixture.workItems.close();
  });

  it("requires an idempotency key for mutation", async () => {
    const fixture = setup();
    const response = await fixture.app.request(
      `/v1/sessions/${fixture.session.id}/messages`,
      request("检查项目"),
    );
    expect(response.status).toBe(400);
    fixture.catalog.close();
    fixture.workItems.close();
  });
});
