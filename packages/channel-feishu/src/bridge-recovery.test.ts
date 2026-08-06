import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@codebridge/core";

const channel = vi.hoisted(() => ({
  botIdentity: { name: "Test Bot" },
  dispatcher: { register: vi.fn() },
  on: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  updateCard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  LoggerLevel: { info: "info" },
  createLarkChannel: () => channel,
}));

import { FeishuBridge } from "./bridge.js";

describe("FeishuBridge interrupted stream recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaces an unfinished streaming card after reconnecting", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-recovery-"));
    const pendingPath = path.join(dataDir, "feishu-pending-streams.json");
    fs.writeFileSync(
      pendingPath,
      JSON.stringify({
        "card-message-1": {
          chatId: "chat-1",
          sourceMessageId: "source-message-1",
          startedAt: "2026-08-06T11:27:14.423Z",
        },
      }),
    );
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir,
    });

    await bridge.connect();

    expect(channel.updateCard).toHaveBeenCalledWith(
      "card-message-1",
      expect.objectContaining({ schema: "2.0" }),
    );
    expect(JSON.stringify(channel.updateCard.mock.calls[0]?.[1])).toContain(
      "服务重启",
    );
    expect(JSON.parse(fs.readFileSync(pendingPath, "utf8"))).toEqual({});
  });
});
