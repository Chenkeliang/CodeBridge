import { afterEach, describe, expect, it, vi } from "vitest";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { CardKitWriter, runCardJson, type RunCardJson } from "./cardkit-writer.js";

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

/** Apply acknowledged SDK requests as Feishu does, including component updates. */
function renderedCard(f: ReturnType<typeof fixture>): RunCardJson {
  let result: RunCardJson | undefined;
  for (const { kind, request } of f.calls) {
    if (kind === "card") result = JSON.parse(request.data.card.data) as RunCardJson;
    else if (result && kind === "settings") Object.assign(result.config, JSON.parse(request.data.settings).config);
    else if (result && (kind === "element" || kind === "content")) {
      const element = result.body.elements.find((item) => item.element_id === request.path.element_id);
      if (!element) throw new Error("Update targeted a missing card element");
      Object.assign(element, kind === "element" ? JSON.parse(request.data.element) : { content: request.data.content });
    }
  }
  if (!result) throw new Error("No card was written");
  return result;
}

describe("CardKit image references", () => {
  it("renders local images as text while preserving native images, links and code", () => {
    const code = "`![example](/tmp/example.png)`\n```md\n![example](/tmp/example.png)\n```";
    const answer = `![截图](/private/tmp/screenshot.png)\n![飞书图片](img_v3_valid-key)\n[链接](https://example.com)\n${code}`;
    const rendered = card(answer).body.elements[0].content;
    expect(rendered).toContain("截图（图片地址：/private/tmp/screenshot.png）");
    expect(rendered).toContain("![飞书图片](img_v3_valid-key)");
    expect(rendered).toContain("[链接](https://example.com)");
    expect(rendered).toContain(code);
    expect(card(answer).overflowText).toBeUndefined();
  });

  it("normalizes progress, nested paths and reference-style images", () => {
    const parts = { answer: "![截图](</tmp/a (1).png>)", progress: "![进度][p]\n\n[p]: https://example.com/progress.png", status: "执行中", terminal: false };
    const rendered = runCardJson(parts);
    expect(rendered.body.elements[0].content).toBe("截图（图片地址：/tmp/a (1).png）");
    expect(rendered.body.elements[1].content).toContain("进度（图片地址：https://example.com/progress.png）");
  });
});

async function settle<T>(promise: Promise<T>): Promise<T> {
  const observed = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  const result = await observed;
  if ("error" in result) throw result.error;
  return result.value;
}

