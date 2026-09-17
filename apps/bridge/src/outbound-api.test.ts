import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { SqliteEventStore } from "@codebridge/work-items";
import {
  resolveOutboundTarget,
  createBridgeApp,
  createOutboundApp,
  type OutboundBridge,
} from "./outbound-api.js";
import { createWebFrontendApp } from "./web-frontend.js";

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

  it("mounts the Skill control plane on the Bridge app", async () => {
    const store = new SqliteEventStore(":memory:");
    const { bridge } = makeApp();
    const skillApp = new Hono().get("/v1/skills", (c) => c.json({ skills: [] }));
    const app = createBridgeApp(
      bridge,
      TOKEN,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      skillApp,
    );

    const response = await app.request("/v1/skills", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ skills: [] });
    store.close();
  });

  it("serves the Workbench shell without a bearer token", async () => {
    const store = new SqliteEventStore(":memory:");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-web-mount-"));
    fs.writeFileSync(path.join(directory, "index.html"), "<title>CodeBridge Workbench</title>");
    const webFrontendApp = createWebFrontendApp({ staticDirectory: directory, token: TOKEN });
    const { bridge } = makeApp();
    const app = createBridgeApp(
      bridge,
      TOKEN,
      store,
      undefined,
      undefined,
      undefined,
      webFrontendApp,
    );

    const response = await app.request("/workbench/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("CodeBridge Workbench");
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("keeps API and outbound routes protected when the Workbench is public", async () => {
    const store = new SqliteEventStore(":memory:");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-web-auth-"));
    fs.writeFileSync(path.join(directory, "index.html"), "<title>CodeBridge Workbench</title>");
    const webFrontendApp = createWebFrontendApp({ staticDirectory: directory, token: TOKEN });
    const { bridge } = makeApp();
    const app = createBridgeApp(
      bridge,
      TOKEN,
      store,
      undefined,
      undefined,
      undefined,
      webFrontendApp,
    );

    const workItemsResponse = await app.request("/v1/work-items");
    expect(workItemsResponse.status).toBe(401);

    const outboundResponse = await app.request(
      new Request("http://localhost/outbound/file", { method: "POST" }),
    );
    expect(outboundResponse.status).toBe(401);
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
});


describe("Run-bound outbound routing", () => {
  function storeFor(conversationId = "oc_source|om_topic", channel = "feishu") {
    return {
      getRun: (id: string) => id === "run_current" ? { id, turnId: "turn_current", status: "running" } : undefined,
      listDeliveries: (name: string) => name === channel ? [
        { runId: "run_old", turnId: "turn_old", conversationId: "oc_wrong|" },
        { runId: "run_current", turnId: "turn_current", conversationId },
      ] : [],
    } as unknown as SqliteEventStore;
  }

  it.each(["file", "markdown", "mention"])("routes %s by persisted Run and ignores supplied recipient", async (kind) => {
    const { bridge, calls } = makeApp();
    const app = createBridgeApp(bridge, TOKEN, storeFor());
    const response = await app.request(post(`/outbound/${kind}`, {
      runId: "run_current", chatId: "conv_internal", topicId: "wrong_topic",
      path: "/home/u/report.xlsx", markdown: "hello", ref: "owner", text: "hello",
    }));
    expect(response.status).toBe(200);
    expect(calls[kind as keyof typeof calls][0]).toEqual(kind === "file"
      ? ["oc_source", "/home/u/report.xlsx", "om_topic"]
      : kind === "markdown" ? ["oc_source", "hello", "om_topic"]
      : ["oc_source", "owner", "hello", "om_topic"]);
  });

  it("keeps Telegram delivery on its own channel", () => {
    expect(resolveOutboundTarget(storeFor("telegram:-42|17", "telegram"), "run_current"))
      .toEqual({ chatId: "telegram:-42", topicId: "17" });
  });

  it.each(["conv_internal", "ou_person", "employee123"])("rejects invalid persisted target %s", (id) => {
    expect(() => resolveOutboundTarget(storeFor(id), "run_current")).toThrow("outbound_invalid_destination");
  });

  it("rejects missing, unknown, finished and ambiguous Runs without sending", async () => {
    const { bridge, calls } = makeApp();
    const store = storeFor();
    const app = createBridgeApp(bridge, TOKEN, store);
    for (const runId of [undefined, "unknown"]) {
      expect((await app.request(post("/outbound/file", { runId, chatId: "oc_override", path: "/tmp/a.xlsx" }))).status).toBe(400);
    }
    const finished = { ...store, getRun: () => ({ id: "run_current", status: "completed", turnId: "turn_current" }) } as unknown as SqliteEventStore;
    expect(() => resolveOutboundTarget(finished, "run_current")).toThrow("outbound_active_run_required");
    const ambiguous = { ...store, listDeliveries: () => [{ runId: "run_current", turnId: "turn_current", conversationId: "oc_source|" }] } as unknown as SqliteEventStore;
    expect(() => resolveOutboundTarget(ambiguous, "run_current")).toThrow("outbound_source_required");
    const web = { ...store, listDeliveries: () => [] } as unknown as SqliteEventStore;
    expect(() => resolveOutboundTarget(web, "run_current")).toThrow("outbound_source_required");
    expect(calls.file).toEqual([]);
  });
});


describe("Publisher-token outbound routing", () => {
  const PUBLISHER = {
    label: "stock-daily-trade",
    token: "publisher-token-abcdefghijklmnop",
    chatId: "oc_bound",
    topicId: "om_bound",
  };

  function publisherApp() {
    const { bridge, calls } = makeApp();
    const store = {
      getRun: () => undefined,
      listDeliveries: () => [],
    } as unknown as SqliteEventStore;
    const app = createBridgeApp(
      bridge, TOKEN, store,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      [PUBLISHER],
    );
    return { app, calls };
  }

  it("sends without a runId and ignores the recipient in the body", async () => {
    const { app, calls } = publisherApp();
    const response = await app.request(post("/outbound/markdown", {
      chatId: "oc_elsewhere", topicId: "om_elsewhere", markdown: "收盘复盘",
    }, PUBLISHER.token));
    expect(response.status).toBe(200);
    expect(calls.markdown).toEqual([["oc_bound", "收盘复盘", "om_bound"]]);
  });

  it("still requires a runId from the runner token", async () => {
    const { app, calls } = publisherApp();
    const response = await app.request(post("/outbound/markdown", { chatId: "oc_1", markdown: "hi" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining("outbound_run_required") });
    expect(calls.markdown).toEqual([]);
  });

  it("does not let a publisher token reach non-outbound routes", async () => {
    const { app } = publisherApp();
    const response = await app.request("/v1/work-items", {
      headers: { authorization: `Bearer ${PUBLISHER.token}` },
    });
    expect(response.status).toBe(401);
  });

  it("rejects an unknown token on outbound routes", async () => {
    const { app, calls } = publisherApp();
    const response = await app.request(post("/outbound/markdown", { markdown: "hi" }, "publisher-token-wrong-000000000"));
    expect(response.status).toBe(401);
    expect(calls.markdown).toEqual([]);
  });
});
