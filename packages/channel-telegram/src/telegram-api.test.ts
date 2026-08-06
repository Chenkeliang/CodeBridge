import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramApi, chunkTelegramText } from "./telegram-api.js";

afterEach(() => vi.restoreAllMocks());

describe("TelegramApi", () => {
  it("sends a message to the raw Telegram chat id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        status: 200,
      }),
    );
    const api = new TelegramApi({
      token: "123:token",
      fetch: fetchMock,
      baseUrl: "https://telegram.test",
    });

    await expect(api.sendMessage("telegram:-1001", "hello")).resolves.toEqual({
      message_id: 7,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://telegram.test/bot123:token/sendMessage",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ chat_id: "-1001", text: "hello" }),
      }),
    );
  });

  it("sends native mention entities without changing parse mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        status: 200,
      }),
    );
    const api = new TelegramApi({
      token: "123:token",
      fetch: fetchMock,
      baseUrl: "https://telegram.test",
    });
    const entities = [
      {
        type: "text_mention",
        offset: 0,
        length: 2,
        user: { id: 99, is_bot: false, first_name: "张三" },
      },
    ];

    await api.sendMessage("telegram:-1001", "张三 发布完成", undefined, entities);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://telegram.test/bot123:token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "-1001",
          text: "张三 发布完成",
          entities,
        }),
      }),
    );
  });

  it("maps getUpdates response to updates", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: [{ update_id: 4 }] }), {
        status: 200,
      }),
    );
    const api = new TelegramApi({ token: "t", fetch: fetchMock });

    await expect(api.getUpdates(4, 15)).resolves.toEqual([{ update_id: 4 }]);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("getUpdates");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ body: JSON.stringify({ offset: 4, timeout: 15 }) }),
    );
  });

  it("registers the native bot command menu", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
    );
    const api = new TelegramApi({
      token: "123:token",
      fetch: fetchMock,
      baseUrl: "https://telegram.test",
    });
    const commands = [
      { command: "status", description: "查看会话状态" },
      { command: "resume", description: "恢复本机会话" },
    ];

    await expect(api.setMyCommands(commands)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://telegram.test/bot123:token/setMyCommands",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ commands }),
      }),
    );
  });
});

describe("chunkTelegramText", () => {
  it("keeps Telegram messages within the 4096 character limit", () => {
    const chunks = chunkTelegramText("a".repeat(4097));
    expect(chunks.map((chunk) => chunk.length)).toEqual([4096, 1]);
  });
});
