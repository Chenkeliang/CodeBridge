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
      agentId: "pi-investigator",
      workspaceScope: ["equity-center"],
      riskLevel: "read_only",
    });

    expect(workItem.status).toBe("created");
    expect(workItem.agentId).toBe("pi-investigator");
    expect(store.getWorkItem(workItem.id)).toEqual(workItem);
    expect(store.listEvents(workItem.id)).toHaveLength(1);
    expect(store.listEvents(workItem.id)[0]).toMatchObject({
      type: "WORK_ITEM_CREATED",
      sequence: 1,
      workItemId: workItem.id,
    });

    store.close();
  });

  it("lists WorkItems for a workbench inbox", () => {
    const store = new SqliteEventStore(":memory:");
    store.createWorkItem({
      title: "first",
      mode: "investigation",
      conversationId: "web:first",
      riskLevel: "read_only",
    });
    store.createWorkItem({
      title: "second",
      mode: "change",
      conversationId: "web:second",
      riskLevel: "workspace_write",
    });
    expect(store.listWorkItems().map((item) => item.title)).toEqual(["first", "second"]);
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

  it("creates a queued Run linked to the WorkItem", () => {
    const store = new SqliteEventStore(createDatabasePath());
    const workItem = store.createWorkItem({
      id: "wi_01JRUN",
      title: "Investigate a payment issue",
      mode: "investigation",
      conversationId: "conv_01JRUN",
      agentId: "pi-investigator",
      riskLevel: "read_only",
    });

    const run = store.createRun({
      workItemId: workItem.id,
      mode: "investigation",
    });

    expect(run).toMatchObject({
      workItemId: workItem.id,
      mode: "investigation",
      agentId: "pi-investigator",
      status: "queued",
    });
    expect(store.getRun(run.id)).toEqual(run);
    expect(store.listRuns(workItem.id)).toEqual([run]);
    expect(store.listEvents(workItem.id).at(-1)).toMatchObject({
      type: "RUN_CREATED",
      target: run.id,
    });
    store.close();
  });

  it("updates a Run status for executor recovery", () => {
    const store = new SqliteEventStore(":memory:");
    const workItem = store.createWorkItem({
      title: "execute",
      mode: "change",
      conversationId: "web:run",
      riskLevel: "workspace_write",
    });
    const run = store.createRun({ workItemId: workItem.id, mode: "change" });

    expect(store.listEvents(workItem.id).at(-1)?.runId).toBe(run.id);
    expect(store.updateRunStatus(run.id, "running").status).toBe("running");
    expect(store.updateRunStatus(run.id, "succeeded").status).toBe("succeeded");
    expect(() => store.updateRunStatus("run_missing", "failed")).toThrow(
      "Run not found",
    );
    store.close();
  });
});
