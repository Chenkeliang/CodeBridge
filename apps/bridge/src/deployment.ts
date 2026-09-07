import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Hono } from "hono";
import type { FeishuMessage } from "@codebridge/channel-feishu";
import type { SqliteEventStore } from "@codebridge/work-items";

export type DeploymentAction = "prepare" | "publish" | "status" | "cancel" | "rollback";
export interface DeploymentCommand {
  action: DeploymentAction;
  releaseId?: string;
  ref?: string;
  publishAfterPrepare?: boolean;
}
interface DeployerConfig {
  token: string;
  ownerOpenId?: string;
  pairingNonce?: string;
  rootDir?: string;
  sourceRepo?: string;
}
const commands: Record<string, DeploymentCommand> = {
  "准备发布": { action: "prepare" },
  "把刚才改的上线": { action: "publish" },
  "上线": { action: "publish" },
  "发布这次修改": { action: "publish" },
  "上线了吗": { action: "status" },
  "发布状态": { action: "status" },
  "取消这次发布": { action: "cancel" },
  "退回上一个版本": { action: "rollback" },
  "回滚到上一版": { action: "rollback" },
  "测好后上线": { action: "prepare", publishAfterPrepare: true },
};
export function parseDeploymentCommand(text: string): DeploymentCommand | undefined {
  const normalized = text.trim().replace(/[。！!？?]+$/, "").trim()
    .replace(/^(?:请|帮我)/, "").replace(/吧$/, "").trim();
  const value = Object.hasOwn(commands, normalized) ? commands[normalized] : undefined;
  return value ? { ...value } : undefined;
}

