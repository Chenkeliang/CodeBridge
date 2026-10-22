import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultConfig } from "@codebridge/core";
import { FeishuBridge } from "@codebridge/channel-feishu";
import { TelegramBridge } from "@codebridge/channel-telegram";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
it("reads native Feishu member identities with the official SDK's pagination contract", async () => {
  const get = vi.fn().mockResolvedValueOnce({ code: 0, data: { items: [{ member_id: "ou_first", name: "First" }, { member_id: "cli_bot" }], has_more: true, page_token: "next" } })
    .mockResolvedValueOnce({ code: 0, data: { items: [{ member_id: "ou_second", name: "Second" }], has_more: false } });
  const bridge = Object.create(FeishuBridge.prototype);
  bridge.channel = { rawClient: { im: { v1: { chatMembers: { get } } } } };
  expect(await bridge.listManagedChatMembers("oc_fixture")).toEqual([{ id: "ou_first", name: "First" }, { id: "ou_second", name: "Second" }]);
  expect(get.mock.calls[1][0]).toEqual({ path: { chat_id: "oc_fixture" }, params: { member_id_type: "open_id", page_size: 100, page_token: "next" } });
  get.mockResolvedValueOnce({ code: 0, data: { has_more: true } });
  await expect(bridge.listManagedChatMembers("oc_fixture")).rejects.toThrow("分页不完整");
});
it("enforces configured Telegram group administrators while leaving ordinary help available", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-managed-channel-")); roots.push(dataDir);
  const config = defaultConfig(); config.telegram = { botToken: "fixture-token", admins: ["1"], allowedChats: ["-20"], pollingTimeoutSec: 25 };
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
  const bridge = new TelegramBridge({ config, dataDir, api: { sendMessage } as never });
  await bridge.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: -20, type: "group" }, from: { id: 2 }, text: "/model" } });
  expect(sendMessage.mock.calls[0][1]).toContain("管理员权限");
  sendMessage.mockClear();
  await bridge.handleUpdate({ update_id: 2, message: { message_id: 2, chat: { id: -20, type: "group" }, from: { id: 2 }, text: "/help" } });
  expect(sendMessage).toHaveBeenCalled(); expect(JSON.stringify(sendMessage.mock.calls)).not.toContain("管理员权限");
});

it("reads named groups with all SDK pages and rejects an incomplete directory", async () => {
  const list = vi.fn().mockResolvedValueOnce({ code: 0, data: { items: [{ chat_id: "oc_first", name: "First group" }], has_more: true, page_token: "next" } })
    .mockResolvedValueOnce({ code: 0, data: { items: [{ chat_id: "oc_second", name: "Second group" }], has_more: false } });
  const bridge = Object.create(FeishuBridge.prototype);
  bridge.channel = { rawClient: { im: { v1: { chat: { list } } } } };
  expect(await bridge.listManagedChats()).toEqual([{ id: "oc_first", name: "First group" }, { id: "oc_second", name: "Second group" }]);
  expect(list.mock.calls[1][0].params.page_token).toBe("next");
  list.mockResolvedValueOnce({ code: 0, data: { has_more: true } });
  await expect(bridge.listManagedChats()).rejects.toThrow("分页不完整");
  list.mockResolvedValueOnce({ code: 99991672, msg: "permission denied" });
  await expect(bridge.listManagedChats()).rejects.toThrow("permission denied");
});
it("derives source choices from recent app messages without mistaking titles for bot names", async () => {
  const list = vi.fn().mockResolvedValue({ code: 0, data: { items: [
    { sender: { id: "cli_self", sender_type: "app" }, msg_type: "text", body: { content: '{"text":"Own response"}' } },
    { sender: { id: "ou_user", sender_type: "user" }, msg_type: "text", body: { content: '{"text":"Human text"}' } },
    { sender: { id: "cli_alarm", sender_type: "app" }, msg_type: "text", body: { content: '{"text":"Synthetic alarm"}' } },
    { sender: { id: "cli_alarm", sender_type: "app" }, msg_type: "text", body: { content: '{"text":"Older duplicate"}' } },
  ] } });
  const bridge = Object.create(FeishuBridge.prototype);
  bridge.config = { feishu: { appId: "cli_self" } };
  bridge.channel = { rawClient: { im: { v1: { message: { list } } } } };
  expect(await bridge.listManagedAlertSources("oc_fixture")).toEqual([{ id: "cli_alarm", preview: "Synthetic alarm" }]);
  expect(list.mock.calls[0][0].params).toMatchObject({ container_id: "oc_fixture", sort_type: "ByCreateTimeDesc", page_size: 50 });
});

it("reports Telegram's actual active polling and shutdown instead of a configured flag", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-telegram-health-")); roots.push(dataDir);
  const config = defaultConfig(); config.telegram = { botToken: "12345:fixture_token", allowedUsers: ["101"], pollingTimeoutSec: 25 };
  const bridge = new TelegramBridge({ config, dataDir, api: {
    getMe: async () => ({ username: "fixture_bot" }),
    getUpdates: async (_offset: number, _timeout: number, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
  } as never });
  expect(bridge.isConnected).toBe(false); await bridge.connect();
  expect(bridge.isConnected).toBe(true); expect(bridge.displayName).toBe("@fixture_bot");
  await bridge.disconnect(); expect(bridge.isConnected).toBe(false);
});
it("does not report Telegram online while polling has failed", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-telegram-failed-poll-")); roots.push(dataDir);
  const config = defaultConfig(); config.telegram = { botToken: "12345:fixture_token", allowedUsers: ["101"], pollingTimeoutSec: 25 };
  const bridge = new TelegramBridge({ config, dataDir, api: { getMe: async () => ({ username: "fixture_bot" }), getUpdates: async () => { throw new Error("fixture network unavailable"); } } as never });
  await bridge.connect(); await vi.waitFor(() => expect(bridge.isConnected).toBe(false));
  await bridge.disconnect();
});
