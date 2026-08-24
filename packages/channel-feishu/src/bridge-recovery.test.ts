import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultConfig,
  type ChannelSessionIngress,
  type ChannelSessionEvent,
} from "@codebridge/core";

const channel = vi.hoisted(() => ({
  botIdentity: { name: "Test Bot" },
  dispatcher: { register: vi.fn() },
  on: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  updateCard: vi.fn().mockResolvedValue(undefined),
  rawClient: {
    cardkit: {
      v1: {
        card: {
          idConvert: vi.fn().mockResolvedValue({
            code: 0,
            data: { card_id: "cardkit-resolved" },
          }),
          update: vi.fn().mockResolvedValue({ code: 0 }),
        },
      },
    },
  },
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

  it("restores a terminal Run card and completes only after terminal event replay", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-recovery-"));
    const completeDelivery = vi.fn(async () => true);
    const terminal: ChannelSessionEvent = {
      type: "RUN_SUCCEEDED",
      sequence: 9,
      runId: "run_1",
      occurredAt: new Date(5_000).toISOString(),
      target: null,
      resultRef: null,
      payload: {},
    };
    const ingress = {
      listDeliveries: vi.fn(async () => [{
        turnId: "turn_1",
        sessionId: "sess_1",
        channel: "feishu",
        conversationId: "chat-1|",
        replyToMessageId: "source-1",
        surfaceMessageId: "card-terminal",
        surfaceCardId: "cardkit-terminal",
        claimOwner: "feishu:old:run_1",
        claimExpiresAt: null,
        acceptedSequence: 0,
        runId: "run_1",
        runTerminalAt: new Date(5_000).toISOString(),
        status: "delivering" as const,
        createdAt: new Date(1_000).toISOString(),
        updatedAt: new Date(5_000).toISOString(),
        runSnapshot: {
          status: "succeeded" as const,
          createdAt: new Date(1_000).toISOString(),
          updatedAt: new Date(5_000).toISOString(),
          leaseExpiresAt: null,
          terminalReason: null,
          sessionActiveRunId: null,
          sessionQueueState: "ready" as const,
        },
      }]),
      events: vi.fn(async function* (
        _sessionId: string,
        options: { signal: AbortSignal },
      ) {
        yield terminal;
        await new Promise<void>((resolve) =>
          options.signal.addEventListener("abort", () => resolve()),
        );
      }),
      completeDelivery,
    } as unknown as ChannelSessionIngress;
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir,
      sessionIngress: ingress,
    });

    await bridge.connect();
    const startedAt = Date.now();
    while (completeDelivery.mock.calls.length === 0) {
      if (Date.now() - startedAt > 2_000) throw new Error("completion timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(JSON.stringify(
      channel.rawClient.cardkit.v1.card.update.mock.calls[0]?.[0],
    )).toContain(
      "✅ **已完成**",
    );
    expect(channel.rawClient.cardkit.v1.card.update).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { card_id: "cardkit-terminal" },
      }),
    );
    expect(completeDelivery).toHaveBeenCalledWith(
      "turn_1",
      "feishu:old:run_1",
    );
    await bridge.disconnect();
  });

  it("treats a nonzero CardKit response as a failed surface write", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-recovery-"));
    const bridge = new FeishuBridge({
      config: defaultConfig(),
      dataDir,
    });
    await bridge.connect();
    channel.rawClient.cardkit.v1.card.update.mockResolvedValueOnce({
      code: 999,
      msg: "rejected",
    });
    const host = (bridge as unknown as {
      cardHost(): { updateCard(cardId: string, card: object): Promise<void> };
    }).cardHost();

    await expect(host.updateCard("cardkit-1", { schema: "2.0" }))
      .rejects.toThrow("CardKit update failed (999): rejected");

    await bridge.disconnect();
  });
});
