import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Circle,
  GitBranch,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { AgentIcon } from "@/components/agent-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, streamSessionEvents } from "@/lib/api";
import { reduceConversationEvents, type ConversationProjection } from "@/lib/events";
import type { AgentCommand, AgentProfile, AgentSession, ConfigOption, FlowRecord, SessionEvent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { isModelOption, orderSessions } from "@/lib/workbench-logic";

const statusLabel: Record<string, string> = {
  healthy: "可用",
  unavailable: "不可用",
  needs_setup: "未配置",
  active: "运行中",
  idle: "空闲",
  closed: "已关闭",
};

export function Workbench() {
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [flows, setFlows] = useState<FlowRecord[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [collapsedAgents, setCollapsedAgents] = useState<Record<string, boolean>>({});
  const [expandedSessions, setExpandedSessions] = useState<Record<string, boolean>>({});
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [commands, setCommands] = useState<AgentCommand[]>([]);
  const [modelOptions, setModelOptions] = useState<ConfigOption[]>([]);
  const [model, setModel] = useState<string>("");
  const [flowId, setFlowId] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<"actions" | "rename" | "delete">("actions");
  const [renameDraft, setRenameDraft] = useState("");
  const streamAbort = useRef<AbortController | null>(null);

  const selectedSession = sessions.find((session) => session.session_id === selectedSessionId) ?? null;
  const selectedAgent = agents.find((agent) => agent.agent_id === (selectedSession?.agent_id ?? selectedAgentId)) ?? null;
  const groupedSessions = useMemo(() => {
    const grouped = new Map<string, AgentSession[]>();
    for (const session of sessions) grouped.set(session.agent_id, [...(grouped.get(session.agent_id) ?? []), session]);
    return grouped;
  }, [sessions]);
  const projection = useMemo(() => reduceConversationEvents(events), [events]);

  const reload = useCallback(async (selectExisting = false) => {
    setLoading(true);
    try {
      const [nextAgents, nextSessions, nextFlows] = await Promise.all([
        api.agents(),
        api.sessions(selectExisting),
        api.flows(),
      ]);
      setAgents(nextAgents);
      setSessions(nextSessions);
      setFlows(nextFlows.filter((flow) => flow.status !== "deprecated"));
      setSelectedAgentId((current) => current ?? nextAgents[0]?.agent_id ?? null);
      setSelectedSessionId((current) => current && nextSessions.some((session) => session.session_id === current) ? current : null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(true); }, [reload]);

  useEffect(() => {
    if (!selectedSessionId) {
      streamAbort.current?.abort();
      setEvents([]);
      setCommands([]);
      setModelOptions([]);
      setModel("");
      setFlowId("");
      setMenuOpen(false);
      setMenuView("actions");
      return;
    }
    let active = true;
    streamAbort.current?.abort();
    setMenuOpen(false);
    setMenuView("actions");
    const controller = new AbortController();
    streamAbort.current = controller;
    setError(null);
    void (async () => {
      try {
        const [history, nextCommands, options] = await Promise.all([
          api.events(selectedSessionId),
          api.commands(selectedSessionId),
          api.configOptions(selectedSessionId),
        ]);
        if (!active) return;
        setEvents(history);
        setCommands(nextCommands);
        setModelOptions(options);
        const session = sessions.find((value) => value.session_id === selectedSessionId);
        setModel(session?.model ?? optionValue(options) ?? "");
        setFlowId(session?.flow_id ?? "");
        await streamSessionEvents(selectedSessionId, history.reduce((max, event) => Math.max(max, event.sequence), 0), controller.signal, (event) => {
          if (active) setEvents((current) => current.some((item) => item.event_id === event.event_id) ? current : [...current, event]);
        });
      } catch (caught) {
        if (active && !controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [selectedSessionId, sessions]);

  async function createSession(agentId: string) {
    setError(null);
    try {
      const session = await api.createSession(agentId);
      setSessions((current) => [session, ...current]);
      setSelectedAgentId(agentId);
      setSelectedSessionId(session.session_id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function submit() {
    if (!selectedSessionId || !draft.trim() || busy) return;
    const message = draft.trim();
    setDraft("");
    setBusy(true);
    setError(null);
    try {
      await api.sendMessage(selectedSessionId, message, flowId || null, model || null);
      await api.startRun(selectedSessionId, flowId || null, model || null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function updateSession(update: Record<string, unknown>) {
    if (!selectedSessionId) return;
    try {
      const updated = await api.updateSession(selectedSessionId, update);
      setSessions((current) => current.map((session) => session.session_id === updated.session_id ? updated : session));
      setModel(updated.model ?? "");
      setMenuOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function deleteSelected() {
    if (!selectedSessionId) return;
    try {
      await api.deleteSession(selectedSessionId);
      setSessions((current) => current.filter((session) => session.session_id !== selectedSessionId));
      setSelectedSessionId(null);
      setMenuOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <div className="flex h-screen min-w-[960px] overflow-hidden bg-zinc-950 text-zinc-100">
      <aside className="flex w-[304px] shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-925">
        <div className="flex h-16 items-center justify-between border-b border-zinc-800/80 px-5">
          <div className="flex items-center gap-3">
            <div className="grid size-8 place-items-center rounded-lg bg-zinc-100 text-zinc-950"><GitBranch className="size-4" /></div>
            <div><p className="text-sm font-semibold tracking-tight">CodeBridge</p><p className="text-[11px] text-zinc-500">Agent Workbench</p></div>
          </div>
          <Button aria-label="刷新" onClick={() => void reload(true)} size="icon" variant="ghost"><RefreshCw className={cn("size-4", loading && "animate-spin")} /></Button>
        </div>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-3 py-5">
          <section>
            <div className="mb-2 flex items-center justify-between px-2"><span className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Agents</span></div>
            <div className="space-y-1">
              {agents.map((agent) => {
                const agentSessions = groupedSessions.get(agent.agent_id) ?? [];
                const orderedSessions = orderSessions(agentSessions);
                const sessionLimit = 8;
                const showingAllSessions = expandedSessions[agent.agent_id] ?? false;
                const visibleSessions = showingAllSessions ? orderedSessions : orderedSessions.slice(0, sessionLimit);
                const hiddenSessionCount = Math.max(0, orderedSessions.length - visibleSessions.length);
                const collapsed = collapsedAgents[agent.agent_id] ?? false;
                return <div key={agent.agent_id}>
                  <div className={cn("group flex items-center gap-2 rounded-lg px-2 py-2", selectedAgentId === agent.agent_id && !selectedSessionId && "bg-zinc-800/70")}>
                    <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => { setSelectedAgentId(agent.agent_id); setSelectedSessionId(null); }}>
                      {collapsed ? <ChevronRight className="size-3.5 text-zinc-500" /> : <ChevronDown className="size-3.5 text-zinc-500" />}
                      <span className="grid size-6 place-items-center rounded-md bg-zinc-800 text-zinc-300"><AgentIcon agentId={agent.agent_id} /></span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{agent.display_name}</span>
                      <span className={cn("size-1.5 rounded-full", agent.status === "healthy" ? "bg-emerald-400" : "bg-zinc-600")} />
                      <span className="text-[10px] tabular-nums text-zinc-600">{agentSessions.length}</span>
                    </button>
                    <button className="grid size-7 place-items-center rounded-md text-zinc-500 opacity-0 transition-opacity hover:bg-zinc-700 hover:text-zinc-200 group-hover:opacity-100 disabled:opacity-30" disabled={agent.status !== "healthy"} title="新建 Session" onClick={() => void createSession(agent.agent_id)}><Plus className="size-4" /></button>
                    <button className="grid size-7 place-items-center rounded-md text-zinc-500 hover:bg-zinc-700" title={collapsed ? "展开" : "折叠"} onClick={() => setCollapsedAgents((current) => ({ ...current, [agent.agent_id]: !collapsed }))}>{collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}</button>
                  </div>
                  {!collapsed && <div className="ml-8 space-y-0.5 border-l border-zinc-800 pl-2">
                    {visibleSessions.map((session) => <button key={session.session_id} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors hover:bg-zinc-800/70", selectedSessionId === session.session_id && "bg-zinc-800 text-zinc-100")} onClick={() => { setSelectedAgentId(agent.agent_id); setSelectedSessionId(session.session_id); }}>
                      {session.pinned_at ? <Pin className="size-3 shrink-0 text-amber-300" /> : <span className="size-3 shrink-0" />}
                      <span className="min-w-0 flex-1 truncate">{session.title || "未命名 Session"}</span>
                    </button>)}
                    {hiddenSessionCount > 0 && <button className="flex w-full items-center justify-between rounded-md px-2 py-2 text-xs text-zinc-600 hover:bg-zinc-800/70 hover:text-zinc-300" onClick={() => setExpandedSessions((current) => ({ ...current, [agent.agent_id]: true }))}><span>显示更多</span><span className="tabular-nums">+{hiddenSessionCount}</span></button>}
                    {showingAllSessions && orderedSessions.length > sessionLimit && <button className="flex w-full items-center rounded-md px-2 py-2 text-xs text-zinc-600 hover:bg-zinc-800/70 hover:text-zinc-300" onClick={() => setExpandedSessions((current) => ({ ...current, [agent.agent_id]: false }))}>收起历史 Session</button>}
                    <button className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs text-zinc-600 hover:bg-zinc-800/70 hover:text-zinc-300" onClick={() => void createSession(agent.agent_id)}><Plus className="size-3.5" />新建 Session</button>
                  </div>}
                </div>;
              })}
            </div>
          </section>
          <section>
            <div className="mb-2 flex items-center justify-between px-2"><span className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Flows</span><Workflow className="size-3.5 text-zinc-600" /></div>
            <div className="space-y-1">
              {flows.map((flow) => <button key={flow.flow_id} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200", flowId === flow.flow_id && "bg-zinc-800 text-zinc-100")} onClick={() => setFlowId(flow.flow_id)}><span className="size-1.5 rounded-full bg-zinc-600" /><span className="min-w-0 flex-1 truncate">{flow.name || flow.flow_id}</span><span className="text-[10px] text-zinc-600">{flow.kind}</span></button>)}
              {!flows.length && <p className="px-2 text-xs text-zinc-600">没有已发布 Flow</p>}
            </div>
          </section>
        </div>
      </aside>
      <main className="relative flex min-w-0 flex-1 flex-col bg-zinc-950">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-zinc-800/80 px-7">
          <div className="flex min-w-0 items-center gap-3"><span className="grid size-7 place-items-center rounded-md bg-zinc-900 text-zinc-300"><AgentIcon agentId={selectedAgent?.agent_id ?? selectedAgentId ?? "agent"} /></span><div className="min-w-0"><p className="truncate text-sm font-medium">{selectedSession?.title || (selectedAgent ? `${selectedAgent.display_name} · 新 Session` : "选择 Agent")}</p>{selectedSession && <p className="truncate text-[11px] text-zinc-500">{selectedSession.cwd || "未绑定工作目录"}</p>}</div>{selectedSession && <Badge variant={selectedSession.status === "active" ? "success" : "muted"}>{statusLabel[selectedSession.status] ?? selectedSession.status}</Badge>}</div>
          {selectedSession && <div className="relative flex items-center gap-2"><select aria-label="模型" className="h-8 max-w-56 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-300 outline-none focus:border-zinc-600" value={model} onChange={(event) => { setModel(event.target.value); void updateSession({ model: event.target.value || null }); }}><option value="">默认模型</option>{modelOptions.filter(isModelOption).flatMap((option) => option.values).map((value) => <option key={value.value} value={value.value}>{value.name || value.value}</option>)}</select><Button aria-label="Session 操作" onClick={() => { setMenuOpen((current) => !current); setMenuView("actions"); }} size="icon" variant="ghost"><MoreHorizontal className="size-4" /></Button>{menuOpen && <div className="absolute right-0 top-11 z-10 w-56 rounded-lg border border-zinc-800 bg-zinc-900 p-1 shadow-2xl">{menuView === "rename" ? <div className="space-y-2 p-2"><label className="text-xs text-zinc-400" htmlFor="session-name">Session 名称</label><input autoFocus className="h-9 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 text-sm text-zinc-100 outline-none focus:border-zinc-500" id="session-name" onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && renameDraft.trim()) void updateSession({ title: renameDraft.trim() }); if (event.key === "Escape") setMenuView("actions"); }} value={renameDraft} /><div className="flex justify-end gap-1"><Button onClick={() => setMenuView("actions")} size="sm" variant="ghost">取消</Button><Button disabled={!renameDraft.trim()} onClick={() => void updateSession({ title: renameDraft.trim() })} size="sm">保存</Button></div></div> : menuView === "delete" ? <div className="space-y-3 p-2"><p className="text-xs leading-5 text-zinc-400">删除后将无法从 CodeBridge 恢复这个 Session。</p><div className="flex justify-end gap-1"><Button onClick={() => setMenuView("actions")} size="sm" variant="ghost">取消</Button><Button onClick={() => void deleteSelected()} size="sm" variant="destructive">删除</Button></div></div> : <><Button className="w-full justify-start" onClick={() => void updateSession({ pinned: !selectedSession.pinned_at })} size="sm" variant="ghost"><Pin className="size-3.5" />{selectedSession.pinned_at ? "取消 PIN" : "PIN Session"}</Button><Button className="w-full justify-start" onClick={() => { setRenameDraft(selectedSession.title || ""); setMenuView("rename"); }} size="sm" variant="ghost"><Pencil className="size-3.5" />重命名</Button><Button className="w-full justify-start" onClick={() => void updateSession({ archived: true })} size="sm" variant="ghost"><Archive className="size-3.5" />归档</Button><Button className="w-full justify-start text-red-300 hover:text-red-200" onClick={() => setMenuView("delete")} size="sm" variant="ghost"><Trash2 className="size-3.5" />删除</Button></>}</div>}</div>}
        </header>
        {error && <div className="mx-7 mt-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300"><X className="size-3.5" />{error}</div>}
        {!selectedSession ? <div className="flex flex-1 items-center justify-center px-6"><div className="w-full max-w-2xl"><div className="mb-8 text-center"><p className="mb-3 text-xs uppercase tracking-[0.28em] text-zinc-600">Session-first workspace</p><h1 className="text-3xl font-medium tracking-tight text-zinc-100">从目标开始</h1><p className="mt-3 text-sm text-zinc-500">选择一个 Agent，创建 Session，然后用自然语言描述你要完成的工作。</p></div><Composer draft={draft} setDraft={setDraft} onSubmit={() => void submit()} busy={busy} flowId={flowId} setFlowId={setFlowId} flows={flows} commands={commands} disabled={!selectedAgent || selectedAgent.status !== "healthy"} /></div></div> : <div className="flex min-h-0 flex-1 flex-col"><div className="min-h-0 flex-1 overflow-y-auto px-7 py-8"><div className="mx-auto flex max-w-3xl flex-col gap-5">{projection.length ? projection.map((item, index) => <ProjectionItem key={item.kind === "tool" ? item.id : `${item.kind}-${index}`} item={item} />) : <div className="flex min-h-[45vh] items-center justify-center text-sm text-zinc-600">描述目标，Agent 会在当前 Session 中处理。</div>}{busy && <div className="flex items-center gap-2 text-xs text-zinc-500"><LoaderCircle className="size-3.5 animate-spin" />正在处理</div>}</div></div><div className="border-t border-zinc-800/80 bg-zinc-950/95 px-7 py-5"><div className="mx-auto max-w-3xl"><Composer draft={draft} setDraft={setDraft} onSubmit={() => void submit()} busy={busy} flowId={flowId} setFlowId={setFlowId} flows={flows} commands={commands} disabled={false} /></div></div></div>}
      </main>
    </div>
  );
}

function Composer({ draft, setDraft, onSubmit, busy, flowId, setFlowId, flows, commands, disabled }: { draft: string; setDraft: (value: string) => void; onSubmit: () => void; busy: boolean; flowId: string; setFlowId: (value: string) => void; flows: FlowRecord[]; commands: AgentCommand[]; disabled: boolean }) {
  return <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-2 shadow-2xl shadow-black/20"><Textarea aria-label="消息" className="min-h-[104px] border-0 bg-transparent px-3 py-2 shadow-none focus:border-0 focus:ring-0" disabled={disabled || busy} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSubmit(); } }} placeholder="描述你要完成的目标…" value={draft} /><div className="flex items-center justify-between px-2 pb-1 pt-2"><div className="flex min-w-0 items-center gap-2"><select aria-label="Flow" className="h-8 max-w-52 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-400 outline-none focus:border-zinc-600" onChange={(event) => setFlowId(event.target.value)} value={flowId}><option value="">自动理解上下文</option>{flows.map((flow) => <option key={flow.flow_id} value={flow.flow_id}>{flow.name || flow.flow_id}</option>)}</select>{commands.length > 0 && <span className="truncate text-[11px] text-zinc-600">/{commands.length} 个 Agent 命令</span>}</div><Button aria-label="发送" disabled={disabled || busy || !draft.trim()} onClick={onSubmit} size="icon"><Send className="size-4" /></Button></div></div>;
}

function ProjectionItem({ item }: { item: ConversationProjection }) {
  if (item.kind === "assistant") return <article className={cn("max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-7", item.phase === "commentary" ? "self-start border border-zinc-800 bg-zinc-900/50 text-zinc-400" : "self-start text-zinc-200")}><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown></article>;
  return <details className="group rounded-xl border border-zinc-800 bg-zinc-900/55 text-sm"><summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-zinc-400"><Circle className={cn("size-2.5 fill-current", item.status === "completed" ? "text-emerald-400" : item.status === "failed" ? "text-red-400" : "text-amber-300")} /><span className="font-mono text-xs text-zinc-300">{item.name}</span><span className="ml-auto text-[11px] text-zinc-600">{item.status}</span><ChevronDown className="size-3.5 transition-transform group-open:rotate-180" /></summary><div className="grid gap-3 border-t border-zinc-800 px-4 py-3 text-xs"><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-zinc-500">{formatValue(item.input)}</pre>{item.output !== undefined && <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-zinc-400">{formatValue(item.output)}</pre>}</div></details>;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function optionValue(options: ConfigOption[]): string | undefined {
  return options.find(isModelOption)?.currentValue;
}
