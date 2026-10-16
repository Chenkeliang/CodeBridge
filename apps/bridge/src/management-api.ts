import { registerTaskManagementRoutes } from "./task-management-api.js";
import type { AgentTaskService } from "./agent-tasks.js";
import type { TaskAttentionService } from "./task-attention.js";
import type { AlertIncidentView } from "@codebridge/core";
import { ChannelConnections, type ManagedChannelId } from "./channel-connections.js";
import { isLocalManagementRequest } from "./local-management.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ConfigSchema, ConfigStore, type ManagedChat, type ManagedAlertSource } from "@codebridge/core";
import { listPublishers, updatePublisher, publishersPath } from "./outbound-publishers.js";
import { fileRevision } from "./management-files.js";
import { ManagedRunbooks } from "./managed-runbooks.js";
import { LocalTaskManager, type CalendarTime } from "./managed-local-tasks.js";

export interface ChannelSettings {
  channel: "feishu" | "telegram"; configured: boolean; connected: boolean | null;
  credentialSource: string; administrators: string[]; allowedUsers: string[]; allowedChats: string[];
  dmMode?: string; dmAllowlist?: string[]; requireMention?: boolean;
  connection?: import("@codebridge/core").ManagedChannelConnection;
  scenarios?: Array<{ name: string; chats: string[]; requireMention?: boolean; enabled?: boolean }>;
}
export interface AlertSettings {
  channel: "feishu";
  chatId: string; senderAppIds: string[]; approverOpenIds: string[]; responsibleOpenIds?: string[]; runbookPath?: string;
  name?: string; enabled: boolean; pollIntervalMs: number;
}
export interface ManagementOptions {
  store: ConfigStore; dataDir: string; token: string; local: LocalTaskManager; runbooks: ManagedRunbooks;
  connections?: ChannelConnections;
  tasks?: AgentTaskService;
  attention?: TaskAttentionService;
  incidents?: (chatId: string) => AlertIncidentView[] | Promise<AlertIncidentView[]>;
  feishuConnected?: () => boolean;
  chats?: () => Promise<ManagedChat[]>;
  sources?: (chatId: string) => Promise<ManagedAlertSource[]>;
  members?: (chatId: string) => Promise<Array<{ id: string; name: string }>>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求内容必须是对象");
  return value as Record<string, unknown>;
}
function strings(value: unknown, pattern?: RegExp): string[] {
  if (!Array.isArray(value) || value.length > 500 || value.some((s) => typeof s !== "string" || !s.trim() || s.length > 200 || pattern && !pattern.test(s))) throw new Error("身份或目标列表无效，请检查当前渠道的 ID");
  return [...new Set(value as string[])];
}
const feishuUser = /^ou_[A-Za-z0-9_]+$/, feishuChat = /^oc_[A-Za-z0-9_]+$/, telegramId = /^-?\d+$/;

