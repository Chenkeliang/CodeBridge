import { afterEach, describe, expect, it, vi } from "vitest";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { CardKitWriter, runCardJson } from "./cardkit-writer.js";

function fixture() {
  let sequence = 0;
  const calls: { kind: string; request: any }[] = [];
  const method = (kind: string) => vi.fn(async (request: any) => {
    calls.push({ kind, request });
    return { code: 0, msg: "ok" };
  });
  const update = method("card");
  const settings = method("settings");
  const content = method("content");
  const element = method("element");
  const upload = vi.fn(async (_request: any) => ({ file_key: "file-1" }));
  const reply = vi.fn(async (_request: any) => ({ code: 0, data: { message_id: "file-message" } }));
  const channel = { rawClient: { im: {v1: {file: {create: upload}, message: {reply}}}, cardkit: { v1: {
    card: { update, settings }, cardElement: { content, update: element },
  } } } } as unknown as LarkChannel;
  let values: Record<string, string> = {};
  const receipts = { read: () => values, update: (fn: (v: Record<string,string>) => Record<string,string>) => { values = fn(values); } };
  const writer = new CardKitWriter(channel, () => ++sequence, receipts);
  return { writer, calls, update, settings, content, element, upload, reply, receipts, channel };
}

const card = (answer: string, status = "任务状态：执行中", terminal = false) =>
  runCardJson({ answer, progress: "工具执行", status, terminal });

async function settle<T>(promise: Promise<T>): Promise<T> {
  const observed = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  const result = await observed;
  if ("error" in result) throw result.error;
  return result.value;
}

describe("acknowledged CardKit element writes", () => {
  afterEach(() => vi.useRealTimers());

  it("updates only status while keeping the confirmed answer untouched", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await settle(f.writer.write("c1", card("正文")));
    await settle(f.writer.write("c1", card("正文", "任务状态：执行中\n运行时长：1分钟")));
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.content).not.toHaveBeenCalled();
    expect(f.element.mock.calls.map(([r]) => r.path.element_id)).toEqual(["status"]);
  });

  it("reopens the same element after two ten-minute boundaries without replaying or clearing text", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await settle(f.writer.write("c1", card("第一段")));
    for (const [code, answer] of [[200850, "第一段第二段"], [300309, "第一段第二段第三段"]] as const) {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      f.content.mockResolvedValueOnce({ code, msg: "closed" });
      await settle(f.writer.write("c1", card(answer)));
      expect(f.content.mock.calls.at(-1)?.[0]).toMatchObject({
        path: { card_id: "c1", element_id: "answer" }, data: { content: answer },
      });
    }
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.settings).toHaveBeenCalledTimes(2);
    for (const [r] of f.settings.mock.calls) expect(JSON.parse(r.data.settings).config.streaming_mode).toBe(true);
    const sequences = f.calls.map((c) => c.request.data.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("waits for the API acknowledgement and rejects missing/nonzero codes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.update.mockResolvedValueOnce({ code: 300307, msg: "empty" });
    await expect(settle(f.writer.write("c1", card("secret answer")))).rejects.toThrow("300307");
    f.update.mockResolvedValueOnce({} as any);
    await expect(settle(f.writer.write("c1", card("secret answer")))).rejects.not.toThrow("secret answer");
    let acknowledge!: (r: any) => void;
    f.update.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    let done = false;
    const writing = f.writer.write("c1", card("result")).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(false);
    acknowledge({ code: 0 });
    await writing;
    expect(done).toBe(true);
  });

  it("does not replay acknowledged answer when a later component fails", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await settle(f.writer.write("c1", card("A")));
    f.element.mockRejectedValueOnce(new Error("network"));
    await expect(settle(f.writer.write("c1", card("AB", "new status")))).rejects.toThrow("network");
    await settle(f.writer.write("c1", card("AB", "new status")));
    expect(f.content).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent snapshots and closes only after final component acknowledgement", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await settle(f.writer.write("c1", card("A")));
    const a = f.writer.write("c1", card("AB"));
    const b = f.writer.write("c1", card("ABC", "任务状态：已完成", true));
    await settle(Promise.all([a, b]));
    expect(f.calls.at(-1)?.kind).toBe("settings");
    expect(JSON.parse(f.calls.at(-1)?.request.data.settings).config.streaming_mode).toBe(false);
    const count = f.calls.length;
    await settle(f.writer.write("c1", card("stale running")));
    expect(f.calls).toHaveLength(count);
  });

  it("retains terminal retry when closing the stream fails", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await settle(f.writer.write("c1", card("answer")));
    f.settings.mockRejectedValueOnce(new Error("close timeout"));
    await expect(settle(f.writer.write("c1", card("answer", "完成", true)))).rejects.toThrow("close timeout");
    await settle(f.writer.write("c1", card("answer", "完成", true)));
    expect(f.settings).toHaveBeenCalledTimes(2);
  });

  it("bounds UTF-8 previews without losing full results, and persists file receipts across restart", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const answer = "中文😀\n".repeat(6000);
    await settle(f.writer.write("c1", card(answer)));
    const sent = JSON.parse(f.update.mock.calls[0][0].data.card.data);
    expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThan(30_000);
    expect(sent.overflowText).toBeUndefined();
    expect(answer.startsWith(sent.body.elements[0].content)).toBe(true);
    await settle(f.writer.write("c1", card(answer, "完成", true), "source"));
    expect(f.upload.mock.calls[0][0].data.file.toString()).toContain(answer);
    expect(f.reply).toHaveBeenCalledTimes(1);
    const restarted = new CardKitWriter(f.channel, () => 100, f.receipts);
    await settle(restarted.write("c1", card(answer, "完成", true), "source"));
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.reply).toHaveBeenCalledTimes(1);
  });

  it("does not close the terminal card when full-result attachment delivery fails", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const answer = "中".repeat(11000);
    await settle(f.writer.write("c1", card(answer)));
    f.reply.mockResolvedValueOnce({code: 999, data: {message_id: ""}});
    await expect(settle(f.writer.write("c1", card(answer, "完成", true), "source"))).rejects.toThrow("999");
    expect(f.settings).not.toHaveBeenCalled();
    await settle(f.writer.write("c1", card(answer, "完成", true), "source"));
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.reply.mock.calls[0][0].data.uuid).toBe(f.reply.mock.calls[1][0].data.uuid);
  });
});
