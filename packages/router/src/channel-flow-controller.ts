import { randomUUID } from "node:crypto";
import type {
  ChannelConsumableFlow,
  ChannelFlowInput,
  ChannelRuntimeApproval,
} from "@codebridge/core";

interface FlowDraft {
  flow: ChannelConsumableFlow;
  inputs: Record<string, unknown>;
  awaitingConfirmation: boolean;
  idempotencyKey: string;
}

export type ChannelFlowCommandResult =
  | { type: "reply"; text: string }
  | {
      type: "invoke";
      flow: ChannelConsumableFlow;
      inputs: Record<string, unknown>;
      idempotencyKey: string;
    };

export interface ChannelFlowCommandInput {
  scopeKey: string;
  text: string;
  listFlows(): Promise<ChannelConsumableFlow[]>;
  getActiveRunId(): Promise<string | null>;
  listApprovals(runId: string): Promise<ChannelRuntimeApproval[]>;
  resolveApproval(
    runId: string,
    approvalId: string,
    decision: "approve" | "reject",
  ): Promise<ChannelRuntimeApproval>;
}

export class ChannelFlowController {
  private readonly drafts = new Map<string, FlowDraft>();

  async handle(
    input: ChannelFlowCommandInput,
  ): Promise<ChannelFlowCommandResult | null> {
    const trimmed = input.text.trim();
    const match = trimmed.match(/^\/flow(?:@[^\s]+)?(?:\s+(.*))?$/i);
    if (!match) return null;
    const argument = (match[1] ?? "").trim();
    if (!argument) {
      return { type: "reply", text: formatFlowList(await input.listFlows()) };
    }

    const [action = "", ...rest] = argument.split(/\s+/);
    const lowerAction = action.toLowerCase();
    const remainder = rest.join(" ").trim();

    if (lowerAction === "search") {
      if (!remainder) {
        return { type: "reply", text: "用法：/flow search <名称或 Flow ID>" };
      }
      const query = remainder.toLowerCase();
      const flows = (await input.listFlows()).filter((flow) =>
        flow.name.toLowerCase().includes(query)
        || flow.flowId.toLowerCase().includes(query)
      );
      return { type: "reply", text: formatFlowList(flows, `搜索“${remainder}”`) };
    }

    if (lowerAction === "set") {
      return this.setInput(input.scopeKey, remainder);
    }

    if (lowerAction === "run") {
      return this.prepareRun(input);
    }

    if (lowerAction === "confirm") {
      return this.confirmRun(input);
    }

    if (lowerAction === "cancel") {
      this.drafts.delete(input.scopeKey);
      return { type: "reply", text: "已取消当前 Flow 选择。" };
    }

    if (lowerAction === "approve" || lowerAction === "reject") {
      return this.resolveApproval(
        input,
        lowerAction === "approve" ? "approve" : "reject",
      );
    }

    if (lowerAction === "help") {
      return { type: "reply", text: flowHelp() };
    }

    return this.selectFlow(input, argument);
  }

  private async selectFlow(
    input: ChannelFlowCommandInput,
    selector: string,
  ): Promise<ChannelFlowCommandResult> {
    const flows = await input.listFlows();
    const numeric = /^\d+$/.test(selector) ? Number(selector) : null;
    const flow = numeric !== null
      ? flows[numeric - 1]
      : flows.find((candidate) => candidate.flowId === selector);
    if (!flow) {
      return {
        type: "reply",
        text: `没有找到可使用的 Flow：${selector}\n发送 /flow 查看列表。`,
      };
    }
    const values = Object.fromEntries(
      flow.inputs
        .filter((definition) => definition.source === "user" && definition.default !== undefined)
        .map((definition) => [definition.id, coerceDefault(definition)]),
    );
    this.drafts.set(input.scopeKey, {
      flow,
      inputs: values,
      awaitingConfirmation: false,
      idempotencyKey: `flow:${randomUUID()}`,
    });
    return { type: "reply", text: formatFlowDetail(flow, values) };
  }

