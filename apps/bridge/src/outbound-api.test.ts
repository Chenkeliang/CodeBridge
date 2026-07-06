import { describe, expect, it } from "vitest";
import { createOutboundApp, type OutboundBridge } from "./outbound-api.js";

const TOKEN = "test-token-12345";

function makeApp(overrides: Partial<OutboundBridge> = {}) {
  const calls: { file: unknown[]; markdown: unknown[] } = {
    file: [],
    markdown: [],
  };
  const bridge: OutboundBridge = {
    sendOutboundFile: async (chatId, rawPath, topicId) => {
      calls.file.push([chatId, rawPath, topicId]);
      return "report.csv";
    },
    sendOutboundMarkdown: async (chatId, markdown, topicId) => {
      calls.markdown.push([chatId, markdown, topicId]);
    },
    ...overrides,
  };
  return { app: createOutboundApp(bridge, TOKEN), calls };
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
});
