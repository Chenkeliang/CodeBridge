import fs from "node:fs";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AlertIncidentView, TaskAttentionItem } from "@codebridge/core";
import type { AgentTaskService } from "./agent-tasks.js";
import type { TaskAttentionService } from "./task-attention.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求内容必须是对象");
  return value as Record<string, unknown>;
}
function version(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error("请提供任务当前版本");
  return Number(value);
}
function pageNumber(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) > max) throw new Error("分页参数无效");
  return Number(value);
}
function actionKey(value: string | undefined): string {
  if (!value || value.length > 200 || !/^[A-Za-z0-9:_-]+$/.test(value)) throw new Error("请提供有效的幂等操作标识");
  return value;
}

/** Mounted inside the existing authenticated/local/Origin/revision middleware. */
export function registerTaskManagementRoutes(app: Hono, options: {
  tasks?: AgentTaskService;
  attention?: TaskAttentionService;
  incidents?: (chatId: string) => AlertIncidentView[] | Promise<AlertIncidentView[]>;
  canReadChat: (chatId: string) => Promise<boolean>;
  revision: () => string;
  checkRevision: (value: string | undefined) => void;
}) {
  const tasks = () => { if (!options.tasks) throw new HTTPException(503, { message: "当前实例尚未接入Agent定时任务，请更新运行版本" }); return options.tasks; };
  const task = (id: string) => { const value = tasks().store.get(id); if (!value) throw new HTTPException(404, { message: "定时任务不存在" }); return value; };
  const attempt = (taskId: string, attemptId: string) => {
    task(taskId); const value = tasks().store.getAttempt(attemptId);
    if (!value || value.taskId !== taskId) throw new HTTPException(404, { message: "该任务下不存在这条运行记录" });
    return value;
  };
  app.use("/v1/management/agent-tasks/*", async (c, next) => {
    const sourceRun = c.req.header("x-codebridge-run-id");
    if (!["GET", "HEAD"].includes(c.req.method) && sourceRun && tasks().store.forRun(sourceRun)) {
      throw new HTTPException(403, { message: "定时任务内可读取计划和登记本次结果；创建或修改计划请由用户在工作台操作" });
    }
    await next();
  });
  app.post("/v1/management/agent-task-output", async (c) => {
    const body = object(await c.req.json());
    if (typeof body.runId !== "string" || typeof body.path !== "string" || !body.path || body.path.length > 4096) throw new Error("登记结果需要当前Run与项目内文件的绝对路径");
    const value = tasks().store.forRun(body.runId);
    if (!value) throw new HTTPException(404, { message: "当前Run不是已登记的定时任务" });
    return c.json({ file: tasks().recordFile(value.id, body.path) }, 201);
  });
  app.get("/v1/management/agent-tasks", (c) => c.json({ revision: options.revision(), tasks: tasks().store.list(), scheduler: tasks().schedulerStatus() }));
  app.get("/v1/management/agent-tasks/options", async (c) => c.json(await tasks().choices()));
  app.post("/v1/management/agent-tasks/preflight", async (c) => c.json(await tasks().preflight(await c.req.json(), c.req.query("taskId"))));
  app.post("/v1/management/agent-tasks", async (c) => {
    const saved = await tasks().save(await c.req.json(), () => options.checkRevision(c.req.header("if-match")), undefined, undefined, actionKey(c.req.header("idempotency-key")));
    return c.json({ revision: options.revision(), ...saved }, 201);
  });
  app.get("/v1/management/agent-tasks/:id", (c) => {
    const value = task(c.req.param("id")), offset = pageNumber(c.req.query("offset"), 0, 1_000_000), limit = Math.max(1, pageNumber(c.req.query("limit"), 20, 50));
    const runs = tasks().store.attempts(value.id, offset, limit);
    return c.json({ revision: options.revision(), task: value, runs: runs.items, total: runs.total, nextOffset: offset + runs.items.length < runs.total ? offset + runs.items.length : null });
  });
  app.put("/v1/management/agent-tasks/:id", async (c) => {
    const id = c.req.param("id"), body = object(await c.req.json()); task(id);
    const saved = await tasks().save(body.task, () => options.checkRevision(c.req.header("if-match")), id, version(body.version));
    return c.json({ revision: options.revision(), ...saved });
  });
  for (const action of ["pause", "resume"] as const) app.post(`/v1/management/agent-tasks/:id/${action}`, async (c) => {
    const id = c.req.param("id"), body = object(await c.req.json()); task(id);
    const saved = await tasks().setEnabled(id, version(body.version), action === "resume", () => options.checkRevision(c.req.header("if-match")), body.acknowledgeUnknown === true);
    return c.json({ revision: options.revision(), task: saved });
  });
  app.post("/v1/management/agent-tasks/:id/run", async (c) => {
    const id = c.req.param("id"), body = object(await c.req.json()); task(id);
    const value = await tasks().runNow(id, version(body.version), actionKey(c.req.header("idempotency-key")), body.acknowledgeUnknown === true);
    return c.json({ revision: options.revision(), attempt: value }, 202);
  });
  app.get("/v1/management/agent-tasks/:id/runs/:attempt", (c) => {
    const value = attempt(c.req.param("id"), c.req.param("attempt"));
    return c.json({ revision: options.revision(), ...tasks().detail(value.id) });
  });
  app.post("/v1/management/agent-tasks/:id/runs/:attempt/retry", async (c) => {
    const value = attempt(c.req.param("id"), c.req.param("attempt")), body = object(await c.req.json());
    const retried = await tasks().runNow(value.taskId, version(body.version), actionKey(c.req.header("idempotency-key")), body.acknowledgeUnknown === true, value.id);
    return c.json({ revision: options.revision(), attempt: retried }, 202);
  });
  app.post("/v1/management/agent-tasks/:id/runs/:attempt/resend", async (c) => {
    const value = attempt(c.req.param("id"), c.req.param("attempt"));
    return c.json({ revision: options.revision(), ...await tasks().resend(value.id, actionKey(c.req.header("idempotency-key"))) });
  });
  app.post("/v1/management/agent-tasks/:id/runs/:attempt/acknowledge", (c) => {
    const value = attempt(c.req.param("id"), c.req.param("attempt"));
    return c.json({ revision: options.revision(), ...tasks().acknowledgeDelivery(value.id, actionKey(c.req.header("idempotency-key"))) });
  });
  app.post("/v1/management/agent-tasks/:id/runs/:attempt/outputs", async (c) => {
    const value = attempt(c.req.param("id"), c.req.param("attempt")), body = object(await c.req.json());
    if (typeof body.path !== "string" || !body.path || body.path.length > 4096) throw new Error("请提供项目内结果文件的绝对路径");
    return c.json({ file: tasks().recordFile(value.id, body.path) }, 201);
  });
  app.get("/v1/management/agent-task-files/:id", (c) => {
    const { file, storedPath } = tasks().fileContent(c.req.param("id"));
    return new Response(fs.readFileSync(storedPath), { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  });
  app.get("/v1/management/pending", async (c) => {
    if (!options.attention) throw new HTTPException(503, { message: "当前实例尚未接入待处理总览" });
    const kind = c.req.query("kind"), kinds: TaskAttentionItem["kind"][] = ["runtime_approval", "agent_permission", "paused_queue", "failed_run", "task_delivery"];
    if (kind && !kinds.includes(kind as TaskAttentionItem["kind"])) throw new Error("待处理类型无效");
    return c.json(await options.attention.list({ offset: pageNumber(c.req.query("offset"), 0, 1_000_000), limit: Math.max(1, pageNumber(c.req.query("limit"), 30, 50)), kind: kind as TaskAttentionItem["kind"] | undefined }));
  });
  app.get("/v1/management/alerts/:chat/incidents", async (c) => {
    const chat = c.req.param("chat");
    if (!await options.canReadChat(chat)) throw new HTTPException(403, { message: "此告警群不在当前允许范围" });
    if (!options.incidents) throw new HTTPException(503, { message: "告警案件读取尚未就绪" });
    const status = c.req.query("status"), offset = pageNumber(c.req.query("offset"), 0, 1_000_000), limit = Math.max(1, pageNumber(c.req.query("limit"), 20, 50));
    if (status && !["investigating", "waiting", "resolved", "no_action", "blocked", "dismissed"].includes(status)) throw new Error("案件状态筛选无效");
    const all = (await options.incidents(chat)).filter((item) => !status || item.status === status);
    const items = all.slice(offset, offset + limit);
    return c.json({ items, total: all.length, nextOffset: offset + items.length < all.length ? offset + items.length : null });
  });
}
