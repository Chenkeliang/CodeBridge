import { createHash, randomUUID } from "node:crypto";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";

export interface RunCardParts {
  answer: string;
  progress: string;
  status: string;
  terminal: boolean;
}

type Element = { tag: "markdown"; element_id: string; content: string };
export interface RunCardJson {
  /** Local delivery metadata; never part of the CardKit DSL. */
  overflowText?: string;
  schema: "2.0";
  config: { streaming_mode: boolean; summary: { content: string }; update_multi: true };
  body: { elements: Element[] };
}

function preview(text: string, budget: number): string {
  if (Buffer.byteLength(JSON.stringify(text)) <= budget) return text;
  let result = "";
  let bytes = 2;
  for (const character of text) {
    bytes += Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes > budget) break;
    result += character;
  }
  return result;
}

export function runCardJson(parts: RunCardParts): RunCardJson {
  const answer = preview(parts.answer, 18_000);
  const progress = preview(parts.progress, 6_000);
  const overflow = answer !== parts.answer || progress !== parts.progress;
  return {
    ...(overflow ? { overflowText: [parts.answer, parts.progress].filter(Boolean).join("\n\n---\n\n") } : {}),
    schema: "2.0",
    config: {
      streaming_mode: !parts.terminal,
      update_multi: true,
      summary: { content: parts.status.split("\n")[0] || "任务进度" },
    },
    body: { elements: [
      { tag: "markdown", element_id: "answer", content: answer || " " },
      { tag: "markdown", element_id: "progress", content: (progress + (overflow ? "\n\n正文较长，完成后以 Markdown 文件交付完整结果。" : "")) || " " },
      { tag: "markdown", element_id: "status", content: preview(parts.status, 2_000) || " " },
    ] },
  };
}

/** One owner and FIFO per entity, shared by live updates and recovery. */
export class CardKitWriter {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly confirmed = new Map<string, RunCardJson>();
  private readonly writtenAt = new Map<string, number>();

  constructor(
    private readonly channel: LarkChannel,
    private readonly nextSequence: (cardId: string) => number,
    private readonly receipts?: {
      read(): Record<string, string>;
      update(mutator: (values: Record<string, string>) => Record<string, string>): unknown;
    },
  ) {}

  write(cardId: string, card: object, replyTo?: string): Promise<void> {
    // Freeze a queued snapshot: callers may continue projecting Agent events.
    const snapshot = JSON.parse(JSON.stringify(card)) as RunCardJson;
    const task = (this.queues.get(cardId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const { overflowText, ...dsl } = snapshot;
        if (overflowText && !dsl.config.streaming_mode) {
          await this.deliverOverflow(cardId, replyTo, overflowText);
        }
        await this.writeSnapshot(cardId, dsl);
      });
    this.queues.set(cardId, task);
    void task.finally(() => {
      if (this.queues.get(cardId) === task) this.queues.delete(cardId);
    }).catch(() => {});
    return task;
  }

  private async deliverOverflow(cardId: string, replyTo: string | undefined, text: string): Promise<void> {
    if (!replyTo || !this.receipts) throw new Error("Long result delivery needs its original message and durable receipts");
    const file = Buffer.from(text);
    if (file.length > 30 * 1024 * 1024) throw new Error("Full result exceeds the Feishu 30MB file limit; delivery remains pending");
    const key = createHash("sha256").update(`${cardId}:${text}`).digest("hex");
    if (this.receipts.read()[`${key}:sent`]) return;
    let fileKey: string | undefined = this.receipts.read()[`${key}:file`];
    if (!fileKey) {
      const uploaded = await this.channel.rawClient.im.v1.file.create({ data: {
        file_type: "stream", file_name: `codebridge-${cardId}.md`, file,
      } });
      fileKey = uploaded?.file_key;
      if (!fileKey) throw new Error("Full result upload returned no file_key");
      this.receipts.update((all) => ({ ...all, [`${key}:file`]: fileKey! }));
    }
    const response = await this.channel.rawClient.im.v1.message.reply({
      path: { message_id: replyTo },
      data: { msg_type: "file", content: JSON.stringify({ file_key: fileKey }), uuid: key.slice(0, 32) },
    });
    if (response.code !== 0 || !response.data?.message_id) throw new Error(`Full result reply failed (${response.code})`);
    this.receipts.update((all) => ({ ...all, [`${key}:sent`]: response.data!.message_id! }));
  }

  private async request(cardId: string, body: object, send: (sequence: number, uuid: string) => Promise<{ code?: number; msg?: string }>): Promise<void> {
    const delay = Math.max(0, 150 - (Date.now() - (this.writtenAt.get(cardId) ?? 0)));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    this.writtenAt.set(cardId, Date.now());
    const response = await send(this.nextSequence(cardId), randomUUID());
    if (response?.code !== 0) {
      const json = JSON.stringify(body);
      throw new Error(`CardKit write failed (${response?.code}): ${response?.msg ?? "missing acknowledgement"}; card=${cardId}; bytes=${Buffer.byteLength(json)}; sha256=${createHash("sha256").update(json).digest("hex").slice(0, 16)}`);
    }
  }

  private async settings(cardId: string, card: RunCardJson): Promise<void> {
    const settings = JSON.stringify({ config: card.config });
    await this.request(cardId, { settings }, (sequence, uuid) =>
      this.channel.rawClient.cardkit.v1.card.settings({ path: { card_id: cardId }, data: { settings, sequence, uuid } }));
  }

  private async writeSnapshot(cardId: string, card: RunCardJson): Promise<void> {
    const json = JSON.stringify(card);
    if (Buffer.byteLength(json) > 30_000) {
      throw new Error("CardKit card exceeds 30000 UTF-8 bytes; delivery remains pending");
    }
    const previous = this.confirmed.get(cardId);
    // A terminal acknowledgement fences delayed live snapshots.
    if (previous && previous.config?.streaming_mode === false && card.config?.streaming_mode) return;
    const structured = card.body?.elements?.every((e) => ["answer", "progress", "status"].includes(e.element_id));
    if (!previous || !structured) {
      // Also migrates legacy single-element cards once after a restart.
      await this.request(cardId, card, (sequence, uuid) =>
        this.channel.rawClient.cardkit.v1.card.update({ path: { card_id: cardId }, data: { card: { type: "card_json", data: json }, sequence, uuid } }));
    } else {
      for (const element of card.body.elements) {
        const old = previous.body.elements.find((e) => e.element_id === element.element_id);
        if (old?.content === element.content) continue;
        const path = { card_id: cardId, element_id: element.element_id };
        const stream = element.element_id === "answer" && card.config.streaming_mode;
        const send = () => this.request(cardId, element, (sequence, uuid) => stream
          ? this.channel.rawClient.cardkit.v1.cardElement.content({ path, data: { content: element.content, sequence, uuid } })
          : this.channel.rawClient.cardkit.v1.cardElement.update({ path, data: { element: JSON.stringify(element), sequence, uuid } }));
        try {
          await send();
        } catch (error) {
          if (!stream || !/\((200850|300309)\)/.test(String(error))) throw error;
          // Never replace or clear the element when the ten-minute window closes.
          await this.settings(cardId, card);
          await send();
        }
        // Preserve partial acknowledgements so retry cannot replay older content.
        if (old) old.content = element.content;
      }
      if (JSON.stringify(previous.config) !== JSON.stringify(card.config)) {
        await this.settings(cardId, card);
      }
    }
    this.confirmed.set(cardId, card);
  }
}
