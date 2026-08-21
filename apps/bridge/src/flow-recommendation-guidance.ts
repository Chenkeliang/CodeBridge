import { isConsumable, type FlowRecord } from "@codebridge/flow-catalog";

export function buildFlowRecommendationGuidance(flows: FlowRecord[]): string {
  const consumable = flows.filter(isConsumable).slice(0, 12);
  if (consumable.length === 0) return "";
  const summaries = consumable.map((flow) => {
    const inputs = flow.inputs
      .filter((input) => input.source === "user")
      .map((input) => `${input.id}:${input.type}${input.required ? "*" : ""}`)
      .join(", ") || "无";
    return `- ${flow.name ?? flow.flowId} | ${flow.flowId} | ${flow.definitionRevision} | 输入: ${inputs}`;
  });
  return [
    "【可复用 Flow 判断】",
    "以下对象均为当前可执行的 Published Runbook。是否建议使用由你基于完整语义判断，Bridge 不做关键词匹配。",
    ...summaries,
    "只有当用户目标与某一 Flow 高置信、完整匹配时，才在调用任何业务工具前执行：",
    "fcb flow suggest <Flow ID> <definition revision> [非 secret 参数=值] --reason <简短原因>",
    "建议提交成功后停止本轮任务执行，只说明建议理由并请用户在当前界面确认；通道用户也可发送 /flow <Flow ID>。",
    "不确定、只部分匹配或需要改造 Flow 时不要建议，继续正常处理。不得提交 secret_ref 参数，不得直接写 Catalog、绑定、审查或发布。",
  ].join("\n");
}
