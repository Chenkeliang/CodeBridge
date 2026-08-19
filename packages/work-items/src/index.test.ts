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
    expect(store.listWorkItems().map((item) => item.title).sort()).toEqual(["first", "second"]);
    store.close();
  });

  it("updates the optional Workflow binding used by later Runs", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "task",
      mode: "auto",
      conversationId: "conv_flow",
      riskLevel: "read_only",
    });
    expect(store.updateWorkflowBinding(item.id, "review-flow", "git:abc")).toMatchObject({
      workflowId: "review-flow",
      workflowRevision: "git:abc",
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

  it("appends an idempotent event only once across store instances", () => {
    const databasePath = createDatabasePath();
    const firstStore = new SqliteEventStore(databasePath);
    const item = firstStore.createWorkItem({
      title: "history",
      mode: "auto",
      conversationId: "web:history",
      riskLevel: "read_only",
    });
    const secondStore = new SqliteEventStore(databasePath);

    const first = firstStore.appendEventOnce({
      workItemId: item.id,
      type: "MESSAGE_RECEIVED",
      actor: "user",
      inputHash: "provider-history:message:1",
      payload: { message: "hello" },
    });
    const second = secondStore.appendEventOnce({
      workItemId: item.id,
      type: "MESSAGE_RECEIVED",
      actor: "user",
      inputHash: "provider-history:message:1",
      payload: { message: "hello" },
    });

    expect(second.eventId).toBe(first.eventId);
    expect(firstStore.listEvents(item.id).filter((event) => event.inputHash === "provider-history:message:1")).toHaveLength(1);
    secondStore.close();
    firstStore.close();
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

  it("persists the validated Plan IR and pins its revision to the Run", () => {
    const databasePath = createDatabasePath();
    const store = new SqliteEventStore(databasePath);
    const workItem = store.createWorkItem({
      title: "Run a reviewed workflow",
      mode: "change",
      conversationId: "conv_plan",
      workflowId: "review-change",
      workflowRevision: "git:abc123",
      riskLevel: "workspace_write",
    });
    const plan = store.savePlan({
      planId: "plan_01JTEST",
      source: "workflow",
      workflowId: "review-change",
      definitionRevision: "git:abc123",
      sessionId: "sess_01JTEST",
      runId: "run_01JPLAN",
      steps: [
        {
          id: "inspect",
          capabilityId: "context.inspect",
          risk: "read_only",
          dependsOn: [],
          guard: null,
          approval: "none",
          branches: [],
          purpose: null,
        },
      ],
    });
    const run = store.createRun({
      id: "run_01JPLAN",
      workItemId: workItem.id,
      mode: workItem.mode,
      planId: plan.planId,
      workflowRevision: plan.definitionRevision,
    });

    expect(run.workflowRevision).toBe("git:abc123");
    expect(store.getPlan(plan.planId)).toEqual(plan);
    expect(store.getPlanForRun(run.id)).toEqual(plan);
    expect(store.listEvents(workItem.id).at(-1)).toMatchObject({
      type: "PLAN_VALIDATED",
      runId: run.id,
      target: plan.planId,
      payload: {
        workflow_id: "review-change",
        definition_revision: "git:abc123",
      },
    });

    store.close();
    const reopened = new SqliteEventStore(databasePath);
    expect(reopened.getPlan(plan.planId)).toEqual(plan);
    expect(reopened.getRun(run.id)?.workflowRevision).toBe("git:abc123");
    reopened.close();
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

  it("persists idempotency responses and requeues interrupted runs", () => {
    const databasePath = createDatabasePath();
    const store = new SqliteEventStore(databasePath);
    const workItem = store.createWorkItem({
      title: "recover",
      mode: "investigation",
      conversationId: "web:recover",
      riskLevel: "read_only",
    });
    const run = store.createRun({ workItemId: workItem.id, mode: workItem.mode });
    store.updateRunStatus(run.id, "running");
    store.putIdempotencyResponse("create-run", "key-1", { run_id: run.id });
    expect(store.getIdempotencyResponse("create-run", "key-1")).toEqual({ run_id: run.id });
    expect(store.getIdempotencyRecord("create-run", "key-1")).toEqual({
      response: { run_id: run.id },
      createdAt: expect.stringMatching(/^\d{4}-/),
    });
    store.putIdempotencyResponse("create-run", "key-stamped", { run_id: run.id }, "2020-01-01T00:00:00.000Z");
    expect(store.getIdempotencyResponse("create-run", "key-stamped")).toEqual({ run_id: run.id });
    expect(store.getIdempotencyRecord("create-run", "key-stamped")).toEqual({
      response: { run_id: run.id },
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    expect(store.listRunsByStatus(["running"])).toHaveLength(1);
    expect(store.requeueRun(run.id).status).toBe("queued");
    store.close();
    const reopened = new SqliteEventStore(databasePath);
    expect(reopened.getIdempotencyResponse("create-run", "key-1")).toEqual({ run_id: run.id });
    reopened.close();
  });

  it("resolves an event id to a sequence for Last-Event-ID", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "events",
      mode: "observe",
      conversationId: "web:events",
      riskLevel: "read_only",
    });
    const event = store.appendEvent({ workItemId: item.id, type: "MESSAGE_RECEIVED", actor: "user", payload: { message: "hi" } });
    expect(store.sequenceForEventId(item.id, event.eventId)).toBe(event.sequence);
    expect(store.sequenceForEventId(item.id, "evt_missing")).toBe(0);
    store.close();
  });

  it("persists run artifacts and verification results with content hashes", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "verify",
      mode: "review",
      conversationId: "web:verify",
      riskLevel: "read_only",
    });
    const run = store.createRun({ workItemId: item.id, mode: item.mode });
    const artifact = store.createArtifact({
      workItemId: item.id,
      runId: run.id,
      stepId: "tests",
      kind: "test_report",
      name: "result.json",
      mimeType: "application/json",
      content: '{"passed":true}',
      metadata: { source: "runner" },
    });
    expect(store.getArtifact(artifact.id)).toEqual(artifact);
    expect(artifact.contentHash).toMatch(/^sha256:/);
    const verification = store.recordVerification({
      workItemId: item.id,
      runId: run.id,
      stepId: "tests",
      validator: "unit-tests",
      status: "passed",
      summary: "All tests passed",
      artifactIds: [artifact.id],
    });
    expect(store.listArtifacts(run.id)).toHaveLength(1);
    expect(store.listVerifications(run.id)).toEqual([verification]);
    expect(store.listEvents(item.id).slice(-2).map((event) => event.type)).toEqual([
      "ARTIFACT_CREATED",
      "VERIFICATION_COMPLETED",
    ]);
    store.close();
  });

  it("persists message attachments as stable references", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "inspect attachment",
      mode: "auto",
      conversationId: "conv_attachment",
      riskLevel: "read_only",
    });
    const attachment = store.createMessageAttachment({
      workItemId: item.id,
      name: "context.txt",
      mimeType: "text/plain",
      dataBase64: Buffer.from("context").toString("base64"),
    });

    expect(attachment.id).toMatch(/^attachment_/);
    expect(attachment.contentHash).toMatch(/^sha256:/);
    expect(store.getMessageAttachment(attachment.id)).toEqual(attachment);
    expect(store.listMessageAttachments(item.id, [attachment.id])).toEqual([attachment]);
    store.close();
  });

  it("persists planIrHash on plans and runs", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({ title: "t", mode: "auto", conversationId: "c", riskLevel: "read_only" });
    const plan = store.savePlan({
      planId: "plan_1", source: "workflow", workflowId: "flow_1",
      definitionRevision: "sha256:def", planIrHash: "sha256:plan",
      steps: [{ id: "s", capabilityId: "c.d", risk: "read_only", dependsOn: [], guard: null, approval: "none", branches: [], purpose: null }],
    });
    expect(plan.planIrHash).toBe("sha256:plan");
    const run = store.createRun({ workItemId: item.id, planId: "plan_1", mode: "auto" });
    expect(run.planIrHash).toBe("sha256:plan");
    store.close();
  });
});
