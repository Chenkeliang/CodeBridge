import { AlertIncidentsPanel } from "./alert-incidents-panel";
import { ChannelConnectionForm } from "./channel-connection-form";
import { channelConnectionLabel } from "./workbench-shared";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronRight, FileText, Link2, Pause, Play, Plus, RefreshCw, Save, Users, X } from "lucide-react";
import type { ManagedAlert, ManagedCalendar, ManagedChannel, ManagedLocalTask, ManagedPublisher, ManagedRule, ManagedChat, ManagedAlertSource, ManagementSnapshot } from "@codebridge/core";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const inputClass = "w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-muted disabled:opacity-50";
const split = (text: string) => text.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean);
type Change = (url: string, method: "POST" | "PATCH" | "PUT", body: unknown) => Promise<void>;
type Task = { kind: "local"; key: string; name: string; item: ManagedLocalTask } | { kind: "alert"; key: string; name: string; item: ManagedAlert } | { kind: "publisher"; key: string; name: string; item: ManagedPublisher };

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="grid min-w-0 gap-1.5"><div className="text-sm font-medium text-ink">{label}</div>{hint && <p className="max-w-prose text-xs leading-5 text-muted">{hint}</p>}{children}</div>;
}
function TextField({ label, value, onValue, hint }: { label: string; value: string; onValue: (text: string) => void; hint?: string }) {
  return <Field hint={hint} label={label}><input aria-label={label} className={inputClass} onChange={(event) => onValue(event.target.value)} value={value} /></Field>;
}
function IdList({ label, value, onValue, hint }: { label: string; value: string[]; onValue: (ids: string[]) => void; hint?: string }) {
  const ids = value.join("\n");
  const [draft, setDraft] = useState({ ids, text: ids });
  if (draft.ids !== ids) setDraft({ ids, text: ids });
  return <Field hint={hint} label={label}><textarea aria-label={label} className={cn(inputClass, "min-h-20 resize-y font-mono text-xs leading-5")} onChange={(event) => { const text = event.target.value; const next = split(text); setDraft({ ids: next.join("\n"), text }); onValue(next); }} value={draft.text} /></Field>;
}
function Choice({ label, value, onValue, options }: { label: string; value: string; onValue: (v: string) => void; options: Array<[string, string]> }) {
  return <Select onValueChange={onValue} value={value}><SelectTrigger aria-label={label} className={cn(inputClass, "h-10 w-full min-w-0")}><SelectValue /></SelectTrigger><SelectContent className="border-line-strong bg-surface text-ink">{options.map(([id, text]) => <SelectItem key={id} value={id}>{text}</SelectItem>)}</SelectContent></Select>;
}

