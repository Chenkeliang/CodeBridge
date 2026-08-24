import { describe, expect, it, vi } from "vitest";
import type {
  ChannelConsumableFlow,
  ChannelFlowBatchDraft,
  ChannelFlowBatchSnapshot,
  ChannelFlowReviewSummary,
  ChannelManageableFlow,
  ChannelRuntimeApproval,
} from "@codebridge/core";
import { ChannelFlowController } from "./channel-flow-controller.js";

const demoFlow: ChannelConsumableFlow = {
  flowId: "flow_order",
  name: "订单告警排查",
  definitionRevision: "sha256:one",
  inputs: [
    { id: "oid", type: "integer", source: "user", required: true },
    {
      id: "environment",
      type: "enum",
      source: "user",
      required: true,
      values: ["test", "production"],
    },
    {
      id: "note",
      type: "string",
      source: "user",
      pattern: "^[a-z]+$",
    },
    { id: "token", type: "secret_ref", source: "user" },
  ],
  steps: [
    { id: "lookup", purpose: "查订单", mode: "read_only", approval: "none" },
    { id: "repair", purpose: "修复", mode: "production_write", approval: "required" },
  ],
};

function context(
  controller: ChannelFlowController,
  text: string,
  options: {
    scopeKey?: string;
    flows?: ChannelConsumableFlow[];
    activeRunId?: string | null;
    approvals?: ChannelRuntimeApproval[];
    resolveApproval?: ReturnType<typeof vi.fn>;
    management?: {
      flows: ChannelManageableFlow[];
      review: ChannelFlowReviewSummary;
      save?: ReturnType<typeof vi.fn>;
      update?: ReturnType<typeof vi.fn>;
      reject?: ReturnType<typeof vi.fn>;
    };
    batch?: {
      draft: ChannelFlowBatchDraft;
      snapshot: ChannelFlowBatchSnapshot;
      confirm?: ReturnType<typeof vi.fn>;
      cancel?: ReturnType<typeof vi.fn>;
      retry?: ReturnType<typeof vi.fn>;
    };
  } = {},
) {
  return controller.handle({
    scopeKey: options.scopeKey ?? "feishu|chat|topic|user-1",
    text,
    listFlows: async () => options.flows ?? [demoFlow],
    getSessionId: async () => "sess_1",
    listManageableFlows: options.management ? async () => options.management!.flows : undefined,
    saveLatestGuide: options.management?.save,
    getFlowReviewSummary: options.management ? async () => options.management!.review : undefined,
    updateCandidateSummary: options.management?.update,
    rejectCandidate: options.management?.reject,
    getFlowBatchDraft: options.batch ? async () => options.batch!.draft : undefined,
    confirmFlowBatchDraft: options.batch?.confirm ?? (options.batch ? async () => options.batch!.snapshot : undefined),
    getFlowBatch: options.batch ? async () => options.batch!.snapshot : undefined,
    cancelFlowBatch: options.batch?.cancel ?? (options.batch ? async () => options.batch!.snapshot : undefined),
    retryFailedFlowBatch: options.batch?.retry ?? (options.batch ? async () => options.batch!.snapshot : undefined),
    getActiveRunId: async () => options.activeRunId ?? null,
    listApprovals: async () => options.approvals ?? [],
    resolveApproval: options.resolveApproval ?? vi.fn(),
  });
}

