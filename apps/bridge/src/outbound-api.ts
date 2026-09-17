import { Hono } from "hono";
import { createWorkItemApp } from "./work-item-api.js";
import { type SqliteEventStore } from "@codebridge/work-items";
import type { OutboundPublisher } from "./outbound-publishers.js";
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

interface OutboundAppOptions {
  publicPathPrefixes?: string[];
  workItemStore?: SqliteEventStore;
  publishers?: OutboundPublisher[];
}

/** 装配出站能力、兼容 TaskRecord API 和 Session-first API，共享同一个本地 Bearer Token。 */
export function createBridgeApp(
  bridge: OutboundBridge,
  token: string,
  workItemStore: SqliteEventStore,
  approvalService?: ApprovalService,
  executor?: RunExecutor,
  projectCatalogApp?: Hono,
  webWorkbenchApp?: Hono,
  sessionCatalogApp?: Hono,
  flowCatalogApp?: Hono,
  flowBatchApp?: Hono,
  mcpApp?: Hono,
  skillApp?: Hono,
  publishers?: OutboundPublisher[],
) {
  const app = createOutboundApp(bridge, token, {
    workItemStore,
    publishers,
    publicPathPrefixes: webWorkbenchApp ? ["/workbench"] : [],
  });
  app.route("/", createWorkItemApp(workItemStore, token, approvalService, executor));
  if (sessionCatalogApp) app.route("/", sessionCatalogApp);
  if (flowCatalogApp) app.route("/", flowCatalogApp);
  if (flowBatchApp) app.route("/", flowBatchApp);
  if (mcpApp) app.route("/", mcpApp);
  if (skillApp) app.route("/", skillApp);
  if (projectCatalogApp) app.route("/", projectCatalogApp);
  if (webWorkbenchApp) {
    app.route("/workbench", webWorkbenchApp);
    app.route("/workbench/", webWorkbenchApp);
  }
  return app;
}

function isOutboundPath(requestPath: string): boolean {
  return requestPath === "/outbound" || requestPath.startsWith("/outbound/");
}

/** Resolve only the current Run's persisted delivery; never infer a recipient from an ID prefix. */
export function resolveOutboundTarget(store: SqliteEventStore, runId: string) {
  const run = store.getRun(runId);
  if (!run || run.status !== "running" || !run.turnId) {
    throw new Error("outbound_active_run_required：请在当前 CodeBridge 任务内发送文件");
  }
  const deliveries = ["feishu", "telegram"].flatMap((channel) =>
    store.listDeliveries(channel).filter((row) => row.runId === run.id && row.turnId === run.turnId)
      .map((row) => ({ channel, conversationId: row.conversationId })),
  );
  const targets = [...new Map(deliveries.map((row) => [`${row.channel}:${row.conversationId}`, row])).values()];
  if (targets.length !== 1) {
    throw new Error("outbound_source_required：当前任务没有唯一的聊天来源，请从目标聊天窗口重新发起任务");
  }
  const target = targets[0]!;
  const [chatId, topicId, extra] = target.conversationId.split("|");
  if (extra !== undefined || !chatId || !(target.channel === "feishu"
    ? /^oc_[A-Za-z0-9]+$/.test(chatId)
    : /^telegram:-?\d+$/.test(chatId))) {
    throw new Error("outbound_invalid_destination：任务来源不是有效的通道聊天 ID");
  }
  return { chatId, topicId: topicId || undefined };
}

/**
 * Bridge 本地出站 API：Agent 子进程内的 fcb 命令通过它把文件/消息发回飞书。
 * 仅监听 127.0.0.1，Bearer 复用 runner token。
 */
export function createOutboundApp(
  bridge: OutboundBridge,
  token: string,
  options: OutboundAppOptions = {},
) {
  const app = new Hono();
  const resolvedTargets = new WeakMap<Request, { chatId: string; topicId?: string }>();
  const publicPathPrefixes = options.publicPathPrefixes ?? [];
  const publishers = options.publishers ?? [];

  app.use("*", async (c, next) => {
    const isPublicPath = publicPathPrefixes.some(
      (prefix) => c.req.path === prefix || c.req.path.startsWith(`${prefix}/`),
    );
    if (isPublicPath) {
      await next();
      return;
    }
    const auth = c.req.header("authorization");
    if (auth === `Bearer ${token}`) {
      await next();
      return;
    }
    // 发布者凭据只认 /outbound/*，且收件人只取配置里写死的那一个：
    // 请求体给出的 chatId 依旧会被覆盖，发送方无法自己选收件人。
    const publisher = isOutboundPath(c.req.path)
      ? publishers.find((row) => auth === `Bearer ${row.token}`)
      : undefined;
    if (!publisher) {
      return c.json({ error: "unauthorized" }, 401);
    }
    resolvedTargets.set(c.req.raw, {
      chatId: publisher.chatId,
      topicId: publisher.topicId,
    });
    await next();
  });

  app.use("/outbound/*", async (c, next) => {
    // 发布者的收件人已在鉴权时定死，不需要也不可能有 runId。
    if (!options.workItemStore || resolvedTargets.has(c.req.raw)) {
      await next();
      return;
    }
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.runId !== "string" || !body.runId) {
      return c.json({ error: "outbound_run_required：请使用当前任务的 fcb，发送目标由 Bridge 自动解析" }, 400);
    }
    try {
      const target = resolveOutboundTarget(options.workItemStore, body.runId);
      resolvedTargets.set(c.req.raw, target);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    await next();
  });

  app.post("/outbound/file", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      chatId?: string;
      path?: string;
      topicId?: string;
    } | null;
    const target = resolvedTargets.get(c.req.raw);
    if (body && target) Object.assign(body, target);
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
    const target = resolvedTargets.get(c.req.raw);
    if (body && target) Object.assign(body, target);
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
    const target = resolvedTargets.get(c.req.raw);
    if (body && target) Object.assign(body, target);
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
