import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "@codebridge/work-items";
import { createWorkItemApp } from "./work-item-api.js";

const TOKEN = "work-item-api-token";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeApp() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-api-"));
  const store = new SqliteEventStore(path.join(directory, "events.sqlite"));
  cleanups.push(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { app: createWorkItemApp(store, TOKEN), store };
}

function request(
  url: string,
  init: RequestInit = {},
  token = TOKEN,
): Request {
  return new Request(`http://localhost${url}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

function jsonRequest(
  url: string,
  body: unknown,
  method = "POST",
  token = TOKEN,
) {
  return request(url, {
    method,
    body: JSON.stringify(body),
  }, token);
}

const createBody = {
  conversation_id: "conv_01JAPI",
  title: "排查会员权益未到账",
  agent_id: "pi-investigator",
  mode: "investigation",
  workflow_id: null,
  workspace_scope: ["equity-center"],
  message: "用户 123 的权益为什么没有到账？",
};

describe("createWorkItemApp", () => {
  it("accepts a chat-first WorkItem without user routing metadata", async () => {
    const { app, store } = makeApp();
    const response = await app.request(
      jsonRequest("/v1/work-items", {
        conversation_id: "conv_01JCHATFIRST",
        message: "帮我分析这个目标，并说明下一步怎么做",
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      title: "帮我分析这个目标，并说明下一步怎么做",
      mode: "auto",
      agent_id: null,
      workspace_scope: [],
    });

    const workItem = store.listWorkItems()[0]!;
    const runResponse = await app.request(
      jsonRequest(`/v1/work-items/${workItem.id}/runs`, { mode: "auto" }),
    );
    expect(runResponse.status).toBe(202);
  });

  it("creates a WorkItem and records the initial message", async () => {
    const { app, store } = makeApp();
    const response = await app.request(
      jsonRequest("/v1/work-items", createBody),
    );

    expect(response.status).toBe(201);
    const workItem = (await response.json()) as {
      id: string;
      title: string;
      conversation_id: string;
      agent_id: string;
      status: string;
    };
    expect(workItem).toMatchObject({
      title: createBody.title,
      conversation_id: createBody.conversation_id,
      agent_id: createBody.agent_id,
      status: "created",
    });
    expect(store.listEvents(workItem.id).map((event) => event.type)).toEqual([
      "WORK_ITEM_CREATED",
      "MESSAGE_RECEIVED",
    ]);
  });

  it("returns the WorkItem and resumes events after a sequence", async () => {
    const { app } = makeApp();
    const created = await app.request(jsonRequest("/v1/work-items", createBody));
    const workItem = (await created.json()) as { id: string };

    const message = await app.request(
      jsonRequest(`/v1/work-items/${workItem.id}/messages`, {
        message: "补充订单号 202608070001",
      }),
    );
    expect(message.status).toBe(202);

    const fetched = await app.request(
      request(`/v1/work-items/${workItem.id}`, { method: "GET" }),
    );
    expect(fetched.status).toBe(200);
    expect(((await fetched.json()) as { id: string }).id).toBe(workItem.id);

    const events = await app.request(
      request(`/v1/work-items/${workItem.id}/events?after_sequence=1`, {
        method: "GET",
      }),
    );
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const stream = await events.text();
    expect(stream).toContain('"type":"MESSAGE_RECEIVED"');
    expect(stream).not.toContain('"type":"WORK_ITEM_CREATED"');
    expect(stream.match(/\n\n/g)?.length).toBe(2);
  });

  it("protects the API and rejects unknown WorkItems", async () => {
    const { app } = makeApp();
    const unauthorized = await app.request(
      jsonRequest("/v1/work-items", createBody, "POST", "wrong-token"),
    );
    expect(unauthorized.status).toBe(401);

    const missing = await app.request(
      request("/v1/work-items/wi_missing", { method: "GET" }),
    );
    expect(missing.status).toBe(404);
  });

  it("creates a queued Run for the selected Agent", async () => {
    const { app, store } = makeApp();
    const created = await app.request(jsonRequest("/v1/work-items", createBody));
    const workItem = (await created.json()) as { id: string };

    const response = await app.request(
      jsonRequest(`/v1/work-items/${workItem.id}/runs`, {
        mode: "investigation",
      }),
    );

    expect(response.status).toBe(202);
    const result = (await response.json()) as {
      run_id: string;
      status: string;
    };
    expect(result.status).toBe("queued");
    expect(store.getRun(result.run_id)).toMatchObject({
      workItemId: workItem.id,
      agentId: "pi-investigator",
    });
  });

  it("returns the original result for repeated Idempotency-Key requests", async () => {
    const { app, store } = makeApp();
    const first = await app.request(
      request("/v1/work-items", {
        method: "POST",
        headers: { "Idempotency-Key": "work-create-1" },
        body: JSON.stringify(createBody),
      }),
    );
    const firstBody = (await first.json()) as { id: string };
    const second = await app.request(
      request("/v1/work-items", {
        method: "POST",
        headers: { "Idempotency-Key": "work-create-1" },
        body: JSON.stringify({ ...createBody, title: "different title" }),
      }),
    );
    expect(second.status).toBe(201);
    expect(((await second.json()) as { id: string }).id).toBe(firstBody.id);
    expect(store.listWorkItems()).toHaveLength(1);
  });

  it("accepts Last-Event-ID as an event stream resume cursor", async () => {
    const { app } = makeApp();
    const created = await app.request(jsonRequest("/v1/work-items", createBody));
    const workItem = (await created.json()) as { id: string };
    const all = await app.request(request(`/v1/work-items/${workItem.id}/events`, { method: "GET" }));
    const allText = await all.text();
    const ids = [...allText.matchAll(/^id: (.+)$/gm)].map((match) => match[1]);
    const resumed = await app.request(
      request(`/v1/work-items/${workItem.id}/events`, {
        method: "GET",
        headers: { "Last-Event-ID": ids[0]! },
      }),
    );
    const resumedText = await resumed.text();
    expect(resumedText).toContain('"type":"MESSAGE_RECEIVED"');
    expect(resumedText).not.toContain('"type":"WORK_ITEM_CREATED"');
  });
});
