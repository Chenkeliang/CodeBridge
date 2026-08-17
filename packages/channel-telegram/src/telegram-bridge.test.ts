import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type AgentEvent, type ChannelSessionIngress } from "@codebridge/core";
import { TelegramBridge } from "./telegram-bridge.js";

const tmpDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("TelegramBridge inbound commands", () => {
  it("registers native commands before polling", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-telegram-"));
    tmpDirs.push(dataDir);
    const config = defaultConfig();
    config.telegram = { botToken: "123:token", pollingTimeoutSec: 25 };
    const calls: string[] = [];
    const bridge = new TelegramBridge({
      config,
      dataDir,
      api: {
        getMe: vi.fn().mockResolvedValue({ username: "bridge_bot" }),
        setMyCommands: vi.fn().mockImplementation(async (commands) => {
          calls.push("commands");
          expect(commands).toEqual(
            expect.arrayContaining([
              { command: "status", description: expect.any(String) },
              { command: "resume", description: expect.any(String) },
              { command: "permission", description: expect.any(String) },
            ]),
          );
          return true;
        }),
        getUpdates: vi.fn().mockImplementation(async (_offset, _timeout, signal) => {
          calls.push("poll");
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          return [];
        }),
      } as never,
    });

    await bridge.connect();
    expect(calls.slice(0, 2)).toEqual(["commands", "poll"]);
    await bridge.disconnect();
  });

  it("continues polling when native command registration is unavailable", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-telegram-"));
    tmpDirs.push(dataDir);
    const config = defaultConfig();
    config.telegram = { botToken: "123:token", pollingTimeoutSec: 25 };
    const calls: string[] = [];
    const onLog = vi.fn();
    const bridge = new TelegramBridge({
      config,
      dataDir,
      onLog,
      api: {
        getMe: vi.fn().mockResolvedValue({ username: "bridge_bot" }),
        setMyCommands: vi.fn().mockRejectedValue(new Error("metadata timeout")),
        getUpdates: vi.fn().mockImplementation(async (_offset, _timeout, signal) => {
          calls.push("poll");
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          return [];
        }),
      } as never,
    });

    await bridge.connect();
    expect(calls).toEqual(["poll"]);
    expect(onLog).toHaveBeenCalledWith(
      expect.stringContaining("原生命令菜单注册失败"),
    );
    await bridge.disconnect();
  });

  it("routes a Telegram command through the shared slash-command handler", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-telegram-"));
    tmpDirs.push(dataDir);
    const config = defaultConfig();
    config.telegram = { botToken: "123:token", pollingTimeoutSec: 25 };
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 8 });
    const bridge = new TelegramBridge({
      config,
      dataDir,
      api: { sendMessage } as never,
    });

    await bridge.handleUpdate({
      update_id: 1,
      message: {
        message_id: 7,
        chat: { id: 42, type: "private" },
        from: { id: 99 },
        text: "/status",
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "telegram:42",
      expect.stringContaining("**backend**"),
      undefined,
    );
  });

  it("renders Telegram help without Markdown markers", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-telegram-"));
    tmpDirs.push(dataDir);
    const config = defaultConfig();
    config.telegram = { botToken: "123:token", pollingTimeoutSec: 25 };
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 8 });
    const bridge = new TelegramBridge({
      config,
      dataDir,
      api: { sendMessage } as never,
    });

    await bridge.handleUpdate({
      update_id: 1,
      message: {
        message_id: 7,
        chat: { id: 42, type: "private" },
        from: { id: 99 },
        text: "/help full",
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "telegram:42",
      expect.not.stringMatching(/[`*]/),
      undefined,
    );
  });

  it("ignores users outside the Telegram allowlist", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-telegram-"));
    tmpDirs.push(dataDir);
    const config = defaultConfig();
    config.telegram = {
      botToken: "123:token",
      pollingTimeoutSec: 25,
      allowedUsers: ["100"],
    };
    const sendMessage = vi.fn();
    const bridge = new TelegramBridge({
      config,
      dataDir,
      api: { sendMessage } as never,
    });

    await bridge.handleUpdate({
      update_id: 1,
      message: {
        message_id: 7,
        chat: { id: 42, type: "private" },
        from: { id: 99 },
        text: "/status",
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends an immediate TCC status before the final /root add reply", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-telegram-"));
    tmpDirs.push(dataDir);
    const config = defaultConfig();
    config.telegram = { botToken: "123:token", pollingTimeoutSec: 25 };
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 8 });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, path: "/mock/tcc-project" })),
      ),
    );
    const bridge = new TelegramBridge({
      config,
      dataDir,
      api: { sendMessage } as never,
    });

    await bridge.handleUpdate({
      update_id: 1,
      message: {
        message_id: 7,
        chat: { id: 42, type: "private" },
        from: { id: 99 },
        text: "/root add /mock/tcc-project",
      },
    });

    expect(sendMessage.mock.calls.map((call) => call[1])).toEqual([
      expect.stringContaining("正在请求 macOS 目录权限"),
      expect.stringContaining("已添加 ACP 附加目录"),
    ]);
  });

  it("guides the Agent and sends a real scoped Telegram mention", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-telegram-"));
    tmpDirs.push(dataDir);
    const config = defaultConfig();
    config.telegram = { botToken: "123:token", pollingTimeoutSec: 25 };
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 8 });
    const editMessage = vi.fn().mockResolvedValue({ message_id: 8 });
    const bridge = new TelegramBridge({
      config,
      dataDir,
      api: { sendMessage, editMessage } as never,
    });
    let receivedPrompt = "";
    const testable = bridge as unknown as {
      orchestrator: {
        runAgent(
          chatId: string,
          topicId: string | undefined,
          prompt: string,
        ): AsyncGenerator<AgentEvent>;
      };
      sendOutboundMention(
        chatId: string,
        ref: string,
        text: string,
        topicId?: string,
      ): Promise<void>;
    };
    testable.orchestrator.runAgent = async function* (
      _chatId,
      _topicId,
      prompt,
    ) {
      receivedPrompt = prompt;
      yield { type: "text_delta", text: "处理完成" };
      yield { type: "done", exitCode: 0 };
    };

    await bridge.handleUpdate({
      update_id: 1,
      message: {
        message_id: 7,
        chat: { id: 42, type: "group" },
        from: { id: 99, first_name: "陈科良" },
        text: "完成后通知 张三 和 @reviewer",
        entities: [
          {
            type: "text_mention",
            offset: 6,
            length: 2,
            user: { id: 100, first_name: "张三", is_bot: false },
          },
          { type: "mention", offset: 11, length: 9 },
        ],
      },
    });
    await bridge.disconnect();

    expect(receivedPrompt).toContain("fcb mention <对象引用>");
    expect(receivedPrompt).toContain("陈科良（当前发送者）");
    expect(receivedPrompt).toContain("张三");
    expect(receivedPrompt).toContain("reviewer");
    const ref = receivedPrompt.match(/- (u\d+)：张三/)?.[1];
    expect(ref).toBeDefined();

    await testable.sendOutboundMention(
      "telegram:42",
      ref!,
      "发布已经完成",
    );

    expect(sendMessage).toHaveBeenLastCalledWith(
      "telegram:42",
      "张三 发布已经完成",
      undefined,
      [
        {
          type: "text_mention",
          offset: 0,
          length: 2,
          user: { id: 100, is_bot: false, first_name: "张三" },
        },
      ],
    );
  });

  it("uses the shared Session ingress for ordinary messages", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-telegram-"));
    tmpDirs.push(dataDir);
    const config = defaultConfig();
    config.telegram = { botToken: "123:token", pollingTimeoutSec: 25 };
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 8 });
    const editMessage = vi.fn().mockResolvedValue({ message_id: 8 });
    const received: unknown[] = [];
    const bridge = new TelegramBridge({
      config,
      dataDir,
      api: { sendMessage, editMessage } as never,
      sessionIngress: (async function* (message: Parameters<ChannelSessionIngress>[0]) {
        received.push(message);
        yield { type: "text_delta", text: "Session reply" };
        yield { type: "done", exitCode: 0 };
      }) as unknown as ChannelSessionIngress,
    });

    await bridge.handleUpdate({
      update_id: 2,
      message: {
        message_id: 9,
        chat: { id: 42, type: "private" },
        from: { id: 99 },
        text: "hello",
      },
    });
    await bridge.disconnect();

    expect(received).toEqual([
      expect.objectContaining({
        channel: "telegram",
        conversationId: "telegram:42|",
        message: expect.stringContaining("hello"),
      }),
    ]);
    expect(editMessage).toHaveBeenCalledWith("telegram:42", 8, "Session reply");
  });
});