export function hasPublishIntent(text: string): boolean {
  if (/[“”"「」『』`]|不要|不用|别|不必|不发布|不上线|先不|暂不/.test(text)) return false;
  return /(?:测好后上线|测试通过后上线|测好后发布|改好后上线|并上线|然后上线|完成后上线)[。！!\s]*$/.test(text.trim());
}

export class DeploymentService {
  private readonly nativeMessages = new Map<string, FeishuMessage>();
  constructor(private readonly options: {
    configPath?: string;
    fetch?: typeof fetch;
    feishuConnected?: () => boolean;
    activeRuns?: () => number;
  } = {}) {}

  private get configPath(): string {
    return this.options.configPath ?? path.join(os.homedir(), ".codebridge", "deployer", "config.json");
  }
  private readConfig(): DeployerConfig | undefined {
    try { return JSON.parse(fs.readFileSync(this.configPath, "utf8")) as DeployerConfig; }
    catch { return undefined; }
  }
  isOwner(actorId: string): boolean {
    return Boolean(actorId && this.readConfig()?.ownerOpenId === actorId);
  }
  isMaintenance(): boolean {
    const config = this.readConfig();
    return Boolean(config && fs.existsSync(path.join(config.rootDir ?? path.dirname(this.configPath), "maintenance.json")));
  }
  readiness() {
    return {
      ok: true,
      releaseId: process.env.CODEBRIDGE_RELEASE_ID ?? "bootstrap",
      commit: process.env.CODEBRIDGE_RELEASE_COMMIT ?? "bootstrap",
      feishuConnected: this.options.feishuConnected?.() ?? false,
      activeRuns: this.options.activeRuns?.() ?? 0,
      maintenance: this.isMaintenance(),
    };
  }
  async command(command: DeploymentCommand, context: { actorId: string; chatId: string; messageId: string }): Promise<string> {
    const config = this.readConfig();
    if (!config?.token) return "安全发布还没有配置，请先在主机完成安装。普通对话可以继续。";
    if (!config.ownerOpenId || config.ownerOpenId !== context.actorId) return "只有已绑定的发布负责人可以操作安全发布。";
    try {
      const response = await (this.options.fetch ?? fetch)("http://127.0.0.1:19791/command", {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...command, ...context }),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json() as { message?: string };
      return typeof result.message === "string" ? result.message : "发布控制器返回异常，请稍后查询发布状态。";
    } catch {
      return "暂时联系不上本机发布控制器，请稍后再试。普通对话可以继续。";
    }
  }
  nativeContext(messageId: string): FeishuMessage | undefined {
    return this.nativeMessages.get(messageId);
  }
  guidance(actorId: string, text: string): string {
    if (!this.isOwner(actorId)) return "";
    const sourceRepo = this.readConfig()?.sourceRepo;
    return (sourceRepo ? `CodeBridge 修改目录：${sourceRepo}。必须在此目录修改并提交候选。` : "") + (hasPublishIntent(text) ? "本轮已明确授权测试通过后上线。" : "本轮未授权自动上线，只可准备候选。") + "【CodeBridge 自身修改】仅在本任务修改 CodeBridge 时，验证并提交后优先用 MCP 工具 codebridge_deploy（action=prepare）准备候选；沙箱内不要通过 shell/fcb 访问网络；禁止直接重启或覆盖运行目录。只有用户本轮明确要求测试通过后上线，才可用 codebridge_deploy（action=prepare,publishAfterPrepare=true）；否则只准备并报告结果。MCP 不可用时才考虑 fcb，禁止为发布关闭沙箱或放宽网络权限。";
  }
  guidanceForRun(runId: string, store: SqliteEventStore): string {
    const run = store.getRun(runId);
    const turn = run?.turnId ? store.getTurn(run.turnId) : undefined;
    const actor = turn?.message.actorRef;
    if (actor?.channel !== "feishu") return "";
    const delivery = store.listDeliveries("feishu").find((item) => item.turnId === turn?.turnId && item.runId === runId);
    const native = delivery ? this.nativeContext(delivery.replyToMessageId) : undefined;
    if (!native || native.senderId !== actor.id || native.chatId !== delivery?.conversationId.split("|")[0]) return "";
    return this.guidance(actor.id, native.content);
  }
  async handleFeishuMessage(message: FeishuMessage): Promise<string | undefined> {
    if (this.isOwner(message.senderId)) {
      this.nativeMessages.set(message.messageId, { ...message });
      if (this.nativeMessages.size > 1000) this.nativeMessages.delete(this.nativeMessages.keys().next().value!);
    }
    const command = parseDeploymentCommand(message.content);
    const pairing = /^开启安全发布 ([A-Za-z0-9_-]+)$/.exec(message.content.trim());
    if (!command && !pairing) return undefined;
    if (pairing) {
      // All operations stay synchronous, so competing inbound events cannot bind twice.
      const config = this.readConfig();
      if (!config || config.ownerOpenId || !config.pairingNonce || pairing[1] !== config.pairingNonce || !message.senderId.startsWith("ou_")) {
        return "绑定未通过，请使用主机安装时给出的有效绑定口令。";
      }
      const next = { ...config, ownerOpenId: message.senderId };
      delete next.pairingNonce;
      const temporary = `${this.configPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.configPath);
      return "已绑定安全发布负责人。可以发送“准备发布”或“发布状态”。";
    }
    return this.command(command!, { actorId: message.senderId, chatId: message.chatId, messageId: message.messageId });
  }
}

/** Mount on the existing authenticated Bridge app; no new listening socket. */
export function mountDeploymentRoutes(app: Hono, service: DeploymentService, store: SqliteEventStore): void {
  app.get("/deploy/readiness", (c) => c.json(service.readiness()));
  app.post("/deploy/command", async (c) => {
    const body = await c.req.json().catch(() => null) as (DeploymentCommand & { runId?: string }) | null;
    if (!body?.runId || !["prepare", "publish", "status", "cancel", "rollback"].includes(body.action)) {
      return c.json({ error: "invalid_deployment_command" }, 400);
    }
    const run = store.getRun(body.runId);
    const turn = run?.turnId ? store.getTurn(run.turnId) : undefined;
    const delivery = turn ? store.listDeliveries("feishu").find((item) => item.turnId === turn.turnId && item.runId === run?.id) : undefined;
    const actor = turn?.message.actorRef;
    if (!run || run.status !== "running" || !delivery || actor?.channel !== "feishu" || !service.isOwner(actor.id)) {
      return c.json({ error: "owner_feishu_run_required" }, 403);
    }
    const native = service.nativeContext(delivery.replyToMessageId);
    if (!native || native.senderId !== actor.id || native.chatId !== delivery.conversationId.split("|")[0]) {
      return c.json({ error: "native_feishu_context_required" }, 403);
    }
    if ((body.action === "publish" || body.publishAfterPrepare === true) && !hasPublishIntent(native.content)) {
      return c.json({ error: "explicit_publish_intent_required" }, 403);
    }
    if (body.action === "rollback" && parseDeploymentCommand(native.content)?.action !== "rollback") {
      return c.json({ error: "explicit_rollback_intent_required" }, 403);
    }
    const command: DeploymentCommand = { action: body.action };
    if (typeof body.ref === "string") command.ref = body.ref;
    if (typeof body.releaseId === "string") command.releaseId = body.releaseId;
    if (typeof body.publishAfterPrepare === "boolean") command.publishAfterPrepare = body.publishAfterPrepare;
    const message = await service.command(command, {
      actorId: actor.id,
      chatId: native.chatId,
      messageId: delivery.replyToMessageId,
    });
    return c.json({ message });
  });
}
