import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "@codebridge/work-items";
import {
  createBridgeApp,
  createOutboundApp,
  type OutboundBridge,
} from "./outbound-api.js";
import { createWebWorkbenchApp } from "./web-workbench.js";

const TOKEN = "test-token-12345";

function makeApp(overrides: Partial<OutboundBridge> = {}) {
  const calls: { file: unknown[]; markdown: unknown[]; mention: unknown[] } = {
    file: [],
    markdown: [],
    mention: [],
  };
  const bridge: OutboundBridge = {
    sendOutboundFile: async (chatId, rawPath, topicId) => {
      calls.file.push([chatId, rawPath, topicId]);
      return "report.csv";
    },
    sendOutboundMarkdown: async (chatId, markdown, topicId) => {
      calls.markdown.push([chatId, markdown, topicId]);
    },
    sendOutboundMention: async (chatId, ref, text, topicId) => {
      calls.mention.push([chatId, ref, text, topicId]);
    },
    ...overrides,
  };
  return { app: createOutboundApp(bridge, TOKEN), bridge, calls };
}

function post(path: string, body: unknown, token = TOKEN) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe("createOutboundApp", () => {
  it("rejects missing/wrong token", async () => {
    const { app } = makeApp();
    const res = await app.request(
      post("/outbound/file", { chatId: "oc_1", path: "/tmp/x" }, "wrong"),
    );
    expect(res.status).toBe(401);
  });

  it("sends file and returns fileName", async () => {
    const { app, calls } = makeApp();
    const res = await app.request(
      post("/outbound/file", { chatId: "oc_1", path: "/home/u/a.csv" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, fileName: "report.csv" });
    expect(calls.file).toEqual([["oc_1", "/home/u/a.csv", undefined]]);
  });

  it("passes topicId through for topic-group replies", async () => {
    const { app, calls } = makeApp();
    const res = await app.request(
      post("/outbound/file", {
        chatId: "oc_1",
        path: "/home/u/a.csv",
        topicId: "omt_1",
      }),
    );
    expect(res.status).toBe(200);
    expect(calls.file).toEqual([["oc_1", "/home/u/a.csv", "omt_1"]]);
  });

  it("400 on missing fields", async () => {
    const { app } = makeApp();
    const res = await app.request(post("/outbound/file", { chatId: "oc_1" }));
    expect(res.status).toBe(400);
  });

  it("maps bridge errors to 400 with message", async () => {
    const { app } = makeApp({
      sendOutboundFile: async () => {
        throw new Error("仅允许发送主目录内的文件");
      },
    });
    const res = await app.request(
      post("/outbound/file", { chatId: "oc_1", path: "/etc/hosts" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "仅允许发送主目录内的文件" });
  });

  it("sends markdown", async () => {
    const { app, calls } = makeApp();
    const res = await app.request(
      post("/outbound/markdown", { chatId: "oc_1", markdown: "进度 50%" }),
    );
    expect(res.status).toBe(200);
    expect(calls.markdown).toEqual([["oc_1", "进度 50%", undefined]]);
  });

  it("sends a scoped mention request", async () => {
    const { app, calls } = makeApp();
    const res = await app.request(
      post("/outbound/mention", {
        chatId: "oc_1",
        ref: "u1",
        text: "发布已经完成",
        topicId: "omt_1",
      }),
    );

    expect(res.status).toBe(200);
    expect(calls.mention).toEqual([
      ["oc_1", "u1", "发布已经完成", "omt_1"],
    ]);
  });

  it("mounts WorkItem routes on the Bridge app", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-mount-"));
    const store = new SqliteEventStore(path.join(directory, "events.sqlite"));
    const { bridge } = makeApp();
    const app = createBridgeApp(bridge, TOKEN, store);

    const response = await app.request(
      post("/v1/work-items", {
        conversation_id: "conv_01JMOUNT",
        title: "验证路由装配",
        agent_id: "pi-investigator",
        mode: "investigation",
        message: "读取项目状态",
      }),
    );

    expect(response.status).toBe(201);
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("serves the Workbench shell without a bearer token", async () => {
    const store = new SqliteEventStore(":memory:");
    const webWorkbenchApp = createWebWorkbenchApp({ store, token: TOKEN });
    const { bridge } = makeApp();
    const app = createBridgeApp(
      bridge,
      TOKEN,
      store,
      undefined,
      undefined,
      undefined,
      webWorkbenchApp,
    );

    const response = await app.request("/workbench/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("CodeBridge Workbench");
    store.close();
  });

  it("keeps API and outbound routes protected when the Workbench is public", async () => {
    const store = new SqliteEventStore(":memory:");
    const webWorkbenchApp = createWebWorkbenchApp({ store, token: TOKEN });
    const { bridge } = makeApp();
    const app = createBridgeApp(
      bridge,
      TOKEN,
      store,
      undefined,
      undefined,
      undefined,
      webWorkbenchApp,
    );

    const workItemsResponse = await app.request("/v1/work-items");
    expect(workItemsResponse.status).toBe(401);

    const outboundResponse = await app.request(
      new Request("http://localhost/outbound/file", { method: "POST" }),
    );
    expect(outboundResponse.status).toBe(401);
    store.close();
  });
});