  private setInput(
    scopeKey: string,
    assignment: string,
  ): ChannelFlowCommandResult {
    const draft = this.drafts.get(scopeKey);
    if (!draft) return noSelection();
    const equals = assignment.indexOf("=");
    if (equals <= 0) {
      return { type: "reply", text: "用法：/flow set 参数名=参数值" };
    }
    const id = assignment.slice(0, equals).trim();
    const raw = assignment.slice(equals + 1).trim();
    const definition = draft.flow.inputs.find((candidate) =>
      candidate.id === id && candidate.source === "user"
    );
    if (!definition) {
      return { type: "reply", text: `当前 Flow 没有可填写参数：${id}` };
    }
    const parsed = parseInput(definition, raw);
    if (parsed.error) return { type: "reply", text: parsed.error };
    draft.inputs[id] = parsed.value;
    draft.awaitingConfirmation = false;
    return {
      type: "reply",
      text: `已记录 ${id} = ${maskValue(definition, parsed.value)}\n继续填写，或发送 /flow run 检查并确认。`,
    };
  }

  private async prepareRun(
    input: ChannelFlowCommandInput,
  ): Promise<ChannelFlowCommandResult> {
    const draft = this.drafts.get(input.scopeKey);
    if (!draft) return noSelection();
    const current = await currentRevision(input, draft.flow);
    if (!current) return staleRevision();
    const missing = requiredUserInputs(current).filter((definition) =>
      draft.inputs[definition.id] === undefined || draft.inputs[definition.id] === null
    );
    if (missing.length > 0) {
      return {
        type: "reply",
        text: `缺少必填参数：${missing.map((definition) => definition.id).join("、")}\n用法：/flow set 参数名=参数值`,
      };
    }
    draft.flow = current;
    draft.awaitingConfirmation = true;
    return {
      type: "reply",
      text: formatConfirmation(current, draft.inputs),
    };
  }

  private async confirmRun(
    input: ChannelFlowCommandInput,
  ): Promise<ChannelFlowCommandResult> {
    const draft = this.drafts.get(input.scopeKey);
    if (!draft) return noSelection();
    if (!draft.awaitingConfirmation) {
      return { type: "reply", text: "请先发送 /flow run 检查参数和风险，再确认执行。" };
    }
    const current = await currentRevision(input, draft.flow);
    if (!current) return staleRevision();
    draft.flow = current;
    return {
      type: "invoke",
      flow: current,
      inputs: { ...draft.inputs },
      idempotencyKey: draft.idempotencyKey,
    };
  }

  private async resolveApproval(
    input: ChannelFlowCommandInput,
    decision: "approve" | "reject",
  ): Promise<ChannelFlowCommandResult> {
    const runId = await input.getActiveRunId();
    if (!runId) {
      return { type: "reply", text: "当前没有正在等待 Runtime 步骤审批的 Run。" };
    }
    const approvals = await input.listApprovals(runId);
    const approval = approvals.find((candidate) => candidate.status === "requested");
    if (!approval) {
      return { type: "reply", text: "当前 Run 没有待处理的 Runtime 步骤审批。" };
    }
    const resolved = await input.resolveApproval(
      runId,
      approval.id,
      decision,
    );
    const label = approval.stepId ?? approval.capabilityId ?? approval.id;
    return {
      type: "reply",
      text: decision === "approve"
        ? `已批准 Runtime 步骤：${label}（${resolved.status}）`
        : `已拒绝 Runtime 步骤：${label}（${resolved.status}）`,
    };
  }
}

function requiredUserInputs(flow: ChannelConsumableFlow): ChannelFlowInput[] {
  return flow.inputs.filter((definition) =>
    definition.required && definition.source === "user"
  );
}

async function currentRevision(
  input: ChannelFlowCommandInput,
  selected: ChannelConsumableFlow,
): Promise<ChannelConsumableFlow | null> {
  return (await input.listFlows()).find((flow) =>
    flow.flowId === selected.flowId
    && flow.definitionRevision === selected.definitionRevision
  ) ?? null;
}

