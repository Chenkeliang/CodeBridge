import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "./index.js";

const directories: string[] = [];

function databasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-session-runtime-"));
  directories.push(directory);
  return path.join(directory, "orchestration.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Session runtime schema", () => {
  it("links one WorkItem to one Session and persists runtime state", () => {
    const store = new SqliteEventStore(databasePath());
    const item = store.createWorkItem({
      title: "Session",
      mode: "auto",
      conversationId: "conv_session_1",
      sessionId: "sess_1",
      agentId: "pi",
      riskLevel: "read_only",
    });

    expect(store.getWorkItemBySessionId("sess_1")).toEqual(item);
    expect(store.getSessionRuntime("sess_1")).toMatchObject({
      sessionId: "sess_1",
      activeRunId: null,
      queueState: "ready",
      version: 1,
      lastEventSequence: 1,
    });
    store.close();
  });

  it("rejects a second active Run for one Session", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "Session",
      mode: "auto",
      conversationId: "conv_session_1",
      sessionId: "sess_1",
      riskLevel: "read_only",
    });
    store.createRun({
      id: "run_1",
      workItemId: item.id,
      sessionId: "sess_1",
      mode: "auto",
      executionKind: "agent",
    });
    expect(() => store.createRun({
      id: "run_2",
      workItemId: item.id,
      sessionId: "sess_1",
      mode: "auto",
      executionKind: "agent",
    })).toThrow();
    store.close();
  });

  it("persists interrupted and lease metadata", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "Session",
      mode: "auto",
      conversationId: "conv_session_1",
      sessionId: "sess_1",
      riskLevel: "read_only",
    });
    const run = store.createRun({
      workItemId: item.id,
      sessionId: "sess_1",
      turnId: "turn_1",
      mode: "auto",
      executionKind: "agent",
    });
    store.updateRunControl(run.id, {
      status: "interrupted",
      terminalReason: "lease_expired",
      replaySafety: "outcome_unknown",
    });

    expect(store.getRun(run.id)).toMatchObject({
      sessionId: "sess_1",
      turnId: "turn_1",
      status: "interrupted",
      terminalReason: "lease_expired",
      replaySafety: "outcome_unknown",
    });
    store.close();
  });

  it("dispatchTurn rejects a Run agent that differs from the WorkItem agent", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "Session",
      mode: "auto",
      conversationId: "conv_session_1",
      sessionId: "sess_1",
      agentId: "pi",
      riskLevel: "read_only",
    });
    store.withSessionTransaction((tx) => {
      tx.ensureRuntime("sess_1");
      const turn = tx.insertTurn("sess_1", {
        text: "检查",
        attachmentIds: [],
        flowId: null,
        executionKind: "agent",
        model: null,
        effort: null,
        permissionMode: null,
        plan: null,
      });
      expect(() => tx.dispatchTurn(turn.turnId, {
        id: "run_1",
        workItemId: item.id,
        sessionId: "sess_1",
        turnId: turn.turnId,
        mode: "auto",
        executionKind: "agent",
        agentId: "cursor",
        planId: null,
        planIrHash: null,
        workflowRevision: null,
      })).toThrow(
        "Run agent mismatch: requested cursor but WorkItem agent is pi",
      );
    });
    // 抛错后：不插 runs，Turn 仍为 queued。
    expect(store.listRunsByStatus(["queued"])).toHaveLength(0);
    store.close();
  });

  it("dispatchTurn writes the WorkItem agent when input matches", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "Session",
      mode: "auto",
      conversationId: "conv_session_1",
      sessionId: "sess_1",
      agentId: "pi",
      riskLevel: "read_only",
    });
    store.withSessionTransaction((tx) => {
      tx.ensureRuntime("sess_1");
      const turn = tx.insertTurn("sess_1", {
        text: "检查",
        attachmentIds: [],
        flowId: null,
        executionKind: "agent",
        model: null,
        effort: null,
        permissionMode: null,
        plan: null,
      });
      const dispatched = tx.dispatchTurn(turn.turnId, {
        id: "run_1",
        workItemId: item.id,
        sessionId: "sess_1",
        turnId: turn.turnId,
        mode: "auto",
        executionKind: "agent",
        agentId: "pi",
        planId: null,
        planIrHash: null,
        workflowRevision: null,
      });
      expect(dispatched.run.agentId).toBe("pi");
      // dispatchNextTurn 传 workItem.agentId，保持一致。
      expect(tx.dispatchNextTurn("sess_1")).toBeNull();
    });
    store.close();
  });

  it("rejects rebinding a plan while the prior Run is still queued", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "Session",
      mode: "auto",
      conversationId: "conv_session_1",
      sessionId: "sess_1",
      agentId: "pi",
      riskLevel: "read_only",
    });
    const plan = {
      planId: "plan_flow_demo",
      source: "workflow" as const,
      workflowId: "flow_demo",
      definitionRevision: "sha256:def",
      planIrHash: "sha256:plan",
      steps: [{
        id: "echo",
        capabilityId: "demo.echo",
        risk: "read_only" as const,
        dependsOn: [],
        guard: null,
        approval: "none" as const,
        branches: [],
        purpose: null,
      }],
    };
    store.withSessionTransaction((tx) => {
      tx.ensureRuntime("sess_1");
      const first = tx.insertTurn("sess_1", {
        text: "run",
        attachmentIds: [],
        flowId: "flow_demo",
        executionKind: "flow",
        model: null,
        effort: null,
        permissionMode: null,
        plan,
      });
      tx.dispatchTurn(first.turnId, {
        id: "run_1",
        workItemId: item.id,
        sessionId: "sess_1",
        turnId: first.turnId,
        mode: "auto",
        executionKind: "flow",
        agentId: "pi",
        planId: plan.planId,
        planIrHash: plan.planIrHash,
        workflowRevision: plan.definitionRevision,
      });
      tx.insertTurn("sess_1", {
        text: "again",
        attachmentIds: [],
        flowId: "flow_demo",
        executionKind: "flow",
        model: null,
        effort: null,
        permissionMode: null,
        plan,
      });
      expect(() => tx.dispatchNextTurn("sess_1")).toThrow(
        "Plan plan_flow_demo is bound to another Run",
      );
    });
    expect(store.getRun("run_1")?.status).toBe("queued");
    store.close();
  });
});