export function ManagementPage({ area, onNotify, onOpenSession }: { area: "channels" | "tasks"; onNotify: (text: string, kind?: "info" | "error") => void; onOpenSession?: (id: string) => Promise<void> }) {
  const [data, setData] = useState<ManagementSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState("feishu");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [backup, setBackup] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await api.management()); setError(null); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "读取失败，请重试"); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  useEffect(() => {
    if (area !== "channels") return;
    let current = true;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void api.channelConnections().then((result) => {
        if (!current) return;
        // Status-only updates never replace the config revision or an unsaved form draft.
        setData((previous) => previous ? { ...previous, channels: previous.channels.map((item) => {
          const status = result.channels.find((candidate) => candidate.channel === item.channel);
          return status ? { ...item, ...status } : item;
        }) } : previous);
      }).catch(() => {
        if (current) setData((previous) => previous ? { ...previous, channels: previous.channels.map((item) => ({ ...item, connected: null,
          connection: { ...item.connection, state: "unknown", canApply: false, environmentManaged: item.connection?.environmentManaged ?? false, message: "暂时无法读取连接状态，请检查服务后刷新" },
        })) } : previous);
      });
    }, 5_000);
    return () => { current = false; clearInterval(timer); };
  }, [area]);
  const change: Change = async (url, method, body) => {
    if (!data || busy) return;
    setBusy(true); setError(null);
    try {
      const saved = await api.changeManagement(url, method, data.revision, body);
      setData(saved); setBackup(saved.backup ?? null);
      if (selected === "new-alert") {
        const created = saved.alerts.find((alert) => `/alerts/${encodeURIComponent(alert.chatId)}` === url);
        if (created) setSelected(`alert:${created.chatId}`);
      }
      if (url === "/local") setAdding(false);
      onNotify(url.startsWith("/connections/") ? url.endsWith("/apply") ? "连接配置已应用，请确认实际连接状态" : "凭据已验证并安全保存，生效状态见连接设置" : url.endsWith("/run") ? "已提交运行，请刷新查看状态" : url.endsWith("/enable") ? "计划已启用" : url.endsWith("/disable") ? "计划已停用" : "设置已保存");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "保存失败";
      setError(message); throw caught;
    } finally { setBusy(false); }
  };
  const tasks: Task[] = data ? [
    ...data.local.tasks.map((item): Task => ({ kind: "local", key: `local:${item.id}`, name: item.name, item })),
    ...data.alerts.map((item): Task => ({ kind: "alert", key: `alert:${item.chatId}`, name: item.name || "飞书告警", item })),
    ...data.publishers.map((item): Task => ({ kind: "publisher", key: `publisher:${item.label}`, name: item.label, item })),
  ] : [];
  const task = tasks.find((item) => item.key === selected);
  return <section aria-label={area === "channels" ? "渠道管理" : "任务管理"} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line bg-sidebar px-5 py-5 md:px-8">
      <div><h1 className="font-brand text-xl font-normal tracking-tight text-ink">{area === "channels" ? "渠道" : "任务"}</h1><p className="mt-1 max-w-prose text-sm leading-6 text-muted">{area === "channels" ? "连接聊天，管理成员和访问范围。" : "在一个地方管理本地计划、推送与告警。"}</p></div>
      <Button aria-label="刷新管理数据" onClick={() => void load()} size="sm" variant="outline"><RefreshCw className="mr-1.5 size-3.5" />刷新</Button>
    </header>
    <div className="mx-auto grid w-full max-w-5xl gap-6 px-5 py-6 md:px-8">
      {error && <div className="flex items-start gap-2 rounded-md bg-danger-soft px-4 py-3 text-sm text-danger" role="alert"><X className="mt-0.5 size-4 shrink-0" /><span>{error}</span></div>}
      {backup && <p className="break-all text-xs leading-5 text-muted" role="status">修改前的加密备份：{backup}</p>}
      {!data ? <div aria-label="正在读取管理数据" className="grid gap-3">{[1, 2, 3].map((i) => <div className="h-14 animate-pulse rounded-md bg-surface-soft motion-reduce:animate-none" key={i} />)}</div> : area === "channels" ? <>
        <div aria-label="选择渠道" className="flex gap-2">{data.channels.map((item) => <Button aria-pressed={channel === item.channel} key={item.channel} onClick={() => setChannel(item.channel)} variant={channel === item.channel ? "secondary" : "outline"}>{item.channel === "feishu" ? "飞书" : "Telegram"}<span className="ml-2 text-xs opacity-75">{channelConnectionLabel(item)}</span></Button>)}</div>
        {data.channels.filter((item) => item.channel === channel).map((item) => <ChannelForm busy={busy} change={change} key={`${item.channel}:${data.revision}`} revision={data.revision} value={item} />)}
      </> : selected === "new-alert" ? <>
        <Button className="w-fit" onClick={() => setSelected(null)} size="sm" variant="ghost"><ArrowLeft className="mr-1 size-4" />所有任务</Button>
        <div><h2 className="text-lg font-semibold text-ink">新增告警</h2><p className="mt-1 text-sm text-muted">选择群聊和负责人，其他设置按需调整。</p></div>
        <AlertForm busy={busy} channels={data.channels} occupiedChats={data.alerts.map((alert) => alert.chatId)} change={change} onNotify={onNotify} revision={data.revision} value={{ chatId: "", name: "", senderAppIds: [], approverOpenIds: [], responsibleOpenIds: [], enabled: false, pollIntervalMs: 30_000 }} />
      </> : task ? <>
        <Button className="w-fit" onClick={() => setSelected(null)} size="sm" variant="ghost"><ArrowLeft className="mr-1 size-4" />所有任务</Button>
        <div><h2 className="break-words text-lg font-semibold text-ink">{task.name}</h2><p className="mt-1 text-sm text-muted">{task.kind === "local" ? "本地计划 · 沿用现有脚本和系统调度" : task.kind === "alert" ? "告警任务 · 沿用原案件、审批与 Skill 规则" : "推送 · 只调整交付，不重新执行业务"}</p></div>
        {task.kind === "local" ? <LocalTaskForm busy={busy} change={change} key={`${task.key}:${data.revision}`} value={task.item} /> : task.kind === "alert" ? <AlertIncidentsPanel chatId={task.item.chatId} key={task.item.chatId} onOpenSession={onOpenSession}><AlertForm busy={busy} channels={data.channels} occupiedChats={data.alerts.map((alert) => alert.chatId)} change={change} key={`${task.key}:${data.revision}`} onNotify={onNotify} revision={data.revision} value={task.item} /></AlertIncidentsPanel> : <PublisherForm busy={busy} change={change} key={`${task.key}:${data.revision}`} value={task.item} />}
      </> : <>
        <div className="flex flex-wrap items-center justify-between gap-3"><div aria-label="任务类型" className="flex flex-wrap gap-1">{[["all", "全部"], ["local", "本地计划"], ["alert", "告警"], ["publisher", "推送"]].map(([id, label]) => <Button aria-pressed={filter === id} key={id} onClick={() => setFilter(id!)} size="sm" variant={filter === id ? "secondary" : "ghost"}>{label}</Button>)}</div><div className="flex flex-wrap gap-2"><Button onClick={() => { setAdding((v) => !v); }} size="sm" variant="outline"><Plus className="mr-1 size-3.5" />接入本地计划</Button><Button onClick={() => setSelected("new-alert")} size="sm" variant="outline">新增告警</Button></div></div>

        {adding && <ConnectLocalTask busy={busy} change={change} />}
        {data.local.issues.map((issue) => <p className="text-sm text-danger" key={issue.id} role="alert">{issue.name}：{issue.message}</p>)}
        <div className="divide-y divide-line border-y border-line">{tasks.filter((item) => filter === "all" || item.kind === filter).map((item) => <button className="flex w-full items-center gap-3 py-4 text-left transition-colors hover:bg-surface-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-muted" key={item.key} onClick={() => setSelected(item.key)} type="button"><span className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-soft text-muted">{item.kind === "local" ? <Play className="size-4" /> : item.kind === "alert" ? <FileText className="size-4" /> : <Link2 className="size-4" />}</span><span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium text-ink">{item.name}</span><span className="mt-1 block truncate text-xs text-muted">{item.kind === "local" ? item.item.running ? "运行中" : item.item.loaded ? "计划已启用" : "计划已停用" : item.kind === "alert" ? item.item.enabled ? "正在采集" : "采集已停用" : item.item.chatId}</span></span><ChevronRight className="size-4 shrink-0 text-muted" /></button>)}{!tasks.filter((item) => filter === "all" || item.kind === filter).length && <div className="py-12 text-center"><p className="text-sm font-medium text-ink">还没有这类任务</p><p className="mt-2 text-sm text-muted">接入已有本地计划，或添加一个默认停用的告警任务。已有推送凭据会自动出现在这里。</p></div>}</div>
      </>}
    </div>
  </section>;
}