describe("acknowledged CardKit element writes", () => {
  afterEach(() => vi.useRealTimers());

  it("shows the full model reply with a mention across streaming, finalization and replay", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const full = "# 按当前问题组织回复\n\n" + "保留完整背景、原因和复查说明。".repeat(180)
      + "\n\n- 事实一\n- 事实二\n- 事实三\n- 事实四\n\n```ts\nconst checked = true;\n```";
    expect(full.length).toBeGreaterThan(2000);
    await settle(f.writer.write("c1", card("开始排查")));
    await settle(f.writer.notify("c1", "om_result", ["ou_example_member"], "简短状态记录"));
    expect(renderedCard(f).body.elements.find(e => e.element_id === "answer")?.content).toBe("开始排查");
    await settle(f.writer.write("c1", card(full, "已完成", true)));
    expect(renderedCard(f).body.elements.find(e => e.element_id === "answer")?.content).toBe(full);
    expect(renderedCard(f).body.elements.find(e => e.element_id === "recipient")?.content).toBe('<at id="ou_example_member"></at>');
    const restarted = new CardKitWriter(f.channel, () => 100, f.receipts);
    await settle(restarted.write("c1", card(full, "已完成", true)));
    expect(renderedCard(f).body.elements.find(e => e.element_id === "answer")?.content).toBe(full);
    expect(JSON.stringify(renderedCard(f))).not.toContain("简短状态记录");
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("keeps existing notice acknowledgements without using their summary as the answer", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.receipts.update(() => ({ "notice:c1": JSON.stringify({ recipients: ["ou_example_member"], text: "先前的摘要" }) }));
    await settle(f.writer.write("c1", card("恢复出的完整模型终稿", "已完成", true)));
    expect(renderedCard(f).body.elements.find(e => e.element_id === "answer")?.content).toBe("恢复出的完整模型终稿");
    expect(renderedCard(f).body.elements.find(e => e.element_id === "recipient")?.content).toContain("ou_example_member");
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("puts recipient resolution feedback beside the answer without replacing it", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await settle(f.writer.write("c1", card("模型的详细排查说明")));
    await settle(f.writer.notify("c1", "om_result", [], "同名成员，未发送提醒"));
    expect(renderedCard(f).body.elements.find(e => e.element_id === "answer")?.content).toBe("模型的详细排查说明");
    expect(renderedCard(f).body.elements.find(e => e.element_id === "notice")?.content).toBe("同名成员，未发送提醒");
    expect(JSON.stringify(renderedCard(f))).not.toContain("<at");
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("keeps the alert mention without substituting a status summary through final writes and restart", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await settle(f.writer.write("c1", card("排查进度")));
    await settle(f.writer.notify("c1", "om_result", ["ou_example_member", "ou_example_second"], "**需要确认**\n请核对本单"));
    await settle(f.writer.write("c1", card("完整的 Agent 最终回复", "任务状态：已完成", true)));
    const final = renderedCard(f);
    expect(final.body.elements.find((e) => e.element_id === "recipient")?.content).toBe('<at id="ou_example_member"></at> <at id="ou_example_second"></at>');
    expect(final.body.elements.find((e) => e.element_id === "answer")?.content).toBe("完整的 Agent 最终回复");
    const restarted = new CardKitWriter(f.channel, () => 100, f.receipts);
    await settle(restarted.write("c1", card("完整的 Agent 最终回复", "任务状态：已完成", true)));
    const replay = renderedCard(f);
    expect(replay.body.elements.slice(0, 2)).toEqual(final.body.elements.slice(0, 2));
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("retries an unacknowledged notice on the same card and stops overlaying it after resolution", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await settle(f.writer.write("c1", card("原进度")));
    f.update.mockResolvedValueOnce({ code: 300307, msg: "temporary failure" });
    await expect(settle(f.writer.notify("c1", "om_result", ["ou_example_member"], "请确认"))).rejects.toThrow("300307");
    await settle(f.writer.notify("c1", "om_result", ["ou_example_member"], "请确认"));
    const count = f.calls.length;
    await settle(f.writer.notify("c1", "om_result", ["ou_example_member"], "请确认"));
    expect(f.calls).toHaveLength(count);
    f.writer.clearNotice("c1");
    await settle(f.writer.write("c1", card("已复查恢复", "任务状态：已完成", true)));
    const final = JSON.parse(f.update.mock.calls.at(-1)![0].data.card.data);
    expect(JSON.stringify(final)).not.toContain("<at");
    expect(final.body.elements[0].content).toBe("已复查恢复");
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("reads the original user card after restart without creating a second reply", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const get = vi.fn(async () => ({ code: 0, data: { items: [{ message_id: "om_result", body: { content: JSON.stringify(card("重启前结果", "已完成", true)) } }] } }));
    (f.channel.rawClient.im.v1.message as any).get = get;
    await settle(f.writer.notify("c1", "om_result", ["ou_example_member"], "需要核对"));
    expect(get).toHaveBeenCalledWith({ path: { message_id: "om_result" }, params: { card_msg_content_type: "user_card_content" } });
    expect(f.update.mock.calls[0][0].path.card_id).toBe("c1");
    expect(JSON.parse(f.update.mock.calls[0][0].data.card.data).body.elements[1].content).toBe("重启前结果");
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("mentions only backend-selected recipients even when a summary contains native at tags", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await settle(f.writer.write("c1", card("正在排查")));
    await settle(f.writer.notify("c1", "om_result", ["ou_example_member"], '请核对 <at id="ou_untrusted">引用姓名</at> <at id="all"></at>'));
    const result = JSON.parse(f.update.mock.calls.at(-1)![0].data.card.data);
    expect(result.body.elements[0].content).toBe('<at id="ou_example_member"></at>');
    expect(result.body.elements[1].content).toBe("正在排查");
    expect(JSON.stringify(result)).not.toContain("ou_untrusted");
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("delivers the full oversized model reply while keeping the same-card mention", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await settle(f.writer.write("c1", card("原进度")));
    await settle(f.writer.notify("c1", "om_result", ["ou_example_member"], "状态摘要"));
    const full = "完整分析与说明。".repeat(3500);
    await settle(f.writer.write("c1", runCardJson({ answer: full, progress: "", status: "已完成", terminal: true }), "om_result"));
    expect(f.upload.mock.calls[0][0].data.file.toString()).toBe(full);
    expect(f.reply).toHaveBeenCalledTimes(1);
    expect(f.reply.mock.calls[0][0].data.msg_type).toBe("file");
    expect(renderedCard(f).body.elements.find(e => e.element_id === "answer")?.content).toMatch(/^完整分析与说明/);
    expect(renderedCard(f).body.elements.find(e => e.element_id === "recipient")?.content).toContain("ou_example_member");
    expect(JSON.stringify(renderedCard(f))).not.toContain("状态摘要");
  });

  it("does not add a notice when human closure happens during the card read", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let current = true;
    (f.channel.rawClient.im.v1.message as any).get = vi.fn(async () => {
      current = false;
      return { code: 0, data: { items: [{ message_id: "om_result", body: { content: JSON.stringify(card("原结果")) } }] } };
    });
    await settle(f.writer.notify("c1", "om_result", ["ou_example_member"], "请确认", () => current));
    expect(f.update).not.toHaveBeenCalled();
    expect(f.receipts.read()["notice:c1"]).toBeUndefined();
  });

  it("rechecks human closure after the write throttle and before sending the at", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await settle(f.writer.write("c1", card("原结果")));
    let current = true;
    const pending = f.writer.notify("c1", "om_result", ["ou_example_member"], "请确认", () => current);
    await vi.advanceTimersByTimeAsync(0);
    current = false;
    await settle(pending);
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.receipts.read()["notice:c1"]).toBeUndefined();
    await settle(f.writer.write("c1", card("正常最终输出", "已完成", true)));
    expect(JSON.stringify(f.calls)).not.toContain("ou_example_member");
  });

  it("does not let a final stream write deliver a notice whose API acknowledgement failed", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await settle(f.writer.write("c1", card("原结果")));
    f.update.mockResolvedValueOnce({ code: 300307, msg: "temporary failure" });
    await expect(settle(f.writer.notify("c1", "om_result", ["ou_example_member"], "请确认"))).rejects.toThrow("300307");
    expect(f.receipts.read()["notice:c1"]).toBeUndefined();
    await settle(f.writer.write("c1", card("正常最终输出", "已完成", true)));
    expect(f.update).toHaveBeenCalledTimes(2);
    expect(f.element.mock.calls.every(([r]) => r.path.element_id !== "recipient")).toBe(true);
  });

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
