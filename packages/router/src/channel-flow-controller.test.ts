import { describe, expect, it, vi } from "vitest";
import type {
  ChannelConsumableFlow,
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
  } = {},
) {
  return controller.handle({
    scopeKey: options.scopeKey ?? "feishu|chat|topic|user-1",
    text,
    listFlows: async () => options.flows ?? [demoFlow],
    getActiveRunId: async () => options.activeRunId ?? null,
    listApprovals: async () => options.approvals ?? [],
    resolveApproval: options.resolveApproval ?? vi.fn(),
  });
}

describe("ChannelFlowController", () => {
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
