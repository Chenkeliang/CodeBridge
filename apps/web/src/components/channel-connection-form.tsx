import { useState } from "react";
import { Check, Plug, RefreshCw, Save, X } from "lucide-react";
import type { ManagedChannel, ChannelVerification } from "@codebridge/core";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { channelConnectionLabel } from "@/components/workbench-shared";

const inputClass = "w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-muted disabled:opacity-50";
export function ChannelConnectionForm({ value, revision, change, busy, accessDirty, onDirty }: {
  value: ManagedChannel; revision: string; busy: boolean; accessDirty: boolean; onDirty: (dirty: boolean) => void;
  change: (url: string, method: "POST" | "PATCH" | "PUT", body: unknown) => Promise<void>;
}) {
  const [appId, setAppId] = useState(value.connection?.appId ?? "");
  const [secret, setSecret] = useState("");
  const [testing, setTesting] = useState(false), [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<ChannelVerification | null>(null);
  const connection = value.connection;
  const dirty = Boolean(secret || appId !== (connection?.appId ?? ""));
  const applying = connection?.state === "applying";
  const fieldsDisabled = busy || testing || applying || connection?.environmentManaged;
  const incomplete = !value.configured && (!secret || value.channel === "feishu" && !appId);
  const body = connection?.environmentManaged ? {} : value.channel === "feishu" ? { appId, appSecret: secret } : { botToken: secret };
  function update(nextId: string, nextSecret: string) {
    setAppId(nextId); setSecret(nextSecret); setVerified(null); setError(null);
    onDirty(Boolean(nextSecret || nextId !== (connection?.appId ?? "")));
  }
  async function test() {
    setTesting(true); setError(null); setVerified(null);
    try { setVerified(await api.testChannelConnection(value.channel, revision, body)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "凭据验证未完成，请重试"); }
    finally { setTesting(false); }
  }
  async function save() {
    setError(null); setVerified(null);
    try { await change(`/connections/${value.channel}`, "PUT", body); setSecret(""); onDirty(false); }
    catch { /* The page retains the fields and displays the action error. */ }
  }
  return <section aria-label="渠道连接设置" className="grid max-w-3xl gap-5 border-b border-line pb-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-medium text-ink">连接设置</h2><p className="mt-1 text-sm text-muted">{value.channel === "feishu" ? "使用飞书应用的 App ID 和 App Secret。" : "使用 BotFather 提供的 Bot Token。"}</p></div><span className="flex min-h-9 items-center gap-2 text-sm text-ink"><Plug className="size-4 text-muted" />{channelConnectionLabel(value)}</span></div>
    {connection?.identity && <p className="break-words text-sm text-ink">当前机器人：{connection.identity}</p>}
    {connection?.message && <p className="text-sm leading-6 text-muted" role="status">{connection.message}</p>}
    {connection?.environmentManaged && <p className="text-sm leading-6 text-muted">凭据由启动环境变量管理。请在服务环境中更新并重启；这里可以验证当前配置。</p>}
    <form aria-label="渠道凭据" className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {value.channel === "feishu" && <label className="grid gap-1.5 text-sm font-medium text-ink">App ID<input aria-label="飞书 App ID" autoComplete="off" className={inputClass} disabled={fieldsDisabled} onChange={(event) => update(event.target.value, secret)} placeholder="cli_…" readOnly={value.configured} value={appId} />{value.configured && <span className="text-xs font-normal leading-5 text-muted">当前实例的应用身份保持不变，可轮换此应用的 Secret。</span>}</label>}
      <label className="grid gap-1.5 text-sm font-medium text-ink">{value.channel === "feishu" ? "App Secret" : "Bot Token"}<input aria-label={value.channel === "feishu" ? "飞书 App Secret" : "Telegram Bot Token"} autoComplete="off" className={inputClass} disabled={fieldsDisabled} onChange={(event) => update(appId, event.target.value)} placeholder={value.configured ? "已保存；留空保留当前凭据" : "粘贴凭据，输入不会显示"} spellCheck={false} type="password" value={secret} /></label>
      <p className="text-xs leading-5 text-muted">保存前会验证凭据，新输入的密钥使用系统钥匙串保存。留空保留既有来源，保存与生效状态分别显示。</p>
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      {verified && <p className="flex items-start gap-2 text-sm text-success" role="status"><Check className="mt-0.5 size-4 shrink-0" /><span>{verified.message}：{verified.identity}。本次验证没有保存配置或发送消息。</span></p>}
      <div className="flex flex-wrap gap-2"><Button disabled={Boolean(fieldsDisabled || accessDirty || incomplete)} type="submit" variant="secondary"><Save className="mr-1.5 size-4" />{busy ? "处理中…" : "验证并保存凭据"}</Button><Button disabled={Boolean(busy || testing || applying || incomplete)} onClick={() => void test()} type="button" variant="outline"><Check className="mr-1.5 size-4" />{testing ? "验证中…" : "仅验证凭据"}</Button>{dirty && <Button disabled={busy || testing || applying} onClick={() => update(connection?.appId ?? "", "")} type="button" variant="ghost"><X className="mr-1 size-4" />取消输入</Button>}</div>
    </form>
    {accessDirty && <p className="text-xs leading-5 text-muted">访问设置有未保存的修改，请先保存访问设置，再更改或应用凭据。</p>}
    {value.configured && connection?.canApply && <div className="flex flex-wrap items-center gap-3"><Button disabled={Boolean(busy || testing || applying || accessDirty || dirty || connection.blockedReason)} onClick={() => void change(`/connections/${value.channel}/apply`, "POST", {}).catch(() => {})} type="button" variant="outline"><RefreshCw className="mr-1.5 size-4" />{applying ? "正在应用连接…" : connection.state === "connected" ? "重新连接" : "应用连接"}</Button><p className="max-w-prose text-xs leading-5 text-muted">{connection.blockedReason ?? (dirty ? "请先保存或取消凭据输入。" : "应用连接只更新当前渠道；有执行或等待审批的任务时不会切换。")}</p></div>}
    <p className="text-xs leading-5 text-muted">凭据来源：{{ keychain: "系统钥匙串", env: "环境变量", plaintext: "本地配置（建议重新安全保存）", missing: "尚未配置", placeholder: "尚未配置" }[value.credentialSource] ?? "未检测"}。<a className="underline underline-offset-4" href={value.channel === "feishu" ? "https://open.feishu.cn/app" : "https://core.telegram.org/bots/tutorial#obtain-your-bot-token"} rel="noreferrer" target="_blank">获取凭据与配置说明</a></p>
  </section>;
}