describe("ChannelFlowController", () => {
  it("confirms and controls a ready batch through the shared channel contract", async () => {
    const controller = new ChannelFlowController();
    const draft: ChannelFlowBatchDraft = {
      draftId: "batch_draft_1", sessionId: "sess_1", flowId: "flow_order",
      definitionRevision: "sha256:one", status: "ready", revision: 2, total: 3, blocking: 0,
    };
    const snapshot: ChannelFlowBatchSnapshot = {
      batchId: "batch_1", draftId: draft.draftId, sessionId: draft.sessionId,
      flowId: draft.flowId, definitionRevision: draft.definitionRevision, status: "running",
      counts: { total: 3, queued: 2, running: 1, waiting: 0, succeeded: 0, failed: 0, cancelled: 0 },
    };
    const confirm = vi.fn(async () => snapshot);
    const retry = vi.fn(async () => ({ ...snapshot, status: "queued" as const }));
    const batch = { draft, snapshot, confirm, retry };

    await expect(context(controller, `/flow batch show ${draft.draftId}`, { batch })).resolves.toMatchObject({ text: expect.stringContaining("可处理 3") });
    await expect(context(controller, `/flow batch confirm ${draft.draftId}`, { batch })).resolves.toMatchObject({
      text: expect.stringContaining("已开始批量执行 3 项"),
      batch: snapshot,
    });
    expect(confirm).toHaveBeenCalledWith(draft.draftId, 2, expect.stringMatching(/^flow-batch:/));
    await expect(context(controller, "/flow batch show batch_1", { batch })).resolves.toMatchObject({ text: expect.stringContaining("运行 3") });
    await context(controller, "/flow batch retry-failed batch_1", { batch });
    expect(retry).toHaveBeenCalledWith("batch_1", expect.stringMatching(/^flow-batch-retry:/));
  });

  it("blocks channel confirmation while a batch draft needs input", async () => {
    const controller = new ChannelFlowController();
    const draft: ChannelFlowBatchDraft = {
      draftId: "batch_draft_2", sessionId: "sess_1", flowId: "flow_order",
      definitionRevision: "sha256:one", status: "needs_input", revision: 1, total: 2, blocking: 1,
    };
    const snapshot = {
      batchId: "batch_2", draftId: draft.draftId, sessionId: draft.sessionId,
      flowId: draft.flowId, definitionRevision: draft.definitionRevision, status: "queued" as const,
      counts: { total: 2, queued: 2, running: 0, waiting: 0, succeeded: 0, failed: 0, cancelled: 0 },
    };
    const confirm = vi.fn(async () => snapshot);
    await expect(context(controller, `/flow batch confirm ${draft.draftId}`, { batch: { draft, snapshot, confirm } })).resolves.toMatchObject({ text: expect.stringContaining("尚未就绪") });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("routes management commands without exposing publish approval", async () => {
    const controller = new ChannelFlowController();
    const flow: ChannelManageableFlow = {
      flowId: "flow_candidate", name: "订单核验", description: null,
      definitionRevision: "sha256:candidate", kind: "runbook", status: "candidate", reviewStatus: "pending",
    };
    const review: ChannelFlowReviewSummary = {
      flow, changedFields: ["step ~lookup"], provenance: { sourceRunId: "run_1", sourceSessionId: "sess_1" },
      evidenceCount: 1, validationIssues: [],
    };
    const save = vi.fn(async () => ({ ...flow, flowId: "flow_guide", kind: "guide" as const, status: "draft" as const }));
    const update = vi.fn(async () => ({ ...flow, name: "新名称", definitionRevision: "sha256:next" }));
    const reject = vi.fn(async () => ({ ...flow, reviewStatus: "rejected" }));
    const management = { flows: [flow], review, save, update, reject };

    await expect(context(controller, "/flow manage", { management })).resolves.toMatchObject({ text: expect.stringContaining("runbook/candidate") });
    await expect(context(controller, "/flow guide save", { management })).resolves.toMatchObject({ text: expect.stringContaining("flow_guide") });
    await expect(context(controller, "/flow diff flow_candidate", { management })).resolves.toMatchObject({ text: expect.stringContaining("Dry-run 成功证据：1") });
    await context(controller, "/flow edit flow_candidate name=新名称", { management });
    expect(update).toHaveBeenCalledWith("flow_candidate", { name: "新名称" });
    await context(controller, "/flow reject flow_candidate", { management });
    expect(reject).toHaveBeenCalledWith("flow_candidate");
    await expect(context(controller, "/flow review flow_candidate", { management })).resolves.toMatchObject({ text: expect.stringContaining("通道不提供批准发布") });
    await expect(context(controller, "/flow open flow_candidate", { management })).resolves.toMatchObject({ text: expect.stringContaining("flow=flow_candidate&session=sess_1") });
    await expect(context(controller, "/flow publish flow_candidate", { management })).resolves.toMatchObject({ text: expect.stringContaining("没有找到可使用的 Flow") });
  });

  it("lists, searches, and selects only supplied consumable Flows", async () => {
    const controller = new ChannelFlowController();
    await expect(context(controller, "/flow")).resolves.toMatchObject({
      type: "reply",
      text: expect.stringContaining("1. 订单告警排查"),
    });
    await expect(context(controller, "/flow search 告警")).resolves.toMatchObject({
      type: "reply",
      text: expect.stringContaining("flow_order"),
    });
    await expect(context(controller, "/flow 1")).resolves.toMatchObject({
      type: "reply",
      text: expect.stringContaining("oid (integer，必填)"),
    });
  });

  it("collects typed inputs and requires a separate confirmation", async () => {
    const controller = new ChannelFlowController();
    await context(controller, "/flow flow_order");
    await expect(context(controller, "/flow set oid=1644460")).resolves.toMatchObject({
      type: "reply",
      text: expect.stringContaining("oid = 1644460"),
    });
    await context(controller, "/flow set environment=production");
    await context(controller, "/flow set token=secret://warehouse");
    const ready = await context(controller, "/flow run");
    expect(ready).toMatchObject({
      type: "reply",
      text: expect.stringContaining("/flow confirm"),
    });
    expect(ready?.type === "reply" ? ready.text : "").toContain("token = ***");

    const first = await context(controller, "/flow confirm");
    const retry = await context(controller, "/flow confirm");
    expect(first).toMatchObject({
      type: "invoke",
      flow: { flowId: "flow_order", definitionRevision: "sha256:one" },
      inputs: {
        oid: 1644460,
        environment: "production",
        token: "secret://warehouse",
      },
      idempotencyKey: expect.stringMatching(/^flow:/),
    });
    expect(retry).toEqual(first);
  });

  it("rejects missing and invalid parameter values before Runtime", async () => {
    const controller = new ChannelFlowController();
    await context(controller, "/flow 1");
    await expect(context(controller, "/flow run")).resolves.toMatchObject({
      type: "reply",
      text: expect.stringContaining("缺少必填参数：oid、environment"),
    });
    await expect(context(controller, "/flow set oid=1.5")).resolves.toMatchObject({
      type: "reply",
      text: expect.stringContaining("必须是整数"),
    });
    await expect(context(controller, "/flow set environment=staging")).resolves.toMatchObject({
      type: "reply",
      text: expect.stringContaining("可选值：test、production"),
    });
    await expect(context(controller, "/flow set note=123")).resolves.toMatchObject({
      type: "reply",
      text: expect.stringContaining("格式不符合"),
    });
  });

  it("blocks stale revisions and unknown selections", async () => {
    const controller = new ChannelFlowController();
    await expect(context(controller, "/flow missing")).resolves.toMatchObject({
      type: "reply",
      text: expect.stringContaining("没有找到"),
    });
    await context(controller, "/flow 1");
    await context(controller, "/flow set oid=1");
    await context(controller, "/flow set environment=test");
    await expect(context(controller, "/flow run", {
      flows: [{ ...demoFlow, definitionRevision: "sha256:two" }],
    })).resolves.toMatchObject({
      type: "reply",
      text: expect.stringContaining("版本已变化"),
    });
  });

  it("isolates draft state by channel conversation and sender", async () => {
    const controller = new ChannelFlowController();
    await context(controller, "/flow 1", { scopeKey: "chat|user-1" });
    await expect(context(controller, "/flow set oid=1", {
      scopeKey: "chat|user-2",
    })).resolves.toMatchObject({
      type: "reply",
      text: expect.stringContaining("先用 /flow"),
    });
    await context(controller, "/flow cancel", { scopeKey: "chat|user-1" });
    await expect(context(controller, "/flow run", {
      scopeKey: "chat|user-1",
    })).resolves.toMatchObject({
      type: "reply",
      text: expect.stringContaining("先用 /flow"),
    });
  });

  it("keeps Runtime approval distinct from Agent permission commands", async () => {
    const controller = new ChannelFlowController();
    const approval: ChannelRuntimeApproval = {
      id: "approval_1",
      runId: "run_1",
      stepId: "repair",
      capabilityId: "order.repair",
      status: "requested",
      environment: "production",
      targetResource: "order:1",
      expiresAt: null,
    };
    const resolveApproval = vi.fn().mockResolvedValue({
      ...approval,
      status: "granted",
    });
    await expect(context(controller, "/flow approve", {
      activeRunId: "run_1",
      approvals: [approval],
      resolveApproval,
    })).resolves.toMatchObject({
      type: "reply",
      text: expect.stringContaining("已批准 Runtime 步骤"),
    });
    expect(resolveApproval).toHaveBeenCalledWith(
      "run_1",
      "approval_1",
      "approve",
    );
  });

  it("does not treat arbitrary slash commands as Flow commands", async () => {
    const controller = new ChannelFlowController();
    await expect(context(controller, "/approve")).resolves.toBeNull();
    await expect(context(controller, "normal chat")).resolves.toBeNull();
  });
});
