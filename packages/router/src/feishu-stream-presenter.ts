import type { AgentEvent } from "@codebridge/core";

export type FeishuStreamZone = "thinking" | "progress" | "result";

export interface FeishuStreamPart {
  zone: FeishuStreamZone;
  text: string;
  messageId?: string;
}

export interface FeishuStreamPresenterOptions {
  /** false 时隐藏内部思考/工具，但保留进度检查点与最终答案；缺省 true */
  showThinking?: boolean;
}

/** 飞书流式：思考区与结果区直通渲染，不做汇总或去重 */
export function createFeishuStreamPresenter(
  options: FeishuStreamPresenterOptions = {},
) {
  const showThinking = options.showThinking ?? true;
  const toolStatuses = new Map<string, string>();
  const toolNames = new Map<string, string>();
  let lastPlan: string | undefined;
  let latestUsage:
    | { used: number; size: number; cost?: { amount: number; currency: string } | null }
    | undefined;
  let lastMode: string | undefined;
  let lastConfigKey: string | undefined;
  let lastCommandsKey: string | undefined;
  let lastSessionTitle: string | null | undefined;
  let lastResultMessageId: string | undefined;
  let resultTrailingNewlines = 0;

  const present = (event: AgentEvent): FeishuStreamPart | null => {
    switch (event.type) {
      case "tool_start":
        if (event.toolCallId) toolNames.set(event.toolCallId, event.name);
        if (event.toolCallId && event.status) {
          toolStatuses.set(event.toolCallId, event.status);
        }
        return showThinking
          ? { zone: "thinking", text: `\n- \`${event.name}\`\n` }
          : null;
      case "tool_update": {
        const key = event.toolCallId;
        const name = event.name ?? toolNames.get(key) ?? "tool";
        if (event.name) toolNames.set(key, event.name);
        if (!showThinking) return null;
        const state = event.status ?? "in_progress";
        if (toolStatuses.get(key) === state) return null;
        toolStatuses.set(key, state);
        return {
          zone: "thinking",
          text: `\n  ↳ \`${name}\`（${state}）\n`,
        };
      }
      case "tool_end": {
        const name =
          event.name ??
          (event.toolCallId ? toolNames.get(event.toolCallId) : undefined) ??
          "tool";
        if (event.toolCallId) {
          toolStatuses.delete(event.toolCallId);
          toolNames.delete(event.toolCallId);
        }
        if (!showThinking) return null;
        return event.status === "failed"
          ? { zone: "thinking", text: `\n✗ \`${name}\`（failed）\n` }
          : { zone: "thinking", text: `\n✓ \`${name}\`\n` };
      }
      case "thought_delta":
        return showThinking ? { zone: "thinking", text: event.text } : null;
      case "text_delta": {
        if (event.phase === "commentary") {
          return {
            zone: "progress",
            text: event.text,
            messageId: event.messageId,
          };
        }
        let text = event.text;
        if (
          event.messageId &&
          lastResultMessageId &&
          event.messageId !== lastResultMessageId
        ) {
          const leadingNewlines = text.match(/^\n*/)?.[0].length ?? 0;
          text =
            "\n".repeat(
              Math.max(0, 2 - resultTrailingNewlines - leadingNewlines),
            ) + text;
        }
        if (event.messageId) lastResultMessageId = event.messageId;
        resultTrailingNewlines = Math.min(
          2,
          text.match(/\n*$/)?.[0].length ?? 0,
        );
        return { zone: "result", text, messageId: event.messageId };
      }
      case "plan": {
        if (!showThinking) return null;
        const text = event.entries
          .map((entry) => {
            const mark =
              entry.status === "completed"
                ? "x"
                : entry.status === "in_progress"
                  ? ">"
                  : " ";
            return `- [${mark}] ${entry.content}`;
          })
          .join("\n");
        const rendered = `\n**计划**\n${text}\n`;
        if (rendered === lastPlan) return null;
        lastPlan = rendered;
        return { zone: "thinking", text: rendered };
      }
      case "plan_update": {
        if (!showThinking) return null;
        const plan = event.plan as
          | { type?: string; content?: string; uri?: string; entries?: Array<{ content: string; status: string }> }
          | undefined;
        const rendered =
          plan?.type === "markdown"
            ? `\n**计划**\n${plan.content ?? ""}\n`
            : plan?.type === "file"
              ? `\n**计划文件**：${plan.uri ?? "(unknown)"}\n`
              : plan?.entries
                ? `\n**计划**\n${plan.entries
                    .map((entry) => `- ${entry.status}: ${entry.content}`)
                    .join("\n")}\n`
                : "";
        if (!rendered || rendered === lastPlan) return null;
        lastPlan = rendered;
        return { zone: "thinking", text: rendered };
      }
      case "plan_removed":
        lastPlan = undefined;
        return null;
      case "usage_update":
        latestUsage = event;
        return null;
      case "current_mode_update":
        if (!showThinking || lastMode === event.currentModeId) return null;
        lastMode = event.currentModeId;
        return {
          zone: "thinking",
          text: `\n⚙️ mode: \`${event.currentModeId}\`\n`,
        };
      case "config_option_update": {
        if (!showThinking) return null;
        const key = JSON.stringify(
          event.configOptions.map((option) => [option.id, option.currentValue]),
        );
        if (key === lastConfigKey) return null;
        lastConfigKey = key;
        const values = event.configOptions
          .filter((option) => option.currentValue !== undefined)
          .map((option) => `${option.name}=\`${option.currentValue}\``)
          .join(" · ");
        return values
          ? { zone: "thinking", text: `\n⚙️ config: ${values}\n` }
          : null;
      }
      case "available_commands_update": {
        if (!showThinking) return null;
        const key = JSON.stringify(event.availableCommands);
        if (key === lastCommandsKey) return null;
        lastCommandsKey = key;
        const commands = event.availableCommands
          .map((command) => `/${command.name}`)
          .join(" ");
        return commands
          ? { zone: "thinking", text: `\n⌘ 可用命令: ${commands}\n` }
          : null;
      }
      case "session_info_update":
        if (!showThinking || !event.title || event.title === lastSessionTitle) {
          return null;
        }
        lastSessionTitle = event.title;
        return { zone: "thinking", text: `\n📝 ${event.title}\n` };
      case "error":
        return { zone: "result", text: `\n❌ ${event.message}\n` };
      case "done":
        if (showThinking && event.exitCode === 0 && latestUsage) {
          const usage = latestUsage;
          latestUsage = undefined;
          const cost = usage.cost
            ? ` · ${usage.cost.amount} ${usage.cost.currency}`
            : "";
          return {
            zone: "thinking",
            text: `\n📊 context ${usage.used.toLocaleString()}/${usage.size.toLocaleString()}${cost}\n`,
          };
        }
        latestUsage = undefined;
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
