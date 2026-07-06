import { Hono } from "hono";

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

  return app;
}
