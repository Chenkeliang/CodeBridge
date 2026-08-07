import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "./index.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createDatabasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-work-items-"));
  tempDirectories.push(directory);
  return path.join(directory, "events.sqlite");
}

describe("SqliteEventStore", () => {
  it("persists a WorkItem and its creation event", () => {
    const databasePath = createDatabasePath();
    const store = new SqliteEventStore(databasePath);

    const workItem = store.createWorkItem({
      id: "wi_01JTEST",
      title: "Investigate a missing entitlement",
      mode: "investigation",
      conversationId: "conv_01JTEST",
      workspaceScope: ["equity-center"],
      riskLevel: "read_only",
    });

    expect(workItem.status).toBe("created");
    expect(store.getWorkItem(workItem.id)).toEqual(workItem);
    expect(store.listEvents(workItem.id)).toHaveLength(1);
    expect(store.listEvents(workItem.id)[0]).toMatchObject({
      type: "WORK_ITEM_CREATED",
      sequence: 1,
      workItemId: workItem.id,
    });

    store.close();
  });

  it("reopens the database and keeps the event sequence", () => {
    const databasePath = createDatabasePath();
    const firstStore = new SqliteEventStore(databasePath);
    firstStore.createWorkItem({
      id: "wi_01JREOPEN",
      title: "Inspect a release",
      mode: "release",
      conversationId: "conv_01JREOPEN",
      workspaceScope: ["equity-center", "payment-gateway"],
      riskLevel: "read_only",
    });
    firstStore.appendEvent({
      workItemId: "wi_01JREOPEN",
      type: "PLAN_PROPOSED",
      actor: "agent",
      payload: { source: "agent_generated" },
    });
    firstStore.close();

    const reopenedStore = new SqliteEventStore(databasePath);
    const events = reopenedStore.listEvents("wi_01JREOPEN");

    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events[1]).toMatchObject({
      type: "PLAN_PROPOSED",
      actor: "agent",
      payload: { source: "agent_generated" },
    });

    reopenedStore.close();
  });

  it("updates the WorkItem projection from terminal events", () => {
    const store = new SqliteEventStore(createDatabasePath());
    const workItem = store.createWorkItem({
      id: "wi_01JSTATUS",
      title: "Observe a deployment",
      mode: "observe",
      conversationId: "conv_01JSTATUS",
      workspaceScope: ["equity-center"],
      riskLevel: "read_only",
    });

    store.appendEvent({
      workItemId: workItem.id,
      type: "WORK_ITEM_COMPLETED",
      actor: "system",
    });

    expect(store.getWorkItem(workItem.id)?.status).toBe("completed");
    store.close();
  });
});
