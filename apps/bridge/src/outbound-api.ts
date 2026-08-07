import { Hono } from "hono";
import { createWorkItemApp } from "./work-item-api.js";
import { type SqliteEventStore } from "@codebridge/work-items";
import type { ApprovalService } from "@codebridge/policy";
import type { RunExecutor } from "@codebridge/run-executor";

/** 出站 API 依赖的最小 Bridge 能力面 */
export interface OutboundBridge {
  sendOutboundFile(
    chatId: string,
    rawPath: string,
    topicId?: string,
  ): Promise<string>;
  sendOutboundMarkdown(
    chatId: string,
    markdown: string,
    topicId?: string,
  ): Promise<void>;
  sendOutboundMention(
    chatId: string,
    ref: string,
    text: string,
    topicId?: string,
  ): Promise<void>;
}

/** 装配现有出站能力和 WorkItem API，共享同一个本地 Bearer Token。 */
export function createBridgeApp(
  bridge: OutboundBridge,
  token: string,
  workItemStore: SqliteEventStore,
  approvalService?: ApprovalService,
  executor?: RunExecutor,
  projectCatalogApp?: Hono,
) {
  const app = createOutboundApp(bridge, token);
  app.route("/", createWorkItemApp(workItemStore, token, approvalService, executor));
  if (projectCatalogApp) app.route("/", projectCatalogApp);
  return app;
}

/**
 * Bridge 本地出站 API：Agent 子进程内的 fcb 命令通过它把文件/消息发回飞书。
 * 仅监听 127.0.0.1，Bearer 复用 runner token。
 */
export function createOutboundApp(bridge: OutboundBridge, token: string) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization");
    if (auth !== `Bearer ${token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.post("/outbound/file", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      chatId?: string;
      path?: string;
      topicId?: string;
    } | null;
    if (!body?.chatId || !body?.path) {
      return c.json({ error: "chatId 和 path 必填" }, 400);
    }
    try {
      const fileName = await bridge.sendOutboundFile(
        body.chatId,
        body.path,
        body.topicId,
      );
      return c.json({ ok: true, fileName });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.post("/outbound/markdown", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      chatId?: string;
      markdown?: string;
      topicId?: string;
    } | null;
    if (!body?.chatId || !body?.markdown) {
      return c.json({ error: "chatId 和 markdown 必填" }, 400);
    }
    try {
      await bridge.sendOutboundMarkdown(
        body.chatId,
        body.markdown,
        body.topicId,
      );
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.post("/outbound/mention", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      chatId?: string;
      ref?: string;
      text?: string;
      topicId?: string;
    } | null;
    if (!body?.chatId || !body?.ref || !body?.text) {
      return c.json({ error: "chatId、ref 和 text 必填" }, 400);
    }
    try {
      await bridge.sendOutboundMention(
        body.chatId,
        body.ref,
        body.text,
        body.topicId,
      );
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  return app;
}
