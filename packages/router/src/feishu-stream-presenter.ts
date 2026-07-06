import type { AgentEvent } from "@feishu-code-bridge/core";

export type FeishuStreamZone = "thinking" | "result";

export interface FeishuStreamPart {
  zone: FeishuStreamZone;
  text: string;
}

/** 飞书流式：思考区与结果区直通渲染，不做汇总或去重 */
export function createFeishuStreamPresenter() {
  const present = (event: AgentEvent): FeishuStreamPart | null => {
    switch (event.type) {
      case "tool_start":
        return { zone: "thinking", text: `\n- \`${event.name}\`\n` };
      case "thought_delta":
        return { zone: "thinking", text: event.text };
      case "text_delta":
        return { zone: "result", text: event.text };
      case "error":
        return { zone: "result", text: `\n❌ ${event.message}\n` };
      case "done":
        return event.exitCode === 0
          ? null
          : { zone: "result", text: `\n（退出码 ${event.exitCode}）\n` };
      default:
        return null;
    }
  };

  return { present };
}

/** @deprecated 使用 createFeishuStreamPresenter */
export function createFeishuStreamFormatter() {
  const { present } = createFeishuStreamPresenter();
  return (event: AgentEvent): string => present(event)?.text ?? "";
}