function ReplyMode({ label, value, onValue }: { label: string; value: boolean; onValue: (requireMention: boolean) => void }) {
  return <fieldset className="grid gap-2"><legend className="mb-1.5 text-sm font-medium text-ink">{label}</legend>{[
    { id: "mention", text: "仅 @ 回复", hint: "新消息需要 @ 机器人。直接回复机器人及已有话题仍可续聊；@ 其他人不触发。", requireMention: true },
    { id: "auto", text: "自动回复", hint: "允许的群内，普通消息也会触发机器人。", requireMention: false },
  ].map((option) => <label className={cn("flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5", value === option.requireMention ? "border-line-strong bg-surface-soft" : "border-line")} key={option.id}><input aria-label={option.text} checked={value === option.requireMention} className="mt-1" name="group-reply-mode" onChange={() => onValue(option.requireMention)} type="radio" value={option.id} /><span className="min-w-0"><span className="block text-sm font-medium text-ink">{option.text}</span><span className="mt-1 block text-xs leading-5 text-muted">{option.hint}</span></span></label>)}</fieldset>;
}

function ChannelForm({ value, change, busy, revision }: { value: ManagedChannel; change: Change; busy: boolean; revision: string }) {
  const [draft, setDraft] = useState(value);
  const [credentialsDirty, setCredentialsDirty] = useState(false);
  const policyKeys = ["administrators", "allowedUsers", "allowedChats", "dmMode", "dmAllowlist", "requireMention", "scenarios"] as const;
  const accessDirty = policyKeys.some((key) => JSON.stringify(draft[key]) !== JSON.stringify(value[key]));
  const save = (event: FormEvent) => { event.preventDefault(); void change(`/channels/${value.channel}`, "PATCH", draft).catch(() => {}); };
  return <div className="grid gap-6"><ChannelConnectionForm accessDirty={accessDirty} busy={busy} change={change} onDirty={setCredentialsDirty} revision={revision} value={value} />{value.configured ? <form aria-label="渠道访问设置" className="grid max-w-3xl gap-6" onSubmit={save}>
    <div className="grid gap-5 md:grid-cols-2">
      <IdList hint={value.channel === "feishu" ? "当前应用下的 Open ID；管理员负责群内配置命令。" : "当前机器人的 Telegram 用户 ID。"} label="管理员" onValue={(administrators) => setDraft((s) => ({ ...s, administrators }))} value={draft.administrators} />
      <IdList hint={value.channel === "feishu" ? "保留现有可信用户范围；这些用户也能使用群内管理命令。" : "限制哪些用户可以使用机器人；与聊天范围共同生效。"} label="允许的用户" onValue={(allowedUsers) => setDraft((s) => ({ ...s, allowedUsers }))} value={draft.allowedUsers} />
      <IdList hint="每行一个当前渠道的群或聊天 ID。" label="允许的聊天" onValue={(allowedChats) => setDraft((s) => ({ ...s, allowedChats }))} value={draft.allowedChats} />
      {value.channel === "feishu" && <IdList label="允许私聊的成员" onValue={(dmAllowlist) => setDraft((s) => ({ ...s, dmAllowlist }))} value={draft.dmAllowlist ?? []} />}
    </div>
    {value.channel === "feishu" && <div className="grid gap-5 md:grid-cols-2"><Field label="私聊访问"><Choice label="私聊访问" onValue={(dmMode) => setDraft((s) => ({ ...s, dmMode }))} options={[["open", "允许私聊"], ["allowlist", "仅允许指定成员"], ["disabled", "关闭私聊"], ["pair", "配对成员"]]} value={draft.dmMode ?? "open"} /></Field><ReplyMode label="群聊回复模式" onValue={(requireMention) => setDraft((s) => ({ ...s, requireMention }))} value={draft.requireMention ?? true} /></div>}
    {value.channel === "feishu" && <section aria-label="按群设置回复例外" className="grid gap-4 border-t border-line pt-5"><div><h3 className="text-sm font-medium text-ink">按群设置例外</h3><p className="mt-1 text-xs leading-5 text-muted">没有例外的群使用上方模式。同一群按列表顺序取第一个已启用的有效设置；停用或移除后使用其余设置。</p></div>
      {(draft.scenarios ?? []).map((scenario, index) => <div className="grid gap-3 border-l-2 border-line pl-4" key={index}>
        <TextField label={`例外名称 ${index + 1}`} onValue={(name) => setDraft((s) => ({ ...s, scenarios: s.scenarios!.map((v, i) => i === index ? { ...v, name } : v) }))} value={scenario.name} />
        <IdList label={`例外群 ID ${index + 1}`} onValue={(chats) => setDraft((s) => ({ ...s, scenarios: s.scenarios!.map((v, i) => i === index ? { ...v, chats } : v) }))} value={scenario.chats} />
        <Choice label={`例外回复模式 ${index + 1}`} onValue={(mode) => setDraft((s) => ({ ...s, scenarios: s.scenarios!.map((v, i) => i === index ? { ...v, requireMention: mode === "inherit" ? undefined : mode === "mention" } : v) }))} options={[["inherit", "使用全局模式"], ["mention", "仅 @ 回复"], ["auto", "自动回复"]]} value={scenario.requireMention === undefined ? "inherit" : scenario.requireMention ? "mention" : "auto"} />
        <div className="flex flex-wrap items-center justify-between gap-3"><label className="flex min-h-11 items-center gap-2 text-sm text-ink"><input checked={scenario.enabled !== false} onChange={(event) => setDraft((s) => ({ ...s, scenarios: s.scenarios!.map((v, i) => i === index ? { ...v, enabled: event.target.checked } : v) }))} type="checkbox" />启用此例外</label><Button aria-label={`移除例外 ${index + 1}`} onClick={() => setDraft((s) => ({ ...s, scenarios: s.scenarios!.filter((_, i) => i !== index) }))} type="button" variant="ghost"><X className="mr-1 size-4" />移除</Button></div>
      </div>)}
      <Button className="w-fit" onClick={() => setDraft((s) => ({ ...s, scenarios: [...(s.scenarios ?? []), { name: "新群聊例外", chats: [], requireMention: true }] }))} type="button" variant="outline"><Plus className="mr-1 size-4" />添加群聊例外</Button>
    </section>}

    {value.channel === "feishu" && <MemberPicker chatIds={draft.allowedChats} onChoose={(id) => setDraft((s) => ({ ...s, administrators: [...new Set([...s.administrators, id])] }))} />}
    <div className="border-t border-line pt-4"><Button disabled={busy || credentialsDirty} type="submit" variant="secondary"><Save className="mr-2 size-4" />{busy ? "保存中…" : "保存渠道设置"}</Button>{credentialsDirty && <p className="mt-2 text-xs text-muted">凭据有未保存的输入，请先保存或取消凭据输入，再保存访问设置。</p>}</div>
  </form> : <p className="text-sm leading-6 text-muted">先验证并保存凭据，再设置允许的成员和聊天，最后应用连接。已有会话与配置会保留。</p>}</div>;
}

