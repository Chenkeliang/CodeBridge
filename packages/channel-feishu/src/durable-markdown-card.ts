import { createHash } from "node:crypto";
import { runCardJson, type RunCardParts } from "./cardkit-writer.js";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";

export interface MarkdownCardController {
  cardId: string;
  messageId: string;
  setContent(content: string): Promise<void>;
  setSnapshot?(parts: RunCardParts): Promise<void>;
}

export interface MarkdownCardStream {
  stream(
    chatId: string,
    input: { markdown(controller: MarkdownCardController): Promise<void> },
    options: { replyTo: string },
  ): Promise<void>;
}

/** Use explicit CardKit acknowledgements for both live and terminal snapshots. */
export function durableMarkdownCard(
  channel: LarkChannel,
  update: (cardId: string, card: object, replyTo?: string) => Promise<void>,
): MarkdownCardStream {
  return {
    async stream(_chatId, input, options) {
      const created = await channel.rawClient.cardkit.v1.card.create({
        data: {
          type: "card_json",
          data: JSON.stringify(runCardJson({ answer: "", progress: "", status: "正在启动任务…", terminal: false })),
        },
      });
      if (created.code !== 0 || !created.data?.card_id) {
        throw new Error(`CardKit create failed (${created.code}): ${created.msg}`);
      }
      let cardId = created.data.card_id;
      const sent = await channel.rawClient.im.v1.message.reply({
        path: { message_id: options.replyTo },
        data: {
          msg_type: "interactive",
          content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
          uuid: createHash("sha256").update(`run-card:${options.replyTo}`).digest("hex").slice(0, 32),
        },
      });
      if (sent.code !== 0 || !sent.data?.message_id) {
        throw new Error(`Feishu card reply failed (${sent.code}): ${sent.msg}`);
      }
      const resolved = await channel.rawClient.cardkit.v1.card.idConvert({
        data: { message_id: sent.data.message_id },
      });
      if (resolved.code !== 0 || !resolved.data?.card_id) {
        throw new Error(`CardKit id conversion failed (${resolved.code}): ${resolved.msg}`);
      }
      // A retried, deduplicated reply may reference an earlier entity.
      cardId = resolved.data.card_id;
      // No SDK fire-and-forget queue: setContent resolves only after the API ack.
      let lastWriteAt = 0;
      await input.markdown({
        cardId,
        messageId: sent.data.message_id,
        async setSnapshot(parts) {
          await update(cardId, runCardJson(parts), sent.data!.message_id!);
        },
        async setContent(content) {
          const delay = Math.max(0, 350 - (Date.now() - lastWriteAt));
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          lastWriteAt = Date.now();
          await update(cardId, markdownCard(content));
        },
      });
    },
  };
}

export function markdownCard(content: string): object {
  const summary = content.split("\n").find((line) => line.startsWith("任务状态：")) ?? "任务进度";
  return {
    schema: "2.0",
    config: { streaming_mode: false, summary: { content: summary } },
    body: { elements: [{ tag: "markdown", content }] },
  };
}
