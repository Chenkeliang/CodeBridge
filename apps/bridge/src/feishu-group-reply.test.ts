import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { defaultConfig } from "@codebridge/core";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionCoordinator } from "@codebridge/session-coordinator";
import { FeishuBridge, type FeishuMessage } from "../../../packages/channel-feishu/src/bridge.js";
import { createSessionApp } from "./session-api.js";
import { createOutboundApp } from "./outbound-api.js";
import { createChannelSessionIngress } from "./channel-ingress.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-group-reply-"));
  const config = defaultConfig();
  config.defaultBackend = "codex";
  config.workspaces = { root };
  config.feishu.policy = { requireMention: true, dmMode: "open", respondToMentionAll: false, groupAllowlist: ["oc_group"] };
  const catalog = new SessionCatalogStore(path.join(root, "catalog.sqlite"));
  const store = new SqliteEventStore(path.join(root, "events.sqlite"));
  const coordinator = new SessionCoordinator(store, { maxQueuedTurns: 100 });
  const app = createSessionApp({ catalog, workItems: store, coordinator, defaultCwd: root,
    agents: [{ agentId: "codex", displayName: "Codex", adapter: "acp", status: "healthy", capabilities: [], models: [], sessionFeatures: [] }],
  }, "test-token");
  const ingress = createChannelSessionIngress(app, "test-token");
  // Keep the real API, database, queue and card writer; no model or network connection.
  ingress.events = async function* (_id, { signal }) {
    if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  let count = 0;
  const cards: object[] = [];
  const updates: object[] = [];
  const reply = vi.fn(async (_request: unknown) => ({ code: 0, data: { message_id: `om_bot_${++count}` } }));
  const send = vi.fn(async () => ({ messageId: `om_notice_${++count}` }));
  const channel = { send, disconnect: async () => {}, rawClient: {
    im: { v1: { message: { reply, get: vi.fn(async ({ path: p }: { path: { message_id: string } }) => ({ code: 0, data: { items: [{ message_id: p.message_id, msg_type: "text", body: { content: JSON.stringify({ text: `原文 ${p.message_id}` }) }, sender: { id: "ou_quoted", sender_type: "user" } }] } })) } } },
    cardkit: { v1: { card: {
      create: vi.fn(async ({ data }: { data: { data: string } }) => { cards.push(JSON.parse(data.data)); return { code: 0, data: { card_id: `entity_${cards.length}` } }; }),
      idConvert: vi.fn(async () => ({ code: 0, data: { card_id: `entity_${cards.length}` } })),
      update: vi.fn(async (request: { data: { card: { data: string } } }) => { updates.push(JSON.parse(request.data.card.data)); return { code: 0 }; }), settings: vi.fn(async () => ({ code: 0 })),
    }, cardElement: { content: vi.fn(async () => ({ code: 0 })), update: vi.fn(async () => ({ code: 0 })) } } },
  } };
  const bridges: FeishuBridge[] = [];
  const tasks = new Map<string, Promise<void>>();
  function restart() {
    const bridge = new FeishuBridge({ config, dataDir: root, sessionIngress: ingress });
    const internal = bridge as unknown as { channel: unknown; handleMessage(msg: FeishuMessage): Promise<void>; dispatchInboundMessage(msg: FeishuMessage): Promise<void>; reconcileDeliveries(): Promise<void>; submitAndStream(msg: FeishuMessage, prompt: string, topic?: string): Promise<void> };
    internal.channel = channel;
    const submit = internal.submitAndStream.bind(internal);
    internal.submitAndStream = (msg, prompt, topic) => {
      const pending = submit(msg, prompt, topic);
      tasks.set(msg.messageId, pending);
      return pending;
    };
    bridges.push(bridge);
    return { bridge, internal };
  }
  cleanups.push(async () => { for (const bridge of bridges) await bridge.disconnect(); store.close(); catalog.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function receive(id: string, senderId = "ou_alice", extra: Partial<FeishuMessage> = {}, internal = current.internal) {
    await internal.dispatchInboundMessage({ messageId: id, chatId: "oc_group", chatType: "group", senderId, content: `问题 ${id}`, mentionedBot: true, ...extra });
    await tasks.get(id);
    await vi.waitFor(() => expect(store.listDeliveries("feishu").some((d) => d.replyToMessageId === id)).toBe(true));
    await vi.waitFor(() => expect(store.listDeliveries("feishu").filter((d) => d.replyToMessageId === id && d.runId).every((d) => d.surfaceMessageId)).toBe(true));
    return store.listDeliveries("feishu").find((d) => d.replyToMessageId === id)!;
  }
  const current = restart();
  return { ...current, restart, receive, config, store, catalog, coordinator, ingress, reply, cards, updates, send, app, channel };
}

describe("Feishu shared group conversations through the active adapter", () => {
  it("isolates independent questions and replies in the group with each actual sender mentioned", async () => {
    const f = fixture();
    const a = await f.receive("om_a");
    const b = await f.receive("om_b", "ou_bob");
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.conversationId).toBe("oc_group|om_a");
    expect(b.conversationId).toBe("oc_group|om_b");
    expect(f.cards[0]).toMatchObject({ body: { elements: expect.arrayContaining([expect.objectContaining({ element_id: "recipient", content: '<at id="ou_alice"></at>' })]) } });
    expect(f.cards[1]).toMatchObject({ body: { elements: expect.arrayContaining([expect.objectContaining({ element_id: "recipient", content: '<at id="ou_bob"></at>' })]) } });
    for (const [request] of f.reply.mock.calls) expect((request as { data: { reply_in_thread?: boolean } }).data.reply_in_thread).not.toBe(true);
  });

  it("continues a referenced reply across people and Bridge restart, with a durable per-turn recipient", async () => {
    const f = fixture();
    const a = await f.receive("om_a");
    await f.bridge.disconnect();
    const restarted = f.restart();
    const b = await f.receive("om_b", "ou_bob", { rootId: "om_a", replyToMessageId: a.surfaceMessageId!, mentionedBot: false }, restarted.internal);
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.status).toBe("pending");
    expect(b).toMatchObject({ replyContext: { senderId: "ou_bob" } });
    expect(await f.ingress.listDeliveries("feishu", undefined, a.surfaceMessageId!)).toEqual(expect.arrayContaining([expect.objectContaining({ turnId: a.turnId })]));
    expect(await f.ingress.listDeliveries("feishu", undefined, "om_b")).toEqual(expect.arrayContaining([expect.objectContaining({ turnId: b.turnId })]));
  });

  it("does not trigger for unmentioned chatter or an unrelated human reply", async () => {
    const f = fixture();
    await f.receive("om_a");
    await f.internal.handleMessage({ messageId: "om_noise", chatId: "oc_group", chatType: "group", senderId: "ou_bob", content: "闲聊", rootId: "om_a", replyToMessageId: "om_a" });
    expect(f.store.listDeliveries("feishu")).toHaveLength(1);
  });

  it("lets configured group members ask while retaining private-chat and approval restrictions", async () => {
    const f = fixture();
    f.config.access = { allowedUsers: ["ou_owner"], allowedChats: ["oc_group"], admins: ["ou_owner"] };
    await f.receive("om_member", "ou_bob");
    const resolvePermission = vi.spyOn(f.ingress, "resolvePermission");
    await f.internal.handleMessage({ messageId: "om_approve", chatId: "oc_group", chatType: "group", senderId: "ou_bob", content: "/approve", mentionedBot: true, replyToMessageId: "om_member" });
    expect(resolvePermission).not.toHaveBeenCalled();
    expect(JSON.stringify(f.send.mock.calls)).toContain("权限");
    await f.internal.handleMessage({ messageId: "om_dm", chatId: "oc_dm", chatType: "p2p", senderId: "ou_bob", content: "private" });
    expect(f.store.listDeliveries("feishu")).toHaveLength(1);
  });

  it("opens a queued reply for its own sender and preserves the mention during terminal recovery", async () => {
    const f = fixture();
    const a = await f.receive("om_a");
    const b = await f.receive("om_b", "ou_bob", { replyToMessageId: a.surfaceMessageId!, rootId: "om_a" });
    expect(b.status).toBe("pending");
    await f.bridge.disconnect();
    const next = f.restart();
    f.coordinator.finishRun({ sessionId: a.sessionId, runId: a.runId!, status: "succeeded" });
    await next.internal.reconcileDeliveries();
    expect(f.cards.at(-1)).toMatchObject({ body: { elements: expect.arrayContaining([
      expect.objectContaining({ element_id: "recipient", content: '<at id="ou_bob"></at>' }),
    ]) } });
    const active = f.store.listDeliveries("feishu").find((d) => d.turnId === b.turnId)!;
    expect(active.surfaceMessageId).toBeTruthy();
    await next.bridge.disconnect();
    const final = f.restart();
    f.coordinator.finishRun({ sessionId: b.sessionId, runId: active.runId!, status: "succeeded" });
    await final.internal.reconcileDeliveries();
    expect(f.updates.at(-1)).toMatchObject({ config: { streaming_mode: false }, body: { elements: expect.arrayContaining([
      expect.objectContaining({ element_id: "recipient", content: '<at id="ou_bob"></at>' }),
    ]) } });
    expect(f.store.listDeliveries("feishu", active.surfaceMessageId!)[0]?.status).toBe("completed");
  });

  it("never joins another group's session through a quoted message id", async () => {
    const f = fixture();
    const a = await f.receive("om_a");
    f.config.feishu.policy!.groupAllowlist!.push("oc_other");
    const b = await f.receive("om_other", "ou_bob", { chatId: "oc_other", replyToMessageId: a.surfaceMessageId! });
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.conversationId.startsWith("oc_other|")).toBe(true);
  });

  it("rejects forged per-turn recipients at the channel API boundary", async () => {
    const f = fixture();
    const response = await f.app.request("/v1/channels/feishu/conversations/oc_group%7Com_fake/messages", {
      method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json", "idempotency-key": "fake" },
      body: JSON.stringify({ message: "hello", agent_id: "codex", cwd: f.config.workspaces!.root,
        actor_ref: { channel: "feishu", id: "ou_alice" }, reply_to_message_id: "om_fake", show_thinking: false,
        reply_context: { senderId: "ou_bob" },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_reply_context" });
    expect(f.store.listDeliveries("feishu")).toHaveLength(0);
  });

  it("anchors Agent outbound messages to the current Run despite later queued questions", async () => {
    const f = fixture();
    const a = await f.receive("om_a");
    await f.receive("om_b", "ou_bob", { replyToMessageId: a.surfaceMessageId!, rootId: "om_a" });
    f.store.updateRunControl(a.runId!, { status: "running", leaseOwner: "test", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    const app = createOutboundApp(f.bridge, "outbound-token", { workItemStore: f.store });
    const response = await app.request("/outbound/markdown", {
      method: "POST", headers: { authorization: "Bearer outbound-token", "content-type": "application/json" },
      body: JSON.stringify({ runId: a.runId, markdown: "本轮结果", chatId: "oc_wrong", topicId: "wrong", sourceMessageId: "om_b" }),
    });
    expect(response.status).toBe(200);
    expect(f.send).toHaveBeenLastCalledWith("oc_group", { markdown: "本轮结果" }, {
      replyTo: "om_a", mentions: [{ key: "requester", openId: "ou_alice", isBot: false }],
    });
  });

  it("recognizes a non-primary bot reply by the official message lookup", async () => {
    const f = fixture();
    const a = await f.receive("om_a");
    f.channel.rawClient.im.v1.message.get.mockResolvedValueOnce({ code: 0, data: { items: [{
      message_id: "om_tool_reply", chat_id: "oc_group", sender: { id: f.config.feishu.appId, sender_type: "app" },
    }] } } as never);
    const b = await f.receive("om_b", "ou_bob", { replyToMessageId: "om_tool_reply", rootId: "om_a", mentionedBot: false });
    expect(b.sessionId).toBe(a.sessionId);
  });

  it("persists recipients across database reopen and uses both exact message indexes", async () => {
    const f = fixture();
    const a = await f.receive("om_a");
    const reopened = new SqliteEventStore(path.join(f.config.workspaces!.root!, "events.sqlite"));
    try {
      expect(reopened.listDeliveries("feishu", undefined, "om_a")[0]).toMatchObject({ replyContext: { senderId: "ou_alice" } });
      const database = (reopened as unknown as { database: DatabaseSync }).database;
      const prepare = database.prepare.bind(database);
      let lookup = "";
      const spy = vi.spyOn(database, "prepare").mockImplementation((sql) => {
        if (sql.includes("AS reply_context")) lookup = sql;
        return prepare(sql);
      });
      expect(reopened.listDeliveries("feishu", undefined, a.surfaceMessageId!)[0]?.turnId).toBe(a.turnId);
      spy.mockRestore();
      const plan = prepare(`EXPLAIN QUERY PLAN ${lookup}`).all("feishu", a.surfaceMessageId!, "feishu", a.surfaceMessageId!);
      const detail = plan.map((row) => row.detail).join("\n");
      expect(detail).toMatch(/channel_delivery_source_message.*reply_to_message_id=\?/);
      expect(detail).toMatch(/channel_delivery_surface_message.*surface_message_id=\?/);
    } finally { reopened.close(); }
  });

  it("keeps referenced context when a user opens a native thread on an existing answer", async () => {
    const f = fixture();
    const a = await f.receive("om_a");
    const b = await f.receive("om_b", "ou_bob", { replyToMessageId: a.surfaceMessageId!, rootId: "om_a", threadId: "omt_native" });
    expect(b.sessionId).toBe(a.sessionId);
    expect(b).toMatchObject({ replyContext: { senderId: "ou_bob", threadId: "omt_native" } });
  });

  it("deduplicates input and keeps an existing Feishu thread", async () => {
    const f = fixture();
    const a = await f.receive("om_thread", "ou_alice", { threadId: "omt_real" });
    const duplicate = await f.receive("om_thread", "ou_alice", { threadId: "omt_real" });
    expect(a.turnId).toBe(duplicate.turnId);
    expect(f.reply).toHaveBeenCalledTimes(1);
    expect(f.reply).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reply_in_thread: true }) }));
  });
});
