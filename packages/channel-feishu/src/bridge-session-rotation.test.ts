import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type ChannelCommandContext, type ChannelSessionIngress } from "@codebridge/core";
import { FeishuBridge, type FeishuMessage } from "./bridge.js";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })); });

function fixture(context: Partial<ChannelCommandContext>, options: { alertChat?: boolean } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-rotation-")); roots.push(dataDir);
  const bridge = new FeishuBridge({ config: defaultConfig(), dataDir, isAlertChat: () => options.alertChat ?? false });
  const getSlotCommandContext = vi.fn(async () => ({
    sessionId: "sess_old", activeRunId: null, providerSessionId: "prov_old",
    lastActivityAt: new Date().toISOString(), contextUsed: 1_000, contextSize: 258_400, queuedTurns: 0, ...context,
  }));
  const submit = vi.fn(async () => ({ sessionId: "sess", turnId: "turn", runId: "run", acceptance: "dispatched", queueState: "ready", eventSequence: 0 }));
  const send = vi.fn(async () => ({ messageId: "sent" }));
  const internal = bridge as unknown as {
    sessionIngress: ChannelSessionIngress;
    channel: unknown;
    ensureSessionWatcher: () => unknown;
    handleMessage(message: FeishuMessage): Promise<void>;
    orchestrator: { router: { getSlotGeneration(chatId: string, topicId?: string): number } };
  };
  internal.sessionIngress = { getSlotCommandContext, submit } as unknown as ChannelSessionIngress;
  internal.channel = { send, async stream() {}, async disconnect() {} };
  internal.ensureSessionWatcher = () => ({ openCardForRun: vi.fn(async () => {}), start: vi.fn(), registerPendingTurn: vi.fn() });
  const message = (messageId: string, chatType: "p2p" | "group" = "p2p"): FeishuMessage => ({
    messageId, chatId: "oc_chat", chatType, senderId: "ou_user", content: "继续", mentionedBot: true,
  });
  return { internal, submit, send, getSlotCommandContext, message };
}

describe("automatic session rotation on the Feishu submit path", () => {
  it("starts a fresh session and tells the user when the bound context is too full", async () => {
    const f = fixture({ contextUsed: 711_489, contextSize: 828_400 });
    await f.internal.handleMessage(f.message("om_1"));
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
    expect(f.internal.orchestrator.router.getSlotGeneration("oc_chat")).toBe(1);
    expect(f.submit).toHaveBeenCalledWith(expect.objectContaining({ generation: 1, idempotencyKey: "om_1" }));
    expect(f.send).toHaveBeenCalledWith("oc_chat", { markdown: expect.stringContaining("上一会话上下文已用 86%") }, { replyTo: "om_1" });
  });

  it("resumes the bound session when it is fresh, busy, or an alert incident", async () => {
    for (const [context, options] of [
      [{}, {}],
      [{ contextUsed: 800_000, contextSize: 828_400, activeRunId: "run_busy" }, {}],
      [{ contextUsed: 800_000, contextSize: 828_400 }, { alertChat: true }],
    ] as const) {
      const f = fixture(context, options);
      await f.internal.handleMessage(f.message("om_keep", options.alertChat ? "group" : "p2p"));
      await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
      expect(f.submit).toHaveBeenCalledWith(expect.objectContaining({ generation: 0 }));
      expect(f.send).not.toHaveBeenCalledWith(expect.anything(), { markdown: expect.stringContaining("自动开启新会话") }, expect.anything());
    }
  });

  it("still submits the message when the rotation check fails", async () => {
    const f = fixture({});
    // The first lookup is handleMessage's existing bound-session check; the second is rotation.
    const ok = await f.getSlotCommandContext();
    f.getSlotCommandContext.mockReset();
    f.getSlotCommandContext.mockResolvedValueOnce(ok).mockRejectedValueOnce(new Error("bridge api down"));
    await f.internal.handleMessage(f.message("om_err"));
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
    expect(f.submit).toHaveBeenCalledWith(expect.objectContaining({ generation: 0 }));
  });
});
