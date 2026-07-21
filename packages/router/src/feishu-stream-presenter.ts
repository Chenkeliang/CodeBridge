import type { AgentEvent } from "@feishu-code-bridge/core";

export type FeishuStreamZone = "thinking" | "result";

export interface FeishuStreamPart {
  zone: FeishuStreamZone;
  text: string;
}

export interface FeishuStreamPresenterOptions {
  /** false 时丢弃思考/工具事件，卡片只呈现最终答案（/thinking off）；缺省 true */
  showThinking?: boolean;
}

/** 飞书流式：思考区与结果区直通渲染，不做汇总或去重 */
export function createFeishuStreamPresenter(
  options: FeishuStreamPresenterOptions = {},
) {
  const showThinking = options.showThinking ?? true;
  const present = (event: AgentEvent): FeishuStreamPart | null => {
    switch (event.type) {
      case "tool_start":
        return showThinking
          ? { zone: "thinking", text: `\n- \`${event.name}\`\n` }
          : null;
      case "thought_delta":
        return showThinking ? { zone: "thinking", text: event.text } : null;
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