function MemberPicker({ chatIds, onChoose, role = "管理员" }: { chatIds: string[]; onChoose: (id: string) => void; role?: string }) {
  const [members, setMembers] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [chat, setChat] = useState(chatIds[0] ?? "");
  async function read() {
    setBusy(true); setError(null);
    try { setMembers((await api.managementMembers(chat)).members); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "成员读取失败"); }
    finally { setBusy(false); }
  }
  return <details className="border-t border-line pt-4"><summary className="cursor-pointer text-sm text-ink">从飞书群成员选择{role}</summary><div className="mt-3 grid gap-3"><div className="flex flex-wrap gap-2"><input aria-label="读取成员的群 ID" className={cn(inputClass, "min-w-0 flex-1")} onChange={(event) => setChat(event.target.value)} value={chat} /><Button disabled={!chat || busy} onClick={() => void read()} type="button" variant="outline"><Users className="mr-1 size-4" />{busy ? "读取中…" : "读取成员"}</Button></div><p className="text-xs text-muted">只读取已配置群中的本应用身份，选择后仍需保存设置。</p>{error && <p className="text-sm text-danger" role="alert">{error}</p>}<div className="flex max-h-52 flex-wrap gap-2 overflow-y-auto">{members.map((member) => <Button key={member.id} onClick={() => onChoose(member.id)} size="sm" title={member.id} type="button" variant="outline"><Plus className="mr-1 size-3" />{member.name}</Button>)}</div></div></details>;
}

