import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createChannelSessionIngress } from "./channel-ingress.js";

function sse(events: string[]): Response {
  return new Response(
    events.map((data) => `data: ${data}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("channel session ingress", () => {
  it("submits a channel message and returns a receipt", async () => {
    const app = new Hono();
    app.post("/v1/channels/:channel/conversations/:conversation/messages", async (c) => {
      expect(c.req.param("channel")).toBe("feishu");
      const body = await c.req.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        message: "hello",
        agent_id: "pi",
        generation: 0,
        reply_to_message_id: "msg_1",
      });
      expect(body).not.toHaveProperty("flow_id");
      expect(body).not.toHaveProperty("definition_revision");
      return c.json({
        session_id: "sess_1",
        turn_id: "turn_1",
        run_id: "run_1",
        acceptance: "dispatched",
        queue_state: "ready",
        event_sequence: 3,
      }, 202);
    });
    const ingress = createChannelSessionIngress(app, "token");
    const receipt = await ingress.submit({
      channel: "feishu",
      conversationId: "chat|topic",
      message: "hello",
      agentId: "pi",
      generation: 0,
      replyToMessageId: "msg_1",
    });
    expect(receipt).toEqual({
      sessionId: "sess_1",
      turnId: "turn_1",
      runId: "run_1",
      acceptance: "dispatched",
      queueState: "ready",
      eventSequence: 3,
    });
  });

  it("submits a complete Flow invocation and actor identity", async () => {
    const app = new Hono();
    app.post("/v1/channels/:channel/conversations/:conversation/messages", async (c) => {
      expect(await c.req.json()).toMatchObject({
        flow_id: "flow_demo",
        definition_revision: "sha256:one",
        actor_ref: { channel: "telegram", id: "user_1" },
      });
      return c.json({
        session_id: "sess_1",
        turn_id: "turn_1",
        run_id: "run_1",
        acceptance: "dispatched",
        queue_state: "ready",
        event_sequence: 3,
      }, 202);
    });
    const ingress = createChannelSessionIngress(app, "token");
    await ingress.submit({
      channel: "telegram",
      conversationId: "chat|topic",
      message: "run",
      flowId: "flow_demo",
      flowDefinitionRevision: "sha256:one",
      actorRef: { channel: "telegram", id: "user_1" },
    });
  });

  it.each([
    { flowId: "flow_demo" },
    { flowDefinitionRevision: "sha256:one" },
  ])("rejects an incomplete channel Flow invocation", async (partial) => {
    const app = new Hono();
    const ingress = createChannelSessionIngress(app, "token");
    await expect(ingress.submit({
      channel: "feishu",
      conversationId: "chat",
      message: "run",
      ...partial,
    })).rejects.toThrow("flow_invocation_incomplete");
  });

  it("lists only the fixed consume view", async () => {
    const app = new Hono();
    app.get("/v1/flows", (c) => {
      expect(c.req.query("view")).toBe("consume");
      return c.json({
        flows: [{
          flow_id: "flow_demo",
          name: "Demo",
          definition_revision: "sha256:one",
        }],
      });
    });
    const ingress = createChannelSessionIngress(app, "token");
    await expect(ingress.listConsumableFlows()).resolves.toEqual([{
      flowId: "flow_demo",
      name: "Demo",
      definitionRevision: "sha256:one",
    }]);
  });

  it("resumes a provider session into a slot", async () => {
    const app = new Hono();
    app.post("/v1/channels/:channel/conversations/:conversation/resume", async (c) => {
      expect(c.req.param("channel")).toBe("feishu");
      expect(c.req.param("conversation")).toBe("chat|topic");
      expect(await c.req.json()).toEqual({
        agent_id: "pi",
        workspace_key: "ws_1",
        generation: 3,
        provider_session_id: "provider_old",
      });
      return c.json({ session_id: "sess_9" }, 200);
    });
    const ingress = createChannelSessionIngress(app, "token");
    const result = await ingress.resumeProviderSession({
      channel: "feishu",
      conversationId: "chat|topic",
      agentId: "pi",
      workspaceKey: "ws_1",
      generation: 3,
    }, "provider_old");
    expect(result).toEqual({ sessionId: "sess_9" });
  });

  it("throws the provider_session_busy code with detail on the error", async () => {
    const app = new Hono();
    app.post("/v1/channels/:channel/conversations/:conversation/resume", async (c) => {
      return c.json({
        error: "provider_session_busy",
        detail: "provider session p 正被 run r 使用",
      }, 409);
    });
    const ingress = createChannelSessionIngress(app, "token");
    let thrown: Error & { detail?: string } | undefined;
    try {
      await ingress.resumeProviderSession({
        channel: "feishu",
        conversationId: "chat|topic",
        agentId: "pi",
        workspaceKey: "ws_1",
        generation: 0,
      }, "p");
    } catch (err) {
      thrown = err as Error & { detail?: string };
    }
    // 只 throw 错误码（bridge 精确匹配依赖 message === "provider_session_busy"）。
    expect(thrown?.message).toBe("provider_session_busy");
    expect(thrown?.detail).toContain("正被 run r 使用");
  });

  it("streams raw channel session events", async () => {
    const app = new Hono();
    app.get("/v1/sessions/:session/events", (c) => {
      expect(c.req.query("after_sequence")).toBe("3");
      expect(c.req.query("live")).toBe("true");
      return sse([
        '{"type":"AGENT_EVENT","sequence":4,"runId":"run_1","target":null,"payload":{"event":{"type":"text_delta","text":"ok"}}}',
        '{"type":"RUN_SUCCEEDED","sequence":5,"runId":"run_1","target":null,"payload":{}}',
      ]);
    });
    const ingress = createChannelSessionIngress(app, "token");
    const events = [];
    for await (const event of ingress.events("sess_1", {
      afterSequence: 3,
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        type: "AGENT_EVENT",
        sequence: 4,
        runId: "run_1",
        target: null,
        payload: { event: { type: "text_delta", text: "ok" } },
      },
      {
        type: "RUN_SUCCEEDED",
        sequence: 5,
        runId: "run_1",
        target: null,
        payload: {},
      },
    ]);
  });

  it("claims, acks and completes a delivery through the delivery routes", async () => {
    const app = new Hono();
    app.post("/v1/deliveries/:turn/claim", async (c) => {
      expect(c.req.param("turn")).toBe("turn_1");
      expect(await c.req.json()).toEqual({ owner: "owner-1" });
      return c.json({ claimed: true });
    });
    app.post("/v1/deliveries/:turn/ack", async (c) => {
      expect(await c.req.json()).toEqual({ owner: "owner-1", surface_message_id: "card-1" });
      return c.json({ acked: true });
    });
    app.post("/v1/deliveries/:turn/complete", async (c) => {
      expect(await c.req.json()).toEqual({ owner: "owner-1" });
      return c.json({ completed: true });
    });
    const ingress = createChannelSessionIngress(app, "token");
    expect(await ingress.claimDelivery("turn_1", "owner-1")).toBe(true);
    expect(await ingress.ackDelivery("turn_1", "owner-1", "card-1")).toBe(true);
    expect(await ingress.completeDelivery("turn_1", "owner-1")).toBe(true);
  });

  it("lists deliveries by channel", async () => {
    const app = new Hono();
    app.get("/v1/deliveries", (c) => {
      expect(c.req.query("channel")).toBe("feishu");
      return c.json({ deliveries: [{ turnId: "turn_1", status: "pending" }] });
    });
    const ingress = createChannelSessionIngress(app, "token");
    const deliveries = await ingress.listDeliveries("feishu");
    expect(deliveries).toEqual([{ turnId: "turn_1", status: "pending" }]);
  });

  it("throws on a non-2xx delivery claim instead of returning false", async () => {
    const app = new Hono();
    app.post("/v1/deliveries/:turn/claim", () =>
      new Response("service unavailable", { status: 503 }),
    );
    const ingress = createChannelSessionIngress(app, "token");
    await expect(ingress.claimDelivery("turn_1", "owner-1")).rejects.toThrow(
      /claim delivery failed \(503\)/,
    );
  });
});
