import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "@codebridge/work-items";
import {
  ApprovalService,
  CapabilityRegistry,
  PolicyEngine,
  type CapabilityDefinition,
} from "./index.js";

const writeCapability: CapabilityDefinition = {
  id: "release.execute",
  risk: "production_write",
  adapter: "dcp",
};

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("policy and approval", () => {
  it("requires approval for production capabilities and consumes a grant once", () => {
    const registry = new CapabilityRegistry([writeCapability]);
    const policy = new PolicyEngine(registry);
    expect(
      policy.evaluate("release.execute", { environment: "production" }),
    ).toMatchObject({ allowed: false, requiresApproval: true, reason: "approval_required" });

    const workItems = new SqliteEventStore(":memory:");
    const workItem = workItems.createWorkItem({
      title: "release",
      mode: "release",
      conversationId: "web:1",
      riskLevel: "production_write",
    });
    workItems.createRun({
      id: "run_1",
      workItemId: workItem.id,
      mode: workItem.mode,
      executionKind: "agent",
    });
    const approvals = new ApprovalService(workItems, ":memory:");
    const requested = approvals.request({
      workItemId: workItem.id,
      runId: "run_1",
      stepId: "release",
      capabilityId: "release.execute",
      sessionId: "sess_1",
      environment: "production",
      targetResource: "service/release",
      inputHash: "sha256:abc",
      requestedBy: "agent",
      ttlMs: 60_000,
    });
    const granted = approvals.grant(requested.id, "user");
    expect(granted).toBeDefined();
    expect(requested).toMatchObject({
      sessionId: "sess_1",
      environment: "production",
      targetResource: "service/release",
    });
    expect(approvals.consume(granted!.id, "run_1", "release", "sha256:abc")).toBe(true);
    expect(approvals.consume(granted!.id, "run_1", "release", "sha256:abc")).toBe(false);
    expect(workItems.listEvents(workItem.id).map((event) => event.type)).toEqual([
      "WORK_ITEM_CREATED",
      "RUN_CREATED",
      "APPROVAL_REQUESTED",
      "APPROVAL_GRANTED",
    ]);
    approvals.close();
    workItems.close();
  });

  it("can reject a pending approval and records the decision", () => {
    const workItems = new SqliteEventStore(":memory:");
    const workItem = workItems.createWorkItem({
      title: "release",
      mode: "release",
      conversationId: "web:reject",
      riskLevel: "production_write",
    });
    workItems.createRun({
      id: "run_reject",
      workItemId: workItem.id,
      mode: workItem.mode,
      executionKind: "agent",
    });
    const approvals = new ApprovalService(workItems, ":memory:");
    const requested = approvals.request({
      workItemId: workItem.id,
      runId: "run_reject",
      stepId: "release",
      capabilityId: "release.execute",
      inputHash: "sha256:reject",
      requestedBy: "agent",
    });
    expect(approvals.revoke(requested.id, "user")?.status).toBe("revoked");
    expect(approvals.revoke(requested.id, "user")?.status).toBe("revoked");
    expect(workItems.listEvents(workItem.id).at(-1)).toMatchObject({
      type: "APPROVAL_REJECTED",
      payload: { approval_id: requested.id, rejected_by: "user" },
    });
    approvals.close();
    workItems.close();
  });

  it("rejects a grant when the token is expired or bound to different input", () => {
    const workItems = new SqliteEventStore(":memory:");
    const workItem = workItems.createWorkItem({
      title: "release",
      mode: "release",
      conversationId: "web:1",
      riskLevel: "production_write",
    });
    workItems.createRun({
      id: "run_1",
      workItemId: workItem.id,
      mode: workItem.mode,
      executionKind: "agent",
    });
    const approvals = new ApprovalService(workItems, ":memory:");
    const requested = approvals.request({
      workItemId: workItem.id,
      runId: "run_1",
      stepId: "release",
      capabilityId: "release.execute",
      inputHash: "sha256:abc",
      requestedBy: "agent",
      ttlMs: -1,
    });
    approvals.grant(requested.id, "user");
    expect(approvals.consume(requested.id, "run_1", "release", "sha256:abc")).toBe(false);
    expect(approvals.consume(requested.id, "run_1", "release", "sha256:def")).toBe(false);
    approvals.close();
    workItems.close();
  });

  it("persists unified Skill and MCP capability definitions", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-capabilities-"));
    tempDirectories.push(directory);
    const databasePath = path.join(directory, "capabilities.sqlite");
    const first = new CapabilityRegistry([], { databasePath });
    first.register({
      id: "repository.inspect",
      risk: "read_only",
      adapter: "skill:repository-inspection",
      environments: ["local"],
      description: "Inspect repository context",
    });
    first.register({
      id: "metrics.query",
      risk: "read_only",
      adapter: "mcp:metrics/query",
      source: {
        kind: "mcp",
        ref: "metrics/query",
        version: "server:1",
        revision: "sha256:abc",
      },
    });
    first.close();

    const reopened = new CapabilityRegistry([], { databasePath });
    expect(reopened.list().map((capability) => capability.id)).toEqual([
      "metrics.query",
      "repository.inspect",
    ]);
    expect(reopened.get("repository.inspect")).toMatchObject({
      adapter: "skill:repository-inspection",
      environments: ["local"],
    });
    expect(reopened.get("metrics.query")?.source).toEqual({
      kind: "mcp",
      ref: "metrics/query",
      version: "server:1",
      revision: "sha256:abc",
    });
    reopened.close();
  });
});