function MemberChoices({ label, role, members, value, onValue }: { label: string; role: string; members: Array<{ id: string; name: string }>; value: string[]; onValue: (ids: string[]) => void }) {
  const [search, setSearch] = useState("");
  const nameOf = (id: string) => {
    const member = members.find((item) => item.id === id);
    if (!member) return `已保存成员 · …${id.slice(-6)}`;
    return members.some((other) => other.id !== id && other.name === member.name) ? `${member.name}（…${id.slice(-6)}）` : member.name;
  };
  return <fieldset className="grid min-w-0 gap-3"><legend className="mb-2 text-sm font-medium text-ink">{label}</legend>
    {value.length > 0 && <div aria-label={`已选${role}`} className="flex flex-wrap gap-2">{value.map((id) => <button aria-label={`${nameOf(id)}，移除${role}`} className="flex min-h-9 max-w-full items-center gap-2 rounded-md bg-surface-soft px-3 py-1.5 text-sm text-ink" key={id} onClick={() => onValue(value.filter((current) => current !== id))} title={id} type="button"><span className="truncate">{nameOf(id)}</span><X className="size-3.5 shrink-0" /></button>)}</div>}
    <input aria-label={`搜索${role}`} className={inputClass} onChange={(event) => setSearch(event.target.value)} placeholder="按姓名搜索" type="search" value={search} />
    <div className="max-h-48 overflow-y-auto rounded-md border border-line">{members.filter((member) => member.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((member) => <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm text-ink hover:bg-surface-soft" key={member.id} title={member.id}><input aria-label={`${nameOf(member.id)}，设为${role}`} checked={value.includes(member.id)} onChange={(event) => onValue(event.target.checked ? [...new Set([...value, member.id])] : value.filter((id) => id !== member.id))} type="checkbox" /><span className="min-w-0 break-words">{nameOf(member.id)}</span></label>)}{!members.some((member) => member.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && <p className="px-3 py-4 text-sm text-muted">{search ? "没有匹配的成员" : "暂未读取到群成员；已有选择会保留。"}</p>}</div>
  </fieldset>;
}

function AlertForm({ value, channels, occupiedChats, change, busy, revision, onNotify }: { value: ManagedAlert; channels: ManagedChannel[]; occupiedChats: string[]; change: Change; busy: boolean; revision: string; onNotify: (text: string, kind?: "info" | "error") => void }) {
  const [draft, setDraft] = useState({ ...value, responsibleOpenIds: value.responsibleOpenIds ?? value.approverOpenIds });
  const [rules, setRules] = useState(false), [advanced, setAdvanced] = useState(false), [refresh, setRefresh] = useState(0);
  const [directory, setDirectory] = useState<{ chats: ManagedChat[]; loading: boolean; error?: string }>({ chats: [], loading: true });
  const [detail, setDetail] = useState<{ chatId: string; members: Array<{ id: string; name: string }>; sources: ManagedAlertSource[]; loading: boolean; errors: string[] } | null>(null);
  const channel = channels.find((item) => item.channel === "feishu");
  const occupiedKey = occupiedChats.join("|");
  const trustedDefaults = (channel?.administrators ?? []).filter((id) => !channel?.allowedUsers.length || channel.allowedUsers.includes(id)).join("|");
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(async () => {
      if (!current) return;
      setDirectory((previous) => ({ ...previous, loading: true, error: undefined }));
      try {
        const result = await api.managementChats();
        if (!current) return;
        setDirectory({ chats: result.chats, loading: false });
        const available = result.chats.filter((chat) => !occupiedKey.split("|").includes(chat.id));
        if (!value.chatId && available.length === 1) setDraft((previous) => previous.chatId ? previous : { ...previous, chatId: available[0]!.id });
      } catch (error) { if (current) setDirectory((previous) => ({ ...previous, loading: false, error: error instanceof Error ? error.message : "读取群列表失败" })); }
    });
    return () => { current = false; };
  }, [occupiedKey, refresh, value.chatId]);
  useEffect(() => {
    const chatId = draft.chatId;
    if (!chatId) return;
    let current = true;
    void Promise.resolve().then(async () => {
      if (!current) return;
      setDetail({ chatId, members: [], sources: [], loading: true, errors: [] });
      const [people, bots] = await Promise.allSettled([api.managementMembers(chatId), api.managementAlertSources(chatId)]);
      if (!current) return;
      const members = people.status === "fulfilled" ? people.value.members : [];
      const sources = bots.status === "fulfilled" ? bots.value.sources : [];
      const errors = [people.status === "rejected" ? `群成员：${people.reason instanceof Error ? people.reason.message : "读取失败"}` : "", bots.status === "rejected" ? `告警来源：${bots.reason instanceof Error ? bots.reason.message : "读取失败"}` : ""].filter(Boolean);
      setDetail({ chatId, members, sources, loading: false, errors });
      if (!value.chatId) setDraft((previous) => ({ ...previous,
        senderAppIds: previous.senderAppIds.length || sources.length !== 1 ? previous.senderAppIds : [sources[0]!.id],
        approverOpenIds: previous.approverOpenIds.length ? previous.approverOpenIds : trustedDefaults.split("|").filter((id) => members.some((member) => member.id === id)),
      }));
    });
    return () => { current = false; };
  }, [draft.chatId, refresh, trustedDefaults, value.chatId]);
  const context = detail?.chatId === draft.chatId ? detail : null;
  const members = context?.members ?? [];
  const selectedChat = directory.chats.find((chat) => chat.id === draft.chatId);
  const sources = context?.sources ?? [];
  const missingSources = draft.senderAppIds.filter((id) => !sources.some((source) => source.id === id));
  const name = draft.name?.trim() || (selectedChat ? `${selectedChat.name}告警` : "飞书告警");
  const missing = !draft.chatId ? "请选择告警群" : !draft.responsibleOpenIds.length ? "请选择告警负责人" : !draft.senderAppIds.length ? "请选择告警来源；尚无消息时可在高级设置中指定" : !draft.approverOpenIds.length ? "请在高级设置中选择审批人" : null;
  const pending = Boolean(draft.chatId && (!context || context.loading));
  return <form aria-label="告警配置" className="grid max-w-3xl gap-6" onSubmit={(event) => { event.preventDefault(); if (missing) return; void change(`/alerts/${encodeURIComponent(draft.chatId)}`, "PUT", { ...draft, name, channel: "feishu" }).catch(() => {}); }}>
    <div className="grid gap-4 md:grid-cols-2"><Field label="告警渠道"><select aria-label="告警渠道" className={inputClass} defaultValue="feishu"><option value="feishu">飞书{channel?.connected ? " · 已连接" : channel?.configured ? " · 已配置" : " · 尚未配置"}</option><option disabled value="telegram">Telegram · 暂不支持告警采集</option></select></Field>
      <Field label="告警群"><select aria-label="告警群" className={inputClass} disabled={Boolean(value.chatId) || directory.loading || !channel?.configured} onChange={(event) => { setDraft((previous) => ({ ...previous, chatId: event.target.value, senderAppIds: [], responsibleOpenIds: [], approverOpenIds: [], runbookPath: undefined })); }} value={draft.chatId}><option value="">{directory.loading ? "正在读取群列表…" : "选择群聊"}</option>{draft.chatId && !selectedChat && <option value={draft.chatId}>原告警群（名称暂不可用）</option>}{directory.chats.map((chat) => <option disabled={!value.chatId && occupiedChats.includes(chat.id)} key={chat.id} value={chat.id}>{chat.name}{!value.chatId && occupiedChats.includes(chat.id) ? " · 已有告警任务" : ""}</option>)}</select></Field></div>
    <p className="-mt-3 text-xs leading-5 text-muted">{value.chatId ? "已有案件保留在此群；更换群请新增告警任务。" : "只显示机器人已加入且允许访问的群。"}</p>
    {directory.error && <p className="text-sm text-danger" role="alert">{directory.error}。请确认机器人已入群并具备群信息读取权限，然后刷新。</p>}
    {!directory.loading && !directory.error && !directory.chats.length && <p className="text-sm text-muted">没有可选群。请将机器人加入目标群，并在渠道中允许访问该群。</p>}
    {pending && <p className="text-sm text-muted" role="status">正在读取群成员和近期告警来源…</p>}
    {context?.errors.map((error) => <p className="text-sm text-danger" key={error} role="alert">{error}。请检查群成员或群消息读取权限后重试；已保存设置保留。</p>)}
    {draft.chatId && <><MemberChoices label="告警负责人" members={members} onValue={(responsibleOpenIds) => setDraft((previous) => ({ ...previous, responsibleOpenIds }))} role="负责人" value={draft.responsibleOpenIds} /><p className="-mt-3 text-xs leading-5 text-muted">排查失败、中断或受阻时 @ 所选成员。负责人不会自动获得审批权限。</p>
      <fieldset className="grid min-w-0 gap-2"><legend className="mb-2 text-sm font-medium text-ink">告警来源</legend><p className="text-xs leading-5 text-muted">从最近50条群消息识别机器人。按最近消息辨认来源，所选机器人此后的新消息会进入排查。</p>{sources.map((source) => <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-sm text-ink" key={source.id} title={source.id}><input aria-label={`采集来源：${source.preview}`} checked={draft.senderAppIds.includes(source.id)} className="mt-1" onChange={(event) => setDraft((previous) => ({ ...previous, senderAppIds: event.target.checked ? [...new Set([...previous.senderAppIds, source.id])] : previous.senderAppIds.filter((id) => id !== source.id) }))} type="checkbox" /><span className="min-w-0 break-words">{source.preview}</span></label>)}{missingSources.map((id) => <p className="break-words text-xs text-muted" key={id} title={id}>已保存来源 · …{id.slice(-6)}（近期没有可读消息，设置保留）</p>)}{!pending && !sources.length && !missingSources.length && <p className="text-sm text-muted">尚未发现机器人消息。收到新告警后刷新，或在高级设置中指定来源。</p>}</fieldset>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4"><p className="text-xs leading-5 text-muted">操作审批：{draft.approverOpenIds.length ? draft.approverOpenIds.map((id) => members.find((member) => member.id === id)?.name ?? "已保存审批人").join("、") : "尚未设置"}。需要操作批准时 @ 这些人。</p><Button onClick={() => setAdvanced(true)} size="sm" type="button" variant="ghost">调整审批人</Button></div></>}
    <details className="border-t border-line pt-4" onToggle={(event) => setAdvanced(event.currentTarget.open)} open={advanced}><summary className="cursor-pointer text-sm text-ink">高级设置</summary><div className="mt-5 grid gap-5">
      <TextField hint={`留空自动使用“${selectedChat?.name ?? "群名"}告警”。`} label="任务名称（可选）" onValue={(taskName) => setDraft((previous) => ({ ...previous, name: taskName }))} value={draft.name ?? ""} />
      <MemberChoices label="操作审批人" members={members} onValue={(approverOpenIds) => setDraft((previous) => ({ ...previous, approverOpenIds }))} role="审批人" value={draft.approverOpenIds} />
      <TextField hint="留空使用通用告警排查；填写后沿用该 Skill 的处理规则。" label="Skill 规则入口（可选）" onValue={(runbookPath) => setDraft((previous) => ({ ...previous, runbookPath }))} value={draft.runbookPath ?? ""} />
      <details><summary className="cursor-pointer text-xs text-muted">查看或手动填写 ID</summary><div className="mt-3 grid gap-4"><p className="break-all text-xs text-muted">当前群：{draft.chatId || "尚未选择"}</p><IdList label="告警来源应用 ID" onValue={(senderAppIds) => setDraft((previous) => ({ ...previous, senderAppIds }))} value={draft.senderAppIds} /><IdList label="负责人 ID" onValue={(responsibleOpenIds) => setDraft((previous) => ({ ...previous, responsibleOpenIds }))} value={draft.responsibleOpenIds} /><IdList label="审批人 ID" onValue={(approverOpenIds) => setDraft((previous) => ({ ...previous, approverOpenIds }))} value={draft.approverOpenIds} /></div></details>
      {value.runbookPath && <Button className="w-fit" onClick={() => setRules((previous) => !previous)} type="button" variant="outline"><FileText className="mr-2 size-4" />维护规则</Button>}{rules && <RuleEditor chatId={value.chatId} onNotify={onNotify} revision={revision} />}
    </div></details>
    <label className="flex min-h-11 items-center gap-2 text-sm text-ink"><input checked={draft.enabled} onChange={(event) => setDraft((previous) => ({ ...previous, enabled: event.target.checked }))} type="checkbox" />启用告警采集</label>
    <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4"><Button disabled={busy || Boolean(missing) || !channel?.configured || !value.chatId && pending} type="submit" variant="secondary"><Save className="mr-2 size-4" />{busy ? "保存中…" : "保存告警设置"}</Button><Button disabled={directory.loading || pending} onClick={() => setRefresh((previous) => previous + 1)} type="button" variant="ghost"><RefreshCw className="mr-1 size-4" />刷新群信息</Button>{missing && <p className="text-xs text-muted">{missing}</p>}</div>
  </form>;
}

function RuleEditor({ chatId, revision, onNotify }: { chatId: string; revision: string; onNotify: (text: string, kind?: "info" | "error") => void }) {
  const [rule, setRule] = useState<ManagedRule | null>(null), [content, setContent] = useState("");
  const [backup, setBackup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const read = useCallback(async (file?: string) => {
    try { const data = await api.managedRule(chatId, file); setRule(data); setContent(data.content); setError(null); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "读取规则失败"); }
  }, [chatId]);
  useEffect(() => { void Promise.resolve().then(() => read()); }, [read]);
  async function save() {
    if (!rule) return; setBusy(true);
    try { const result = await api.saveManagedRule(chatId, revision, { file: rule.relative, revision: rule.revision, content }); setRule({ ...rule, revision: result.revision, content }); setBackup(result.backup); setError(null); onNotify("规则已保存；原文件已加密备份，下次排查读取新内容"); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "规则未保存"); }
    finally { setBusy(false); }
  }
  return <section aria-label="告警规则维护" className="grid gap-3 border-t border-line pt-5"><h3 className="text-base font-medium text-ink">规则维护</h3><p className="text-xs leading-5 text-muted">沿用 SKILL.md 与包内相对引用。保存有版本校验和加密备份；规则修改不自动执行任何业务动作。</p>{error && <p className="text-sm text-danger" role="alert">{error}</p>}{backup && <p className="break-all text-xs leading-5 text-muted" role="status">修改前的加密备份：{backup}</p>}{rule?.issues?.length ? <p className="text-sm text-danger" role="alert">规则需要修正：{rule.issues.join("；")}</p> : null}{rule && <><Choice label="规则文件" onValue={(file) => void read(file)} options={rule.files.map((file) => [file, file])} value={rule.relative} /><textarea aria-label="规则内容" className={cn(inputClass, "min-h-80 resize-y font-mono text-xs leading-6")} disabled={busy} onChange={(event) => setContent(event.target.value)} value={content} /><Button className="w-fit" disabled={busy || content === rule.content} onClick={() => void save()} type="button" variant="outline"><Check className="mr-1 size-4" />{busy ? "保存中…" : "保存规则"}</Button></>}</section>;
}

function PublisherForm({ value, change, busy }: { value: ManagedPublisher; change: Change; busy: boolean }) {
  const [draft, setDraft] = useState(value);
  return <form className="grid max-w-3xl gap-5" onSubmit={(event) => { event.preventDefault(); void change(`/publishers/${encodeURIComponent(value.label)}`, "PATCH", draft).catch(() => {}); }}><TextField hint="飞书群 ID 或 telegram: 加聊天 ID。" label="推送目标" onValue={(chatId) => setDraft((s) => ({ ...s, chatId }))} value={draft.chatId} /><TextField label="话题（可选）" onValue={(topicId) => setDraft((s) => ({ ...s, topicId }))} value={draft.topicId ?? ""} /><fieldset className="grid gap-3"><legend className="mb-2 text-sm font-medium text-ink">允许发送</legend>{[["markdown", "文字与报告"], ["mention", "原生 @ 提醒"], ["file", "文件附件"]].map(([id, name]) => <label className="flex items-center gap-2 text-sm text-ink" key={id}><input checked={draft.routes.includes(id!)} onChange={(event) => setDraft((s) => ({ ...s, routes: event.target.checked ? [...s.routes, id!] : s.routes.filter((v) => v !== id) }))} type="checkbox" />{name}</label>)}</fieldset><p className="text-sm leading-6 text-muted">保存保留原凭据，不需要修改现有推送脚本。发送方不能自行改变收件目标。</p><Button className="w-fit" disabled={busy || !draft.routes.length} type="submit" variant="secondary"><Save className="mr-2 size-4" />{busy ? "保存中…" : "保存推送设置"}</Button></form>;
}

function ConnectLocalTask({ change, busy }: { change: Change; busy: boolean }) {
  const [available, setAvailable] = useState<Array<{ source: string; label: string }>>([]), [source, setSource] = useState(""), [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api.availableLocalTasks().then((data) => setAvailable(data.tasks)).catch((caught: Error) => setError(caught.message)); }, []);
  return <form className="grid gap-4 border-y border-line py-5" onSubmit={(event) => { event.preventDefault(); void change("/local", "POST", { source, name }).catch(() => {}); }}><h2 className="text-base font-medium text-ink">接入已有本地计划</h2><p className="text-sm text-muted">使用当前用户的 launchd 计划；接入不会重新运行任务或修改原脚本。</p>{error && <p className="text-danger" role="alert">{error}</p>}<Choice label="选择本地计划" onValue={(selected) => { setSource(selected); if (!name) setName(available.find((v) => v.source === selected)?.label ?? ""); }} options={available.map((item) => [item.source, item.label])} value={source} /><TextField label="任务名称" onValue={setName} value={name} /><Button className="w-fit" disabled={busy || !source || !name} type="submit" variant="secondary"><Link2 className="mr-1 size-4" />接入计划</Button>{!available.length && !error && <p className="text-xs text-muted">没有尚未接入的本地计划。可先在当前用户 LaunchAgents 目录中登记计划。</p>}</form>;
}

function LocalTaskForm({ value, change, busy }: { value: ManagedLocalTask; change: Change; busy: boolean }) {
  const [calendar, setCalendar] = useState(value.calendar), [interval, setInterval] = useState(value.interval?.toString() ?? "");
  const updateTime = (index: number, key: keyof ManagedCalendar, text: string) => setCalendar((current) => current.map((time, i) => { if (i !== index) return time; const next = { ...time }; if (!text.trim()) delete next[key]; else next[key] = Number(text); return next; }));
  return <div className="grid max-w-3xl gap-6"><dl className="grid gap-3 text-sm text-ink-soft"><div><dt className="text-xs text-muted">执行入口</dt><dd className="mt-1 break-all font-mono text-xs">{value.command}</dd></div><div><dt className="text-xs text-muted">最近一次退出</dt><dd className="mt-1">{value.running ? "正在运行" : value.lastExitCode === null ? "尚无退出记录" : value.lastExitCode === 0 ? "正常结束" : `退出码 ${value.lastExitCode}`}</dd></div></dl><div className="flex flex-wrap gap-2"><Button disabled={busy || value.running} onClick={() => void change(`/local/${value.id}/${value.loaded ? "disable" : "enable"}`, "POST", { revision: value.revision }).catch(() => {})} variant="outline">{value.loaded ? <Pause className="mr-1 size-4" /> : <Play className="mr-1 size-4" />}{value.loaded ? "停用计划" : "启用计划"}</Button><Button disabled={busy || value.running || !value.loaded} onClick={() => void change(`/local/${value.id}/run`, "POST", { revision: value.revision }).catch(() => {})} variant="secondary"><Play className="mr-1 size-4" />{value.running ? "运行中" : "运行一次"}</Button></div><form className="grid gap-4 border-t border-line pt-5" onSubmit={(event) => { event.preventDefault(); void change(`/local/${value.id}/schedule`, "PUT", { revision: value.revision, calendar, interval: interval.trim() ? Number(interval) : null }).catch(() => {}); }}><h3 className="text-base font-medium text-ink">执行时间</h3><p className="text-xs leading-5 text-muted">使用这台 Mac 的系统时区。日历和间隔二选一；保存会重新加载空闲计划，原计划设置可能触发一次运行。原参数、环境与脚本保留。</p>{calendar.map((time, index) => <div className="flex flex-wrap items-end gap-2" key={index}>{[["Hour", "小时", 23], ["Minute", "分钟", 59], ["Weekday", "星期（0=日）", 7], ["Day", "日期", 31], ["Month", "月份", 12]].map(([field, label, max]) => <label className="grid w-24 gap-1 text-xs text-muted" key={field}>{label}<input aria-label={`${label} ${index + 1}`} className={inputClass} max={max} min={field === "Day" || field === "Month" ? 1 : 0} onChange={(event) => updateTime(index, field as keyof ManagedCalendar, event.target.value)} placeholder="不限" type="number" value={time[field as keyof ManagedCalendar] ?? ""} /></label>)}<Button aria-label={`移除时间 ${index + 1}`} onClick={() => setCalendar((times) => times.filter((_, i) => i !== index))} type="button" variant="ghost"><X className="size-4" /></Button></div>)}<Button className="w-fit" disabled={Boolean(interval)} onClick={() => setCalendar((times) => [...times, { Hour: 9, Minute: 0 }])} size="sm" type="button" variant="outline"><Plus className="mr-1 size-3" />添加时间</Button><TextField hint="不使用日历时可设置间隔，最少60秒。" label="运行间隔（秒，可选）" onValue={setInterval} value={interval} /><Button className="w-fit" disabled={busy || value.running || Boolean(calendar.length && interval)} type="submit" variant="secondary"><Save className="mr-1 size-4" />{busy ? "保存中…" : "保存并应用计划"}</Button></form></div>;
}