function parseInput(
  definition: ChannelFlowInput,
  raw: string,
): { value: unknown; error?: never } | { value?: never; error: string } {
  if (!raw) return { error: `参数 ${definition.id} 不能为空。` };
  if (definition.type === "integer") {
    if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      return { error: `参数 ${definition.id} 必须是整数。` };
    }
    return { value: Number(raw) };
  }
  if (definition.type === "enum") {
    if (!definition.values?.includes(raw)) {
      return {
        error: `参数 ${definition.id} 可选值：${(definition.values ?? []).join("、")}`,
      };
    }
    return { value: raw };
  }
  if (definition.pattern) {
    try {
      if (!new RegExp(definition.pattern).test(raw)) {
        return { error: `参数 ${definition.id} 格式不符合 ${definition.pattern}` };
      }
    } catch {
      return { error: `参数 ${definition.id} 的校验规则无效，不能执行。` };
    }
  }
  return { value: raw };
}

function coerceDefault(definition: ChannelFlowInput): unknown {
  if (definition.default === undefined) return undefined;
  const parsed = parseInput(definition, definition.default);
  return parsed.error ? definition.default : parsed.value;
}

function formatFlowList(
  flows: ChannelConsumableFlow[],
  title = "可使用的 Flow",
): string {
  if (flows.length === 0) return `${title}：暂无 Published Runbook。`;
  return [
    `${title}：`,
    ...flows.map((flow, index) =>
      `${index + 1}. ${flow.name} (${flow.flowId}) · ${requiredUserInputs(flow).length} 个必填参数`
    ),
    "发送 /flow <序号或 Flow ID> 查看并选择。",
  ].join("\n");
}

function formatFlowDetail(
  flow: ChannelConsumableFlow,
  values: Record<string, unknown>,
): string {
  const userInputs = flow.inputs.filter((definition) => definition.source === "user");
  const parameters = userInputs.length === 0
    ? ["参数：无"]
    : [
        "参数：",
        ...userInputs.map((definition) => {
          const required = definition.required ? "必填" : "可选";
          const current = values[definition.id];
          return `- ${definition.id} (${definition.type}，${required})${current === undefined ? "" : ` = ${maskValue(definition, current)}`}`;
        }),
      ];
  return [
    `已选择：${flow.name}`,
    `Flow ID：${flow.flowId}`,
    `版本：${flow.definitionRevision}`,
    `步骤：${flow.steps.length} 个；需审批：${flow.steps.filter((step) => step.approval === "required").length} 个`,
    ...parameters,
    "用 /flow set 参数名=参数值 填写；完成后发送 /flow run。",
  ].join("\n");
}

function formatConfirmation(
  flow: ChannelConsumableFlow,
  values: Record<string, unknown>,
): string {
  const valueLines = flow.inputs
    .filter((definition) => values[definition.id] !== undefined)
    .map((definition) =>
      `- ${definition.id} = ${maskValue(definition, values[definition.id])}`
    );
  const riskySteps = flow.steps.filter((step) =>
    step.mode && step.mode !== "read_only"
  );
  return [
    `确认执行 Flow：${flow.name}`,
    `版本：${flow.definitionRevision}`,
    ...(valueLines.length > 0 ? ["参数：", ...valueLines] : ["参数：无"]),
    `非只读步骤：${riskySteps.length}；需 Runtime 审批：${flow.steps.filter((step) => step.approval === "required").length}`,
    "发送 /flow confirm 执行一次；发送 /flow cancel 取消。",
  ].join("\n");
}

function maskValue(definition: ChannelFlowInput, value: unknown): string {
  return definition.type === "secret_ref" ? "***" : String(value);
}

function noSelection(): ChannelFlowCommandResult {
  return { type: "reply", text: "请先用 /flow 查看列表并选择一个 Flow。" };
}

function staleRevision(): ChannelFlowCommandResult {
  return {
    type: "reply",
    text: "所选 Flow 的版本已变化或已不可用，请重新发送 /flow 选择。",
  };
}

function flowHelp(): string {
  return [
    "/flow — 列出可使用 Flow",
    "/flow search <关键词> — 搜索",
    "/flow <序号或 ID> — 选择并查看详情",
    "/flow set 参数=值 — 填写参数",
    "/flow run — 检查参数并显示确认",
    "/flow confirm — 显式执行一次",
    "/flow cancel — 取消选择",
    "/flow approve | reject — 处理当前 Runtime 步骤审批",
  ].join("\n");
}
