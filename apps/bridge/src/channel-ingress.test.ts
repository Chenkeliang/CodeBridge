import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createChannelSessionIngress } from "./channel-ingress.js";

describe("channel session ingress", () => {
  it("submits a channel message and yields Agent events until the Run completes", async () => {
    const app = new Hono();
    app.post("/v1/channels/:channel/conversations/:conversation/messages", async (c) => {
      expect(c.req.param("channel")).toBe("feishu");
      expect(await c.req.json()).toMatchObject({
        message: "hello",
        agent_id: "pi",
        attachments: [{ name: "context.txt", mime_type: "text/plain", data_base64: "aGVsbG8=" }],
      });
      return c.json({ session_id: "sess_1", run_id: "run_1", event_sequence: 3 }, 202);
    });
    app.get("/v1/sessions/:session/events", (c) => {
      expect(c.req.query("after_sequence")).toBe("3");
      return new Response([
      "event: AGENT_EVENT",
      'data: {"type":"AGENT_EVENT","payload":{"event":{"type":"text_delta","text":"ok"}}}',
      "",
      "event: RUN_SUCCEEDED",
      'data: {"type":"RUN_SUCCEEDED","payload":{}}',
      "",
      "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const ingress = createChannelSessionIngress(app, "token");
    const events = [];
    for await (const event of ingress({
      channel: "feishu",
      conversationId: "chat|topic",
      message: "hello",
      agentId: "pi",
      attachments: [{ name: "context.txt", mimeType: "text/plain", dataBase64: "aGVsbG8=" }],
    })) events.push(event);
    expect(events).toEqual([
      { type: "text_delta", text: "ok" },
      { type: "done", exitCode: 0 },
    ]);
  });
});
