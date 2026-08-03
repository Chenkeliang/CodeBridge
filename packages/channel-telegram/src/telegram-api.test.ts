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
});

describe("chunkTelegramText", () => {
  it("keeps Telegram messages within the 4096 character limit", () => {
    const chunks = chunkTelegramText("a".repeat(4097));
    expect(chunks.map((chunk) => chunk.length)).toEqual([4096, 1]);
  });
});
