import { describe, expect, it } from "vitest";
import type { ChannelSessionEvent } from "@codebridge/core";
import {
  createChannelFlowProjector,
  renderChannelFlowFinal,
  renderChannelFlowLive,
} from "./channel-flow-projector.js";

let sequence = 0;

function event(
  type: string,
  target: string | null,
  payload: Record<string, unknown> = {},
  resultRef: string | null = null,
): ChannelSessionEvent {
  sequence += 1;
  return {
    type,
    sequence,
    runId: "run_1",
    executionKind: "flow",
    occurredAt: `2026-08-21T10:00:${String(sequence).padStart(2, "0")}.000Z`,
    target,
    resultRef,
    payload,
  };
}

describe("createChannelFlowProjector", () => {
  it("ignores generic Agent steps and approvals", () => {
    const projector = createChannelFlowProjector();
    const step = event("STEP_STARTED", "run_1");
    step.executionKind = "agent";
    projector.apply(step);
    const approval = event("APPROVAL_REQUESTED", "tool.write", {
      approval_id: "approval_agent",
      step_id: "run",
    });
    approval.executionKind = "agent";
    projector.apply(approval);

    expect(projector.snapshot().steps).toEqual([]);
    expect(projector.snapshot().approvals).toEqual([]);
  });

  it("projects batch draft and aggregate Runtime status without item-level domain logic", () => {
    const projector = createChannelFlowProjector();
    projector.apply(event("FLOW_BATCH_DRAFTED", "batch_draft_1", {
      draft_id: "batch_draft_1", flow_id: "flow_order",
      definition_revision: "sha256:rev", status: "ready", total: 3, blocking: 0,
    }));
    expect(renderChannelFlowLive(projector.snapshot())).toContain("可处理 3");
    expect(renderChannelFlowLive(projector.snapshot())).toContain("/flow batch show batch_draft_1");

    projector.apply(event("FLOW_BATCH_UPDATED", "batch_1", {
      batch_id: "batch_1", draft_id: "batch_draft_1", flow_id: "flow_order",
      definition_revision: "sha256:rev", status: "running",
      counts: { total: 3, queued: 0, running: 1, waiting: 0, succeeded: 2, failed: 0 },
    }));
    expect(projector.snapshot().batch).toMatchObject({
      batchId: "batch_1", status: "running", total: 3, succeeded: 2, active: 1,
    });
    expect(renderChannelFlowLive(projector.snapshot())).toContain("成功 2 · 运行 1 · 失败 0 · 共 3");
    expect(renderChannelFlowFinal(projector.snapshot())).toContain("/flow batch show batch_1");
  });

  it("projects steps, artifacts, verification, and the final snapshot", () => {
    const projector = createChannelFlowProjector();
    const events = [
      event("STEP_STARTED", "deploy", { capability_id: "deploy.production" }),
      event("STEP_RETRYING", "deploy", { attempt: 2, error: "timeout" }),
      event("STEP_SUCCEEDED", "deploy"),
      event("ARTIFACT_CREATED", "artifact_1", {
        artifact_id: "artifact_1",
        step_id: "deploy",
        name: "deploy.output.json",
        mime_type: "application/json",
      }, "artifact://artifact_1"),
      event("RUN_SNAPSHOT", "run_1", {
        flow_id: "flow_deploy",
        flow_revision: "sha256:revision",
        outcome: "succeeded",
        steps: [{
          step_id: "deploy",
          capability_id: "deploy.production",
          output_ref: "artifact://artifact_1",
          verification_status: "passed",
        }],
      }),
    ];

    for (const value of events) projector.apply(value);
    const snapshot = projector.snapshot();

    expect(snapshot).toMatchObject({
      flowId: "flow_deploy",
      flowRevision: "sha256:revision",
      outcome: "succeeded",
      steps: [{
        stepId: "deploy",
        capabilityId: "deploy.production",
        status: "passed",
        error: "timeout",
        outputRef: "artifact://artifact_1",
        verificationStatus: "passed",
      }],
      artifacts: [{
        artifactId: "artifact_1",
        stepId: "deploy",
        name: "deploy.output.json",
        mimeType: "application/json",
        resultRef: "artifact://artifact_1",
      }],
    });
    expect(renderChannelFlowLive(snapshot)).toContain("Flow 进度 · 1 / 1");
    expect(renderChannelFlowFinal(snapshot)).toContain("Flow 结果 · 成功");
    expect(renderChannelFlowFinal(snapshot)).toContain("deploy.output.json");
  });

  it("upserts repeated steps and artifacts instead of duplicating them", () => {
    const projector = createChannelFlowProjector();
    const step = event("STEP_STARTED", "deploy", { capability_id: "deploy.production" });
    const artifact = event("ARTIFACT_CREATED", "artifact_1", {
      artifact_id: "artifact_1",
      step_id: "deploy",
      name: "deploy.output.json",
    }, "artifact://artifact_1");

    projector.apply(step);
    projector.apply(step);
    projector.apply(artifact);
    projector.apply(artifact);

    expect(projector.snapshot().steps).toHaveLength(1);
    expect(projector.snapshot().artifacts).toHaveLength(1);
  });

  it("tracks approval states by approval id", () => {
    const projector = createChannelFlowProjector();
    projector.apply(event("APPROVAL_REQUESTED", "deploy.production", {
      approval_id: "approval_1",
      step_id: "deploy",
      expires_at: "2026-08-21T11:00:00.000Z",
    }));
    expect(projector.snapshot().approvals).toEqual([expect.objectContaining({
      approvalId: "approval_1",
      status: "requested",
    })]);
    expect(renderChannelFlowLive(projector.snapshot())).toContain("/flow approve");
    expect(renderChannelFlowLive(projector.snapshot())).toContain("Web Workbench");

    projector.apply(event("APPROVAL_GRANTED", "deploy.production", {
      approval_id: "approval_1",
      step_id: "deploy",
    }));
    expect(projector.snapshot().approvals[0]?.status).toBe("granted");

    projector.apply(event("APPROVAL_REJECTED", "deploy.production", {
      approval_id: "approval_2",
      step_id: "verify",
    }));
    expect(projector.snapshot().approvals).toHaveLength(2);
    expect(projector.snapshot().approvals[1]?.status).toBe("rejected");
  });

  it("keeps verification failures and failed step errors in the final summary", () => {
    const projector = createChannelFlowProjector();
    projector.apply(event("STEP_FAILED", "verify", { error: "assertion failed" }));
    projector.apply(event("VERIFICATION_FAILED", "verify", {
      step_id: "verify",
      category: "postcondition",
      postcondition: "output.ok === true",
    }));
    projector.apply(event("RUN_SNAPSHOT", "run_1", {
      flow_id: "flow_verify",
      flow_revision: "sha256:failed",
      outcome: "failed",
      steps: [{
        step_id: "verify",
        capability_id: "verify.output",
        output_ref: "artifact://failure",
        verification_status: "failed",
      }],
    }));

    const text = renderChannelFlowFinal(projector.snapshot());
    expect(text).toContain("Flow 结果 · 失败");
    expect(text).toContain("output.ok === true");
    expect(text).toContain("assertion failed");
  });

  it("handles skipped steps and ignores unknown events without clearing state", () => {
    const projector = createChannelFlowProjector();
    projector.apply(event("STEP_SKIPPED", "optional"));
    const before = projector.snapshot();
    projector.apply(event("UNRECOGNIZED_EVENT", null, { value: "ignored" }));

    expect(projector.snapshot()).toEqual(before);
    expect(before.steps[0]?.status).toBe("skipped");
  });
});
