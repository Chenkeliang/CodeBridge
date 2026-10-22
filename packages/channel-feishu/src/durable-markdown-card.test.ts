import { afterEach, describe, expect, it, vi } from "vitest";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { durableMarkdownCard } from "./durable-markdown-card.js";
import { FeishuRunCard, type FeishuCardHost } from "./session-watcher.js";

function fixture() {
  const create = vi.fn(async (_request: unknown) => ({code: 0, data: {card_id: "entity-1"}}));
  const reply = vi.fn(async (_request: unknown) => ({code: 0, data: {message_id: "message-1"}}));
  const idConvert = vi.fn(async () => ({code: 0, data: {card_id: "entity-1"}}));
  const nativeStream = vi.fn();
  const channel = {stream: nativeStream, rawClient: {
    cardkit: {v1: {card: {create, idConvert}}}, im: {v1: {message: {reply}}},
  }} as unknown as LarkChannel;
  return {channel, create, reply, idConvert, nativeStream};
}

describe("durable task cards", () => {
  afterEach(() => vi.useRealTimers());

  it("finalizes a live image-bearing answer without submitting a filesystem image key", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const update = vi.fn(async (_id: string, card: object) => {
      if (JSON.stringify(card).includes("![截图](/private/tmp/screenshot.png)")) {
        throw new Error("CardKit write failed (200570): card contains invalid image keys");
      }
    });
    const host: FeishuCardHost = {
      channel: durableMarkdownCard(f.channel, update), updateCard: update,
      sendMarkdown: vi.fn(), registerPendingStream: vi.fn(), clearPendingStream: vi.fn(),
      log: vi.fn(), isDisconnecting: () => false,
    };
    const card = new FeishuRunCard(host, "chat", "source", "run", false);
    try {
      await card.open();
      await vi.advanceTimersByTimeAsync(500);
      await card.onAgentEvent({ type: "text_delta", phase: "final_answer", text: "![截图](/private/tmp/screenshot.png)" });
      await vi.advanceTimersByTimeAsync(500);
      const finalizing = card.finalize("succeeded");
      await vi.advanceTimersByTimeAsync(500);
      await finalizing;
      expect(JSON.stringify(update.mock.calls.at(-1))).toContain("已完成");
      expect(JSON.stringify(update.mock.calls.at(-1))).toContain("图片地址：/private/tmp/screenshot.png");
      expect(host.clearPendingStream).toHaveBeenCalledWith("message-1");
    } finally {
      card.abort();
    }
  });

  it("updates the same streaming entity past 10 minutes and acknowledges the final result", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-09-06T00:00:00Z").getTime();
    vi.setSystemTime(start);
    const f = fixture();
    const update = vi.fn(async (_id: string, _card: object) => {});
    const host: FeishuCardHost = {
      channel: durableMarkdownCard(f.channel, update),
      updateCard: update,
      sendMarkdown: vi.fn(), registerPendingStream: vi.fn(), clearPendingStream: vi.fn(),
      log: vi.fn(), isDisconnecting: () => false,
    };
    const card = new FeishuRunCard(host, "chat", "source", "run", false);
    await card.open();
    await vi.advanceTimersByTimeAsync(500);
    expect(JSON.parse((f.create.mock.calls[0][0] as {data: {data: string}}).data.data).config.streaming_mode).toBe(true);
    vi.setSystemTime(start + 11 * 60_000);
    await card.onAgentEvent({type: "text_delta", phase: "final_answer", text: "最终答案"});
    await vi.advanceTimersByTimeAsync(500);
    const finalizing = card.finalize("succeeded");
    await vi.advanceTimersByTimeAsync(500);
    await finalizing;
    expect(JSON.stringify(update.mock.calls.at(-1))).toContain("已完成");
    expect(JSON.stringify(update.mock.calls.at(-1))).toContain("最终答案");
    expect(update.mock.calls.every(([id]) => id === "entity-1")).toBe(true);
    expect(f.reply).toHaveBeenCalledTimes(1);
    expect(f.nativeStream).not.toHaveBeenCalled();
  });

  it("propagates rejected API writes instead of acknowledging a local queue", async () => {
    const f = fixture();
    const failure = new Error("CardKit update failed (300307)");
    const stream = durableMarkdownCard(f.channel, async () => {throw failure;});
    await expect(stream.stream("chat", {
      markdown: (controller) => controller.setContent("final result"),
    }, {replyTo: "source"})).rejects.toBe(failure);
  });

  it("updates the actual entity of a deduplicated reply after retry", async () => {
    const f = fixture();
    f.idConvert.mockResolvedValue({code: 0, data: {card_id: "earlier-entity"}});
    const update = vi.fn(async () => {});
    await durableMarkdownCard(f.channel, update).stream("chat", {
      markdown: (controller) => controller.setContent("recovered result"),
    }, {replyTo: "source"});
    expect(update).toHaveBeenCalledWith("earlier-entity", expect.anything());
  });

  it("retries id conversion while Feishu has not indexed the new card message", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.idConvert
      .mockResolvedValueOnce({code: 200740, msg: "ErrMsg: queried result is empty;"} as never)
      .mockResolvedValueOnce({code: 200740, msg: "ErrMsg: queried result is empty;"} as never);
    const update = vi.fn(async () => {});
    const streaming = durableMarkdownCard(f.channel, update).stream("chat", {
      markdown: (controller) => controller.setContent("result"),
    }, {replyTo: "source"});
    await vi.advanceTimersByTimeAsync(0);
    expect(f.idConvert).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(299);
    expect(f.idConvert).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.idConvert).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(700);
    await streaming;
    expect(f.idConvert).toHaveBeenCalledTimes(3);
    expect(f.reply).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("entity-1", expect.anything());
  });

  it("gives up after bounded retries", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.idConvert.mockResolvedValue({code: 200740, msg: "empty"} as never);
    const stuck = expect(durableMarkdownCard(f.channel, vi.fn()).stream("chat", {markdown: vi.fn()}, {replyTo: "source"}))
      .rejects.toThrow("CardKit id conversion failed (200740) after 5 attempts");
    await vi.advanceTimersByTimeAsync(10_000);
    await stuck;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.idConvert).toHaveBeenCalledTimes(5);
  });

  it("does not retry other conversion errors", async () => {
    const g = fixture();
    g.idConvert.mockResolvedValue({code: 99991663, msg: "forbidden"} as never);
    await expect(durableMarkdownCard(g.channel, vi.fn()).stream("chat", {markdown: vi.fn()}, {replyTo: "source"}))
      .rejects.toThrow("CardKit id conversion failed (99991663)");
    expect(g.idConvert).toHaveBeenCalledTimes(1);
  });

  it("does not finalize a Run card until the final API write succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const f = fixture();
    let fail = false;
    const update = vi.fn(async () => {if (fail) throw new Error("HTTP unavailable");});
    const clear = vi.fn();
    const host: FeishuCardHost = {
      channel: durableMarkdownCard(f.channel, update), updateCard: update,
      sendMarkdown: vi.fn(), registerPendingStream: vi.fn(), clearPendingStream: clear,
      log: vi.fn(), isDisconnecting: () => false,
    };
    const card = new FeishuRunCard(host, "chat", "src", "run", false);
    await card.open();
    await vi.advanceTimersByTimeAsync(500);
    fail = true;
    const pending = expect(card.finalize("succeeded")).rejects.toThrow("HTTP unavailable");
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(clear).not.toHaveBeenCalled();
    fail = false;
    const retry = card.finalize("succeeded");
    await vi.advanceTimersByTimeAsync(500);
    await retry;
    expect(clear).toHaveBeenCalledWith("message-1");
  });
});
