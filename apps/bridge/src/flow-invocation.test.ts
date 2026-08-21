import { describe, expect, it } from "vitest";
import type { FlowRecord } from "@codebridge/flow-catalog";
import {
  resolveFlowInvocation,
  type ResolveFlowInvocationInput,
} from "./flow-invocation.js";

function flow(
  kind: FlowRecord["kind"],
  status: FlowRecord["status"],
  revision = "sha256:current",
): FlowRecord {
  return {
    schemaVersion: 1,
    flowId: `flow-${kind}-${status}`,
    name: "Flow",
    kind,
    status,
    source: "git",
    definitionRevision: revision,
    planIrHash: null,
    inputs: [],
    reviewStatus: "pending",
    gitRevision: null,
    validationIssues: [],
    steps: [],
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

const published = flow("runbook", "published");
const candidate = flow("runbook", "candidate");
const guide = flow("guide", "draft");
const records = new Map([published, candidate, guide].map((record) => [record.flowId, record]));

function resolve(overrides: Partial<ResolveFlowInvocationInput>) {
  return resolveFlowInvocation({
    origin: "web",
    hasFlowId: false,
    requestedFlowId: undefined,
    requestedDefinitionRevision: undefined,
    binding: null,
    dryRun: false,
    getFlow: (flowId) => records.get(flowId),
    ...overrides,
  });
}

describe("resolveFlowInvocation", () => {
  it("returns none for Web without an explicit Flow or binding", () => {
    expect(resolve({})).toEqual({ kind: "none" });
  });

  it("uses a complete Web binding", () => {
    expect(resolve({
      binding: { flowId: published.flowId, definitionRevision: published.definitionRevision },
    })).toMatchObject({ kind: "flow", source: "binding", flow: published });
  });

  it("does not inherit historical binding for a Channel message", () => {
    expect(resolve({
      origin: "channel",
      binding: { flowId: published.flowId, definitionRevision: published.definitionRevision },
    })).toEqual({ kind: "none" });
  });

  it("rejects an incomplete Web binding instead of falling back to Agent", () => {
    expect(resolve({
      binding: { flowId: published.flowId, definitionRevision: null },
    })).toEqual({
      kind: "error",
      status: 409,
      body: {
        error: "flow_binding_invalid",
        source: "binding",
        flow_id: published.flowId,
        requires_confirmation: true,
      },
    });
  });

  it("ignores an incomplete historical binding for a Channel message", () => {
    expect(resolve({
      origin: "channel",
      binding: { flowId: published.flowId, definitionRevision: null },
    })).toEqual({ kind: "none" });
  });

  it("treats explicit null as an unbind instruction", () => {
    expect(resolve({ hasFlowId: true, requestedFlowId: null })).toEqual({ kind: "unbind" });
  });

  it("allows an explicit Published Runbook with the correct revision", () => {
    expect(resolve({
      hasFlowId: true,
      requestedFlowId: published.flowId,
      requestedDefinitionRevision: published.definitionRevision,
    })).toMatchObject({ kind: "flow", source: "request", flow: published });
  });

  it("allows a Candidate Runbook only for dry-run", () => {
    expect(resolve({
      hasFlowId: true,
      requestedFlowId: candidate.flowId,
      requestedDefinitionRevision: candidate.definitionRevision,
      dryRun: true,
    })).toMatchObject({ kind: "flow", source: "request", flow: candidate });
    expect(resolve({
      hasFlowId: true,
      requestedFlowId: candidate.flowId,
      requestedDefinitionRevision: candidate.definitionRevision,
    })).toEqual({
      kind: "error",
      status: 409,
      body: { error: "flow_not_executable", flow_id: candidate.flowId },
    });
  });

  it.each([false, true])("rejects Guide invocation when dryRun=%s", (dryRun) => {
    expect(resolve({
      hasFlowId: true,
      requestedFlowId: guide.flowId,
      requestedDefinitionRevision: guide.definitionRevision,
      dryRun,
    })).toEqual({
      kind: "error",
      status: 409,
      body: { error: "flow_not_executable", flow_id: guide.flowId },
    });
  });

  it("returns the stable mismatch body for an explicit request", () => {
    expect(resolve({
      hasFlowId: true,
      requestedFlowId: published.flowId,
      requestedDefinitionRevision: "sha256:old",
    })).toEqual({
      kind: "error",
      status: 409,
      body: {
        code: "flow_revision_mismatch",
        source: "request",
        flow_id: published.flowId,
        expected_definition_revision: "sha256:old",
        current_definition_revision: published.definitionRevision,
        requires_confirmation: true,
      },
    });
  });

  it("returns the stable mismatch body for a binding", () => {
    expect(resolve({
      binding: { flowId: published.flowId, definitionRevision: "sha256:old" },
    })).toMatchObject({
      kind: "error",
      status: 409,
      body: {
        code: "flow_revision_mismatch",
        source: "binding",
        expected_definition_revision: "sha256:old",
        current_definition_revision: published.definitionRevision,
      },
    });
  });

  it.each([
    [published, false],
    [candidate, true],
  ] as const)("accepts omitted revision for a compatible explicit %s", (record, dryRun) => {
    expect(resolve({
      hasFlowId: true,
      requestedFlowId: record.flowId,
      requestedDefinitionRevision: undefined,
      dryRun,
    })).toMatchObject({
      kind: "flow",
      source: "request",
      definitionRevision: record.definitionRevision,
    });
  });

  it("rejects a revision without a Flow id or binding", () => {
    expect(resolve({ requestedDefinitionRevision: "sha256:orphan" })).toEqual({
      kind: "error",
      status: 400,
      body: { error: "flow_id_required" },
    });
  });
});