/** Local management uses the same canonical config/publisher files as the active channel paths. */
export function createManagementApp(options: ManagementOptions): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (!isLocalManagementRequest(c.req.raw)) return c.json({ error: "local_management_only", message: "管理入口只接受本机同源访问" }, 403);
    await next();
  });
  const connections = options.connections ?? new ChannelConnections({ store: options.store });
  let diskRevision = fileRevision(options.store.path);
  const revision = () => createHash("sha256").update([options.store.path, publishersPath(options.dataDir), path.join(options.dataDir, "managed-local-tasks.json")].map(fileRevision).join(":")).digest("hex");
  const checkRevision = (expected: string | undefined) => {
    if (expected !== revision()) throw new HTTPException(409, { message: "配置已更新，请刷新后再保存；当前草稿不会自动覆盖" });
  };
  function snapshot() {
    const config = options.store.get();
    const channels: ChannelSettings[] = [
      { channel: "feishu", ...connections.metadata("feishu"),
        credentialSource: options.store.secretSources()["feishu.appSecret"] ?? "missing", administrators: config.access?.admins ?? [],
        allowedUsers: config.access?.allowedUsers ?? [], allowedChats: config.access?.allowedChats?.length ? config.feishu.policy?.groupAllowlist?.length ? config.access.allowedChats.filter((id) => config.feishu.policy!.groupAllowlist!.includes(id)) : config.access.allowedChats : config.feishu.policy?.groupAllowlist ?? [],
        dmMode: config.feishu.policy?.dmMode ?? "open", dmAllowlist: config.feishu.policy?.dmAllowlist ?? [], requireMention: config.feishu.policy?.requireMention ?? true, scenarios: config.feishu.policy?.scenarios ?? [] },
      { channel: "telegram", ...connections.metadata("telegram"),
        credentialSource: options.store.secretSources()["telegram.botToken"] ?? "missing", administrators: config.telegram?.admins ?? [],
        allowedUsers: config.telegram?.allowedUsers ?? [], allowedChats: config.telegram?.allowedChats ?? [] },
    ];
    const monitor = config.feishu.alertMonitor;
    const alerts: AlertSettings[] = (monitor?.groups ?? []).map((group) => ({
      channel: "feishu", chatId: group.chatId, name: group.name, senderAppIds: group.senderAppIds,
      approverOpenIds: group.approverOpenIds?.length ? group.approverOpenIds : (group.ownerOpenId ? [group.ownerOpenId] : []),
      responsibleOpenIds: group.responsibleOpenIds ?? (group.approverOpenIds?.length ? group.approverOpenIds : group.ownerOpenId ? [group.ownerOpenId] : []), runbookPath: group.runbookPath,
      enabled: monitor?.enabled !== false && group.enabled !== false, pollIntervalMs: monitor?.pollIntervalMs ?? 30_000,
    }));
    return { revision: revision(), channels, alerts, publishers: listPublishers(options.dataDir, config.runner.token), local: options.local.list() };
  }
  app.use("*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${options.token}`) return c.json({ error: "unauthorized" }, 401);
    const currentDisk = fileRevision(options.store.path);
    if (currentDisk !== diskRevision) { options.store.reload(); diskRevision = currentDisk; }
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "management_origin_forbidden" }, 403);
    if (!["GET", "HEAD"].includes(c.req.method) && c.req.header("if-match") !== revision()) {
      return c.json({ error: "management_revision_conflict", message: "配置已更新，请刷新后再保存；当前草稿不会自动覆盖" }, 409);
    }
    await next();
  });
  app.onError((error, c) => c.json({ error: "management_action_failed", message: error.message }, error instanceof HTTPException ? error.status : "status" in error && error.status === 409 ? 409 : 400));
  app.get("/v1/management", (c) => c.json(snapshot()));
  const managedChannel = (value: string): ManagedChannelId => {
    if (value !== "feishu" && value !== "telegram") throw new HTTPException(404, { message: "未知渠道" });
    return value;
  };
  app.get("/v1/management/connections", (c) => c.json({ channels: (["feishu", "telegram"] as const).map((channel) => ({ channel, ...connections.metadata(channel) })) }));
  app.post("/v1/management/connections/:channel/test", async (c) => c.json(await connections.test(managedChannel(c.req.param("channel")), record(await c.req.json()))));
  app.put("/v1/management/connections/:channel", async (c) => {
    const channel = managedChannel(c.req.param("channel")), body = record(await c.req.json());
    await connections.save(channel, body, () => checkRevision(c.req.header("if-match")));
    return c.json(snapshot());
  });
  app.post("/v1/management/connections/:channel/apply", async (c) => {
    const channel = managedChannel(c.req.param("channel"));
    checkRevision(c.req.header("if-match"));
    await connections.apply(channel);
    return c.json(snapshot());
  });
  app.patch("/v1/management/channels/:channel", async (c) => {
    const channel = c.req.param("channel"), body = record(await c.req.json());
    checkRevision(c.req.header("if-match"));
    const config = options.store.get();
    if (channel === "feishu") {
      const admins = strings(body.administrators, feishuUser), users = strings(body.allowedUsers, feishuUser), chats = strings(body.allowedChats, feishuChat);
      const dmAllowlist = strings(body.dmAllowlist, feishuUser);
      if (!["open", "disabled", "allowlist", "pair"].includes(String(body.dmMode)) || typeof body.requireMention !== "boolean") throw new Error("飞书私聊或群聊策略无效");
      const scenarios = body.scenarios === undefined ? config.feishu.policy?.scenarios : (() => {
        if (!Array.isArray(body.scenarios) || body.scenarios.length > 100) throw new Error("群聊例外配置无效");
        return body.scenarios.map((value) => {
          const scenario = record(value), chats = strings(scenario.chats, feishuChat);
          if (!chats.length || typeof scenario.name !== "string" || scenario.name.length > 100
            || scenario.requireMention !== undefined && typeof scenario.requireMention !== "boolean"
            || scenario.enabled !== undefined && typeof scenario.enabled !== "boolean") throw new Error("群聊例外配置无效");
          return { name: scenario.name, chats, requireMention: scenario.requireMention as boolean | undefined, enabled: scenario.enabled as boolean | undefined };
        });
      })();
      options.store.update((current) => ({ ...current, access: { ...current.access, admins, allowedUsers: users, allowedChats: chats },
        feishu: { ...current.feishu, policy: { ...current.feishu.policy, dmMode: body.dmMode as "open", dmAllowlist, requireMention: body.requireMention as boolean, scenarios,
          groupAllowlist: chats, respondToMentionAll: current.feishu.policy?.respondToMentionAll ?? false } } }));
    } else if (channel === "telegram") {
      if (!config.telegram) throw new Error("请先通过 codebridge init 配置 Telegram 凭据");
      const admins = strings(body.administrators, telegramId), users = strings(body.allowedUsers, telegramId), chats = strings(body.allowedChats, telegramId);
      if (!users.length && !chats.length) throw new Error("Telegram 必须至少保留一个允许的用户或聊天");
      options.store.update((current) => ({ ...current, telegram: { ...current.telegram!, admins, allowedUsers: users, allowedChats: chats } }));
    } else return c.json({ error: "unknown_channel" }, 404);
    return c.json(snapshot());
  });
  async function availableChats(): Promise<ManagedChat[]> {
    if (!options.chats) throw new HTTPException(503, { message: "飞书尚未连接，无法读取群列表" });
    const config = options.store.get(), chats = await options.chats();
    return chats.filter((chat) => (!config.access?.allowedChats?.length || config.access.allowedChats.includes(chat.id))
      && (!config.feishu.policy?.groupAllowlist?.length || config.feishu.policy.groupAllowlist.includes(chat.id)));
  }
  async function canReadChat(chat: string): Promise<boolean> {
    if (!feishuChat.test(chat)) return false;
    const config = options.store.get();
    if (config.access?.allowedChats?.length && !config.access.allowedChats.includes(chat)
      || config.feishu.policy?.groupAllowlist?.length && !config.feishu.policy.groupAllowlist.includes(chat)) return false;
    const known = new Set([...(config.access?.allowedChats ?? []), ...(config.feishu.policy?.groupAllowlist ?? []), ...(config.feishu.alertMonitor?.groups.map((g) => g.chatId) ?? [])]);
    if (known.has(chat)) return true;
    return options.chats ? (await availableChats()).some((group) => group.id === chat) : false;
  }
  registerTaskManagementRoutes(app, { tasks: options.tasks, attention: options.attention, incidents: options.incidents,
    canReadChat: async (chatId) => Boolean(options.store.get().feishu.alertMonitor?.groups.some((group) => group.chatId === chatId)) && await canReadChat(chatId),
    revision, checkRevision });
  app.get("/v1/management/feishu/chats", async (c) => c.json({ chats: await availableChats() }));
  app.get("/v1/management/feishu/members/:chat", async (c) => {
    const chat = c.req.param("chat");
    if (!await canReadChat(chat)) return c.json({ error: "chat_not_configured", message: "请选择机器人已加入且允许访问的群" }, 403);
    if (!options.members) return c.json({ error: "feishu_not_connected", message: "飞书尚未连接" }, 503);
    return c.json({ members: await options.members(chat) });
  });
  app.get("/v1/management/feishu/sources/:chat", async (c) => {
    const chat = c.req.param("chat");
    if (!await canReadChat(chat)) return c.json({ error: "chat_not_configured", message: "请选择机器人已加入且允许访问的群" }, 403);
    if (!options.sources) return c.json({ error: "feishu_not_connected", message: "飞书尚未连接" }, 503);
    return c.json({ sources: await options.sources(chat) });
  });
  app.put("/v1/management/alerts/:chat", async (c) => {
    const chat = c.req.param("chat"), body = record(await c.req.json());
    checkRevision(c.req.header("if-match"));
    if (body.channel !== undefined && body.channel !== "feishu") throw new Error("当前告警采集仅支持飞书");
    if (!feishuChat.test(chat) || typeof body.enabled !== "boolean") throw new Error("告警群或启停状态无效");
    const approvers = strings(body.approverOpenIds, feishuUser), senders = strings(body.senderAppIds, /^cli_[A-Za-z0-9_]+$/);
    if (!approvers.length || !senders.length) throw new Error("请至少选择一位审批人和一个告警来源");
    const runbookPath = typeof body.runbookPath === "string" && body.runbookPath.trim() ? body.runbookPath.trim() : undefined;
    if (runbookPath) options.runbooks.inspect(runbookPath);
    const config = options.store.get(), previous = config.feishu.alertMonitor;
    const existing = previous?.groups.find((g) => g.chatId === chat);
    const responsible = body.responsibleOpenIds === undefined ? existing?.responsibleOpenIds : strings(body.responsibleOpenIds, feishuUser);
    if (responsible && !responsible.length) throw new Error("请至少选择一位告警负责人；负责人不会自动获得审批权限");
    const group = { ...existing, chatId: chat, senderAppIds: senders, approverOpenIds: approvers, responsibleOpenIds: responsible, runbookPath,
      enabled: body.enabled, name: typeof body.name === "string" ? body.name.trim().slice(0, 100) : existing?.name };
    // Normalize through the existing schema; retain polling/dedup/retention and every unrelated group.
    const monitor = ConfigSchema.parse({ ...config, feishu: { ...config.feishu, alertMonitor: {
      ...previous, enabled: true, groups: [...(previous?.groups ?? []).filter((g) => g.chatId !== chat)
        .map((g) => previous?.enabled === false ? { ...g, enabled: false } : g), group],
    } } }).feishu.alertMonitor;
    options.store.update((current) => ({ ...current, feishu: { ...current.feishu, alertMonitor: monitor } }));
    return c.json(snapshot());
  });
  app.get("/v1/management/alerts/:chat/rules", (c) => {
    const group = options.store.get().feishu.alertMonitor?.groups.find((g) => g.chatId === c.req.param("chat"));
    if (!group?.runbookPath) return c.json({ error: "runbook_not_configured", message: "请先配置标准 Skill 入口" }, 404);
    const info = options.runbooks.inspect(group.runbookPath, false);
    return c.json(options.runbooks.read(group.runbookPath, c.req.query("file") ?? info.entry));
  });
  app.put("/v1/management/alerts/:chat/rules", async (c) => {
    const group = options.store.get().feishu.alertMonitor?.groups.find((g) => g.chatId === c.req.param("chat"));
    if (!group?.runbookPath) return c.json({ error: "runbook_not_configured" }, 404);
    const body = record(await c.req.json());
    checkRevision(c.req.header("if-match"));
    if (typeof body.file !== "string" || typeof body.content !== "string" || typeof body.revision !== "string") throw new Error("规则保存参数无效");
    return c.json(options.runbooks.save(group.runbookPath, body.file, body.content, body.revision));
  });
  app.patch("/v1/management/publishers/:label", async (c) => {
    const body = record(await c.req.json());
    checkRevision(c.req.header("if-match"));
    if (typeof body.chatId !== "string" || !Array.isArray(body.routes)) throw new Error("推送目标或发送能力无效");
    updatePublisher(options.dataDir, options.store.get().runner.token, c.req.param("label"), { chatId: body.chatId, topicId: typeof body.topicId === "string" ? body.topicId : undefined, routes: body.routes as string[] });
    return c.json(snapshot());
  });
  app.get("/v1/management/local/available", (c) => c.json({ tasks: options.local.available() }));
  app.post("/v1/management/local", async (c) => {
    const body = record(await c.req.json());
    checkRevision(c.req.header("if-match"));
    if (typeof body.source !== "string" || typeof body.name !== "string") throw new Error("请选择已有本地计划并填写名称");
    options.local.register(body.source, body.name);
    return c.json(snapshot());
  });
  app.post("/v1/management/local/:id/:action", async (c) => {
    const action = c.req.param("action"), body = record(await c.req.json());
    checkRevision(c.req.header("if-match"));
    if (!["run", "enable", "disable"].includes(action) || typeof body.revision !== "string") throw new Error("本地任务操作无效");
    options.local.act(c.req.param("id"), action as "run", body.revision);
    return c.json(snapshot());
  });
  app.put("/v1/management/local/:id/schedule", async (c) => {
    const body = record(await c.req.json());
    checkRevision(c.req.header("if-match"));
    if (typeof body.revision !== "string" || !Array.isArray(body.calendar) || body.interval !== null && typeof body.interval !== "number") throw new Error("计划参数无效");
    const result = options.local.schedule(c.req.param("id"), body.calendar as CalendarTime[], body.interval as number | null, body.revision);
    return c.json({ ...snapshot(), backup: result.backup });
  });
  return app;
}
