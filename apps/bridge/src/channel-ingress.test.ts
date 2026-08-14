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
      return c.json({
        session_id: "sess_1",
        turn_id: "turn_1",
        run_id: "run_1",
        event_sequence: 3,
      }, 202);
    });
    app.get("/v1/sessions/:session/events", (c) => {
      expect(c.req.query("after_sequence")).toBe("3");
      return new Response([
      "event: AGENT_EVENT",
      'data: {"type":"AGENT_EVENT","run_id":"run_1","payload":{"event":{"type":"text_delta","text":"ok"}}}',
      "",
      "event: RUN_SUCCEEDED",
      'data: {"type":"RUN_SUCCEEDED","run_id":"run_1","payload":{}}',
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

  it("does not repeat a fatal Agent error as a generic step failure", async () => {
    const app = new Hono();
    app.post("/v1/channels/:channel/conversations/:conversation/messages", (c) =>
      c.json({
        session_id: "sess_1",
        turn_id: "turn_1",
        run_id: "run_1",
        event_sequence: 3,
      }, 202),
    );
    app.get("/v1/sessions/:session/events", () =>
      new Response([
        "event: AGENT_EVENT",
        'data: {"type":"AGENT_EVENT","run_id":"run_1","payload":{"event":{"type":"error","message":"ACP session is occupied","fatal":true}}}',
        "",
        "event: AGENT_EVENT",
        'data: {"type":"AGENT_EVENT","run_id":"run_1","payload":{"event":{"type":"done","exitCode":1}}}',
        "",
        "event: STEP_FAILED",
        'data: {"type":"STEP_FAILED","run_id":"run_1","payload":{"error":"Runner exited with code 1"}}',
        "",
        "event: RUN_FAILED",
        'data: {"type":"RUN_FAILED","run_id":"run_1","payload":{}}',
        "",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } }),
    );
    const ingress = createChannelSessionIngress(app, "token");
    const events = [];

    for await (const event of ingress({
      channel: "feishu",
      conversationId: "chat|topic",
      message: "continue",
    })) events.push(event);

    expect(events).toEqual([
      { type: "error", message: "ACP session is occupied", fatal: true },
      { type: "done", exitCode: 1 },
    ]);
  });

  it("waits for a queued channel Turn and ignores the active Run", async () => {
    const app = new Hono();
    app.post("/v1/channels/:channel/conversations/:conversation/messages", (c) =>
      c.json({
        session_id: "sess_1",
        turn_id: "turn_2",
        run_id: null,
        event_sequence: 3,
      }, 202),
    );
    app.get("/v1/sessions/:session/events", () =>
      new Response([
        "event: AGENT_EVENT",
        'data: {"type":"AGENT_EVENT","run_id":"run_1","payload":{"event":{"type":"text_delta","text":"previous"}}}',
        "",
        "event: RUN_SUCCEEDED",
        'data: {"type":"RUN_SUCCEEDED","run_id":"run_1","payload":{}}',
        "",
        "event: TURN_DISPATCHED",
        'data: {"type":"TURN_DISPATCHED","target":"turn_2","run_id":"run_2","payload":{"turn_id":"turn_2"}}',
        "",
        "event: AGENT_EVENT",
        'data: {"type":"AGENT_EVENT","run_id":"run_2","payload":{"event":{"type":"text_delta","text":"current"}}}',
        "",
        "event: RUN_SUCCEEDED",
        'data: {"type":"RUN_SUCCEEDED","run_id":"run_2","payload":{}}',
        "",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } }),
    );
    const ingress = createChannelSessionIngress(app, "token");
    const events = [];

    for await (const event of ingress({
      channel: "feishu",
      conversationId: "chat|topic",
      message: "queued",
    })) events.push(event);

    expect(events).toEqual([
      { type: "text_delta", text: "current" },
      { type: "done", exitCode: 0 },
    ]);
  });
});
