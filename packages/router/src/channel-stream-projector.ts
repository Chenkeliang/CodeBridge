import type { AgentEvent } from "@codebridge/core";
import { createFeishuStreamPresenter } from "./feishu-stream-presenter.js";

export interface ChannelStreamSnapshot {
  thinking: string;
  progress: string;
  result: string;
  liveText: string;
  finalText: string;
}

export interface ChannelStreamProjectorOptions {
  showThinking?: boolean;
  maxProgressChars?: number;
  emptyFinalText?: string;
}

export interface ChannelStreamProjector {
  apply(event: AgentEvent): ChannelStreamSnapshot;
  snapshot(): ChannelStreamSnapshot;
}

function mergeProgressText(
  previous: string,
  next: string,
  sameMessage: boolean,
): string {
  if (!previous) return next;
  if (!next || next === previous) return previous;
  if (next.startsWith(previous)) return next;
  if (previous.startsWith(next)) return previous;
  if (!sameMessage) return next;
  for (let size = Math.min(previous.length, next.length); size > 0; size -= 1) {
    if (previous.endsWith(next.slice(0, size))) {
      return previous + next.slice(size);
    }
  }
  return previous + next;
}

export function createChannelStreamProjector(
  options: ChannelStreamProjectorOptions = {},
): ChannelStreamProjector {
  const maxProgressChars = options.maxProgressChars ?? 1200;
  const emptyFinalText = options.emptyFinalText ?? "（本次无输出）";
  const { present } = createFeishuStreamPresenter({
    showThinking: options.showThinking,
  });
  let thinking = "";
  let progress = "";
  let result = "";
  let progressMessageId: string | undefined;

  const snapshot = (): ChannelStreamSnapshot => {
    const liveSections = [
      thinking || undefined,
      progress ? `**最新进度**\n${progress}` : undefined,
      result || undefined,
    ].filter((value): value is string => Boolean(value));
    return {
      thinking,
      progress,
      result,
      liveText: liveSections.join("\n\n---\n\n"),
      finalText: result.trim() || emptyFinalText,
    };
  };

  return {
    apply(event) {
      const part = present(event);
      if (!part) return snapshot();
      if (part.zone === "thinking") {
        thinking += part.text;
      } else if (part.zone === "progress") {
        const sameMessage = !(
          part.messageId
          && progressMessageId
          && part.messageId !== progressMessageId
        );
        progress = mergeProgressText(progress, part.text, sameMessage).slice(
          -maxProgressChars,
        );
        if (part.messageId) progressMessageId = part.messageId;
      } else {
        result += part.text;
      }
      return snapshot();
    },
    snapshot,
  };
}
