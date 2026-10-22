import { ConfigStore, type AppConfig, type ChannelSessionIngress, type ManagedChannelConnection } from "@codebridge/core";
import { hasFeishuCredentials, hasTelegramCredentials } from "./channel-config.js";
import { verifyFeishu, telegramCall } from "./channel-credentials.js";

export type ManagedChannelId = "feishu" | "telegram";
export interface ManagedChannelAdapter {
  readonly isConnected: boolean;
  readonly displayName?: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  updateConfig(config: AppConfig): void;
  setSessionIngress(ingress: ChannelSessionIngress): void;
}
export interface ChannelVerification { valid: true; identity: string; message: string }

/** One local credential/connection lifecycle shared by both supported channels. */
export class ChannelConnections {
  private readonly adapters = new Map<ManagedChannelId, ManagedChannelAdapter>();
  private readonly applied = new Map<ManagedChannelId, AppConfig>();
  private readonly identities = new Map<ManagedChannelId, string>();
  private readonly failures = new Map<ManagedChannelId, string>();
  private readonly applying = new Set<ManagedChannelId>();
  private submitting = 0;
  private ingress?: ChannelSessionIngress;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: {
    store: ConfigStore;
    fetch?: typeof fetch;
    initial?: Partial<Record<ManagedChannelId, ManagedChannelAdapter>>;
    create?: (channel: ManagedChannelId, config: AppConfig) => ManagedChannelAdapter;
    hasActiveRuns?: () => boolean;
    beforeChange?: (channel: ManagedChannelId) => Promise<void>;
    changed?: (channel: ManagedChannelId, adapter: ManagedChannelAdapter | undefined) => void | Promise<void>;
  }) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    for (const channel of ["feishu", "telegram"] as const) {
      const adapter = options.initial?.[channel];
      if (adapter) this.adapters.set(channel, adapter);
      if (this.configured(options.store.get(), channel)) this.applied.set(channel, structuredClone(options.store.get()));
    }
  }

  private configured(config: AppConfig, channel: ManagedChannelId): boolean {
    return channel === "feishu"
      ? hasFeishuCredentials(config) && /^cli_[A-Za-z0-9_]+$/.test(config.feishu.appId)
      : hasTelegramCredentials(config) && /^\d+:[A-Za-z0-9_-]+$/.test(config.telegram!.botToken);
  }

  noteStartupFailure(channel: ManagedChannelId): void {
    this.failures.set(channel, "启动连接未建立；可在此更新凭据、检查网络和权限后重试");
  }

  isApplying(channel?: ManagedChannelId): boolean { return channel ? this.applying.has(channel) : this.applying.size > 0; }

  /** Tracks asynchronous submissions as well as accepted Runs, closing the apply/submit race. */
  bindIngress(ingress: ChannelSessionIngress): ChannelSessionIngress {
    this.ingress = { ...ingress, submit: async (message) => {
      if (this.isApplying(message.channel as ManagedChannelId)) throw new Error("渠道连接正在更新，请稍后重新发送；本条消息尚未提交执行");
      this.submitting++;
      try { return await ingress.submit(message); }
      finally { this.submitting--; }
    } };
    for (const adapter of this.adapters.values()) adapter.setSessionIngress(this.ingress);
    return this.ingress;
  }

  /** Policy edits stay live; newly saved credentials do not leak into an old active adapter. */
  activeConfig(channel: ManagedChannelId): AppConfig {
    const current = structuredClone(this.options.store.get()), previous = this.applied.get(channel);
    if (!previous) return current;
    if (channel === "feishu") current.feishu = { ...current.feishu,
      appId: previous.feishu.appId, appSecret: previous.feishu.appSecret, domain: previous.feishu.domain };
    else if (current.telegram && previous.telegram) current.telegram.botToken = previous.telegram.botToken;
    return current;
  }

  syncConfig(): void {
    for (const [channel, adapter] of this.adapters) adapter.updateConfig(this.activeConfig(channel));
  }

  private environmentManaged(channel: ManagedChannelId): boolean {
    return channel === "feishu" ? Boolean(process.env.FEISHU_APP_ID || process.env.FEISHU_APP_SECRET) : Boolean(process.env.TELEGRAM_BOT_TOKEN);
  }

  private credentialsMatch(a: AppConfig | undefined, b: AppConfig, channel: ManagedChannelId): boolean {
    if (!a) return !this.configured(b, channel);
    return channel === "feishu"
      ? a.feishu.appId === b.feishu.appId && a.feishu.appSecret === b.feishu.appSecret && a.feishu.domain === b.feishu.domain
      : a.telegram?.botToken === b.telegram?.botToken;
  }

  metadata(channel: ManagedChannelId): { configured: boolean; connected: boolean | null; connection: ManagedChannelConnection } {
    const config = this.options.store.get(), adapter = this.adapters.get(channel);
    const configured = this.configured(config, channel), connected = adapter?.isConnected ?? (this.options.create ? false : null);
    const pending = !this.credentialsMatch(this.applied.get(channel), config, channel);
    const blocked = this.submitting > 0 || this.options.hasActiveRuns?.();
    if (connected && !pending) this.failures.delete(channel);
    const failure = this.failures.get(channel);
    return { configured, connected, connection: {
      state: this.isApplying(channel) ? "applying" : failure ? "error" : pending ? "pending" : !configured ? "unconfigured" : connected === null ? "unknown" : connected ? "connected" : "disconnected",
      canApply: Boolean(this.options.create), environmentManaged: this.environmentManaged(channel),
      appId: channel === "feishu" && config.feishu.appId !== "cli_placeholder" ? config.feishu.appId : undefined,
      identity: adapter?.displayName ?? this.identities.get(channel),
      message: failure ?? (blocked ? "仍有排队、执行或等待审批的任务，请结束后再应用连接" : pending ? "凭据已保存，当前连接尚未使用新配置" : undefined),
      blockedReason: blocked ? "仍有排队、执行或等待审批的任务" : undefined,
    } };
  }

  private candidate(channel: ManagedChannelId, body: Record<string, unknown>): AppConfig {
    const allowed = channel === "feishu" ? ["appId", "appSecret"] : ["botToken"];
    if (Object.keys(body).some((key) => !allowed.includes(key)) || Object.values(body).some((value) => typeof value !== "string" || value.length > 4096)) throw new Error("连接配置字段无效");
    const config = structuredClone(this.options.store.get());
    if (this.environmentManaged(channel) && Object.values(body).some((value) => String(value).trim())) throw new Error("凭据由启动环境变量管理；请在服务环境中更新，网页仅可验证当前配置");
    const anchor = this.applied.get(channel) ?? config;
    if (channel === "feishu") {
      const appId = String(body.appId ?? "").trim() || config.feishu.appId;
      const appSecret = String(body.appSecret ?? "").trim() || config.feishu.appSecret;
      if (!/^cli_[A-Za-z0-9_]+$/.test(appId) || !appSecret || appSecret === "secret_placeholder" || /^(?:env|keychain):/.test(appSecret)) throw new Error("请填写有效的飞书 App ID 和 App Secret");
      if (this.configured(anchor, channel) && anchor.feishu.appId !== appId) throw new Error("此实例已绑定另一个飞书应用；更换应用涉及成员与审批身份迁移，请使用独立数据目录，原配置未修改");
      config.feishu = { ...config.feishu, appId, appSecret };
    } else {
      const botToken = String(body.botToken ?? "").trim() || config.telegram?.botToken || "";
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error("请填写 BotFather 提供的有效 Bot Token");
      if (this.configured(anchor, channel) && anchor.telegram && anchor.telegram.botToken.split(":")[0] !== botToken.split(":")[0]) throw new Error("此实例已绑定另一个 Telegram 机器人；为保留原消息游标，请使用独立数据目录，原配置未修改");
      config.telegram = { ...config.telegram, botToken, pollingTimeoutSec: config.telegram?.pollingTimeoutSec ?? 25 };
    }
    return config;
  }

  private async verify(channel: ManagedChannelId, config: AppConfig): Promise<ChannelVerification> {
    if (channel === "feishu") {
      const issue = await verifyFeishu(this.fetchImpl, config.feishu.domain, config.feishu.appId, config.feishu.appSecret);
      if (issue) throw new Error(`飞书凭据验证未通过：${issue}`);
      return { valid: true, identity: config.feishu.appId, message: "飞书凭据验证通过；应用连接后确认消息权限" };
    }
    const token = config.telegram!.botToken;
    const result = await telegramCall<{ id?: number; username?: string; first_name?: string }>(this.fetchImpl, token, "getMe");
    if (!result.ok) throw new Error(`Telegram 凭据验证未通过：${result.error}`);
    if (String(result.result.id) !== token.split(":")[0]) throw new Error("Telegram 返回的机器人身份与 Token 不一致，配置未修改");
    const identity = result.result.username ? `@${result.result.username}` : result.result.first_name || `Bot ${result.result.id}`;
    return { valid: true, identity: identity.replaceAll(token, "[已隐藏]"), message: "Telegram 机器人身份验证通过" };
  }

  async test(channel: ManagedChannelId, body: Record<string, unknown>): Promise<ChannelVerification> {
    return this.verify(channel, this.candidate(channel, body));
  }

  async save(channel: ManagedChannelId, body: Record<string, unknown>, checkRevision: () => void): Promise<void> {
    if (this.isApplying()) throw new Error("连接正在更新，请完成后再保存凭据");
    if (this.environmentManaged(channel)) throw new Error("凭据由启动环境变量管理；请在服务环境中更新，网页不会写入无效覆盖");
    const candidate = this.candidate(channel, body), verified = await this.verify(channel, candidate);
    checkRevision();
    if (this.isApplying()) throw new Error("连接正在更新，请完成后再保存凭据");
    try { this.options.store.update((current) => channel === "feishu"
      ? { ...current, feishu: { ...current.feishu, appId: candidate.feishu.appId, appSecret: candidate.feishu.appSecret } }
      : { ...current, telegram: { ...current.telegram, ...candidate.telegram! } }); }
    catch { throw new Error("凭据未保存：请检查系统钥匙串和配置目录权限；原配置保持不变"); }
    this.identities.set(channel, verified.identity);
    this.failures.delete(channel);
  }

  async apply(channel: ManagedChannelId): Promise<void> {
    if (!this.options.create || !this.ingress) throw new Error("当前实例未提供连接应用入口，请更新运行版本");
    if (this.isApplying()) throw new Error("另一个连接正在更新，请稍后重试");
    const config = structuredClone(this.options.store.get());
    if (!this.configured(config, channel)) throw new Error("请先验证并保存凭据");
    if (channel === "telegram" && !config.telegram?.allowedUsers?.length && !config.telegram?.allowedChats?.length) throw new Error("请先设置至少一位允许的成员或一个允许的聊天，再应用 Telegram 连接");
    // Validate the account identity again even after an external file edit.
    this.candidate(channel, {});
    this.applying.add(channel);
    let previous: ManagedChannelAdapter | undefined, candidate: ManagedChannelAdapter | undefined;
    try {
      if (this.submitting > 0 || this.options.hasActiveRuns?.()) throw new Error("仍有排队、执行或等待审批的任务，请结束后重试；当前连接未中断");
      previous = this.adapters.get(channel);
      const previousConfig = this.activeConfig(channel), previousApplied = this.applied.get(channel);
      let stopped = false;
      try {
        await this.options.beforeChange?.(channel);
        await previous?.disconnect();
        stopped = true;
        candidate = this.options.create(channel, config);
        candidate.setSessionIngress(this.ingress);
        await candidate.connect();
        this.adapters.set(channel, candidate);
        this.applied.set(channel, config);
        this.syncConfig();
        await this.options.changed?.(channel, candidate);
        this.failures.delete(channel);
      } catch {
        if (previousApplied) this.applied.set(channel, previousApplied); else this.applied.delete(channel);
        if (!stopped) {
          await Promise.resolve(this.options.changed?.(channel, previous)).catch(() => {});
          const message = "旧连接停止未确认，尚未创建新连接；请检查后重试";
          this.failures.set(channel, message);
          throw new Error(message);
        }
        try { await candidate?.disconnect(); }
        catch {
          if (candidate) { this.adapters.set(channel, candidate); this.applied.set(channel, config); }
          await Promise.resolve(this.options.changed?.(channel, candidate)).catch(() => {});
          const message = "旧连接已停止，候选连接清理未确认；下次应用会先关闭该连接，再重试";
          this.failures.set(channel, message);
          throw new Error(message);
        }
        let restored = false;
        if (previous) {
          try {
            await previous.disconnect();
            previous.updateConfig(previousConfig);
            await previous.connect();
            this.adapters.set(channel, previous);
            await this.options.changed?.(channel, previous);
            restored = true;
          } catch { this.adapters.delete(channel); await this.options.changed?.(channel, undefined); }
        } else { this.adapters.delete(channel); await this.options.changed?.(channel, undefined); }
        const message = restored ? "新连接未建立，已恢复旧连接；新配置尚未生效，可重试" : "连接未建立，请检查网络和渠道权限后重试；未启动业务任务";
        this.failures.set(channel, message);
        throw new Error(message);
      }
    } finally { this.applying.delete(channel); }
  }
}
