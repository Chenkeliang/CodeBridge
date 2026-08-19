import { useEffect, useRef, useState, type ReactNode } from "react";
import { Archive, ChevronDown, MoreHorizontal, Pencil, Pin, Plus, RefreshCw, Search, Settings2, Sun, Trash2, Workflow } from "lucide-react";
import { BrandAgentIcon, agentTintClass } from "@/components/brand-agent-icon";
import { PixelMark } from "@/components/pixel-mark";
import { Button } from "@/components/ui/button";
import type { AgentProfile, AgentSession, FlowRecord } from "@/lib/types";
import { cn } from "@/lib/utils";
import { relativeTime, statusLabel, type MenuView, type PanelArea, type Theme } from "@/components/workbench-shared";

function useDismissOnOutside(open: boolean, onDismiss: () => void) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) return;
      onDismiss();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onDismiss();
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onDismiss]);
  return rootRef;
}

export function AgentRail({ agents, area, selectedAgentId, theme, onAgent, onArea, onTheme }: {
  agents: AgentProfile[];
  area: PanelArea;
  selectedAgentId: string | null;
  onAgent: (id: string) => void;
  onArea: (area: PanelArea) => void;
  theme: Theme;
  onTheme: () => void;
}) {
  return <aside className={cn("flex min-h-0 flex-col items-center gap-3 border-r px-2.5 py-3", "bg-sidebar", "border-line")}>
    <div className={cn("mb-3 grid size-9 place-items-center rounded-md border", "bg-accent", "text-accent-ink", "border-line-strong")} title="AGNET · CodeBridge"><PixelMark className="size-4" /></div>
    <div className="grid w-full gap-2">
      {agents.map((agent) => {
        const selected = area === "agents" && selectedAgentId === agent.agent_id;
        return <button aria-label={agent.display_name} aria-pressed={selected} className={cn("group relative grid size-[42px] place-items-center rounded-md border border-transparent transition-all duration-150 hover:-translate-y-px hover:opacity-80", "text-muted", selected && cn("bg-surface", "text-ink", "border-line-strong", "shadow-card"))} key={agent.agent_id} onClick={() => onAgent(agent.agent_id)} title={`${agent.display_name} · ${statusLabel[agent.status] ?? agent.status}`} type="button">
          {selected && <span aria-hidden="true" className={cn("absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-full", agentTintClass(agent.agent_id))} />}
          <BrandAgentIcon agentId={agent.agent_id} className="size-[18px]" />
        </button>;
      })}
    </div>
    <div className={cn("my-2 h-px w-8 border-t", "border-line")} />
    <button aria-label="Flows" aria-pressed={area === "flows"} className={cn("grid size-9 place-items-center rounded-md transition-colors hover:opacity-80", "text-muted", area === "flows" && cn("bg-surface", "text-ink", "shadow-card"))} onClick={() => onArea("flows")} title="Flows" type="button"><Workflow className="size-3.5" /></button>
    <div className="flex-1" />
    <button aria-label="设置" aria-pressed={area === "settings"} className={cn("grid size-9 place-items-center rounded-md transition-colors hover:opacity-80", "text-muted", area === "settings" && cn("bg-surface", "text-ink", "shadow-card"))} onClick={() => onArea("settings")} title="设置" type="button"><Settings2 className="size-3.5" /></button>
    <button aria-label="切换主题" className={cn("grid size-9 place-items-center rounded-md transition-all hover:-translate-y-px hover:opacity-80", "text-muted")} onClick={onTheme} title={theme === "paper" ? "Carbon Vermilion" : "Paper Lime"} type="button"><Sun className="size-3.5" /></button>
  </aside>;
}

function SessionRow({ session, selected, onSession, onUpdateSession, onDeleteSession }: {
  session: AgentSession;
  selected: boolean;
  onSession: (session: AgentSession) => void;
  onUpdateSession: (session: AgentSession, update: Record<string, unknown>) => Promise<void>;
  onDeleteSession: (session: AgentSession) => Promise<void>;
}) {
  const title = session.title || "未命名 Session";
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<MenuView>("actions");
  const [renameDraft, setRenameDraft] = useState(title);

  function closeMenu() {
    setMenuOpen(false);
    setMenuView("actions");
  }

  const menuRef = useDismissOnOutside(menuOpen, closeMenu);

  return <div className="group relative" ref={menuRef}>
    <button className={cn("grid w-full gap-1 rounded-md border border-transparent px-3 py-2.5 pr-10 text-left transition-colors hover:opacity-80", "text-ink", selected && cn("bg-surface", "border-line", "shadow-card"))} onClick={() => { closeMenu(); onSession(session); }} title={title} type="button">
      <span className="truncate text-xs font-medium">{title}</span>
      <span className={cn("flex items-center gap-1.5 text-xs", "text-muted")}>{session.pinned_at && <Pin className={cn("size-3", "text-warning")} />}{session.status !== "idle" && <><span>{statusLabel[session.status] ?? session.status}</span><span>·</span></>}<time className="font-mono">{relativeTime(session.updated_at)}</time></span>
    </button>
    <Button aria-label={`管理 ${title}`} className={cn("absolute right-1.5 top-2.5 size-8 px-0", "text-muted", menuOpen ? cn("bg-surface-soft", "text-ink") : "")} onClick={(event) => { event.stopPropagation(); setMenuOpen((current) => !current); setMenuView("actions"); }} size="icon" variant="ghost"><MoreHorizontal className="size-3.5" /></Button>
    {menuOpen && <div className={cn("absolute right-1.5 top-10 z-40 w-48 rounded-lg border p-1", "bg-surface", "border-line-strong", "shadow-panel")} onClick={(event) => event.stopPropagation()}>
      {menuView === "rename" ? <div className="space-y-2 p-2"><label className={cn("text-xs", "text-muted")} htmlFor={`session-name-${session.session_id}`}>Session 名称</label><input autoFocus className={cn("h-8 w-full rounded-md border bg-transparent px-2 text-xs outline-none", "text-ink", "border-line-strong", "focus:border-muted focus-visible:ring-line-strong")} id={`session-name-${session.session_id}`} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && renameDraft.trim()) { void onUpdateSession(session, { title: renameDraft.trim() }); closeMenu(); } if (event.key === "Escape") closeMenu(); }} value={renameDraft} /><div className="flex justify-end gap-1"><MenuButton onClick={closeMenu}>取消</MenuButton><MenuButton disabled={!renameDraft.trim()} onClick={() => { void onUpdateSession(session, { title: renameDraft.trim() }); closeMenu(); }}>保存</MenuButton></div></div>
        : menuView === "delete" ? <div className="space-y-3 p-2"><p className={cn("text-xs leading-5", "text-muted")}>删除后无法恢复这个 Session。</p><div className="flex justify-end gap-1"><MenuButton onClick={() => setMenuView("actions")}>取消</MenuButton><MenuButton danger onClick={() => { void onDeleteSession(session); closeMenu(); }}>删除</MenuButton></div></div>
          : <><MenuButton onClick={() => { void onUpdateSession(session, { pinned: !session.pinned_at }); closeMenu(); }}><Pin className="size-3.5" />{session.pinned_at ? "取消 PIN" : "PIN Session"}</MenuButton><MenuButton onClick={() => { setRenameDraft(title); setMenuView("rename"); }}><Pencil className="size-3.5" />重命名</MenuButton><MenuButton onClick={() => { void onUpdateSession(session, { archived: !session.archived_at }); closeMenu(); }}><Archive className="size-3.5" />{session.archived_at ? "恢复 Session" : "归档"}</MenuButton><MenuButton danger onClick={() => setMenuView("delete")}><Trash2 className="size-3.5" />删除</MenuButton></>}
    </div>}
  </div>;
}

export function SessionPanel({ agent, activeSessionCount, area, archivedSessionCount, flows, flowId, loading, query, sessions, selectedSessionId, showArchived, onCreate, onFlow, onQuery, onRefresh, onSession, onUpdateSession, onDeleteSession, onToggleArchived }: {
  agent: AgentProfile | null;
  activeSessionCount: number;
  area: PanelArea;
  archivedSessionCount: number;
  flows: FlowRecord[];
  flowId: string;
  loading: boolean;
  query: string;
  sessions: AgentSession[];
  selectedSessionId: string | null;
  showArchived: boolean;
  onCreate: () => void;
  onFlow: (id: string) => void;
  onQuery: (value: string) => void;
  onRefresh: () => void;
  onSession: (session: AgentSession) => void;
  onUpdateSession: (session: AgentSession, update: Record<string, unknown>) => Promise<void>;
  onDeleteSession: (session: AgentSession) => Promise<void>;
  onToggleArchived: () => void;
}) {
  return <aside className={cn("flex min-h-0 min-w-0 flex-col border-r", "bg-sidebar", "border-line")}>
    <header className="flex items-start justify-between gap-3 px-5 pb-4 pt-6">
      <div className="min-w-0"><p className={cn("mb-1 font-brand text-xs font-normal uppercase tracking-[0.1em]", "text-muted")}>{area === "agents" ? "当前 Agent" : "目录"}</p><h1 className={cn("truncate font-brand text-lg font-normal tracking-[-0.035em]", "text-ink")}>{area === "agents" ? agent?.display_name ?? "Agents" : "Flows"}</h1><p className={cn("mt-1.5 flex items-center gap-1.5 text-xs", "text-muted")}>{area === "agents" ? (agent?.status === "healthy" ? `${sessions.length} 个会话` : `${statusLabel[agent?.status ?? "unavailable"] ?? agent?.status ?? "不可用"} · ${sessions.length} 个会话`) : `${flows.length} 个已发布定义`}</p></div>
      <div className="flex gap-1">
        <Button aria-label="刷新" className={cn("size-8 px-0 hover:opacity-80", "text-muted")} onClick={onRefresh} size="icon" variant="ghost"><RefreshCw className={cn("size-3.5", loading && "animate-spin")} /></Button>
        {area === "agents" && <Button aria-label="新建 Session" className={cn("size-8 border px-0 hover:-translate-y-px hover:opacity-80", "bg-surface", "text-ink", "border-line-strong")} disabled={!agent || agent.status !== "healthy"} onClick={onCreate} size="icon" variant="outline"><Plus className="size-4" /></Button>}
      </div>
    </header>
    {area === "agents" ? <>
      <div className="px-4 pb-3"><label className={cn("flex h-[34px] items-center gap-2 rounded-md border px-2.5", "bg-surface", "border-line")}><Search className={cn("size-3.5", "text-muted")} /><input aria-label="搜索 Session" className={cn("min-w-0 flex-1 bg-transparent text-xs outline-none", "text-ink", "placeholder:text-faint")} onChange={(event) => onQuery(event.target.value)} placeholder="搜索 Session" value={query} /></label></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
        <div className={cn("px-2.5 py-2 font-brand text-xs font-normal uppercase tracking-[0.1em]", "text-faint")}><span>{showArchived ? "已归档" : "会话"}</span><span className="float-right font-mono">{showArchived ? archivedSessionCount : activeSessionCount}</span></div>
        {sessions.map((session) => <SessionRow key={session.session_id} onDeleteSession={onDeleteSession} onSession={onSession} onUpdateSession={onUpdateSession} selected={selectedSessionId === session.session_id} session={session} />)}
        {!loading && !sessions.length && <div className={cn("px-3 py-8 text-center text-xs", "text-muted")}>{showArchived ? "暂无已归档 Session" : "当前 Agent 暂无 Session"}</div>}
      </div>
      <footer className={cn("border-t px-3 py-2", "border-line")}><button className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-opacity hover:opacity-80", "text-muted")} onClick={onToggleArchived} type="button"><Archive className="size-3.5" /><span className="flex-1">{showArchived ? "返回 Sessions" : "已归档"}</span><span className="font-mono text-xs">{showArchived ? activeSessionCount : archivedSessionCount}</span></button></footer>
    </> : <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4"><div className={cn("px-2.5 py-2 font-brand text-xs font-normal uppercase tracking-[0.1em]", "text-faint")}>已发布</div>{flows.map((flow) => <button className={cn("flex w-full items-center gap-2 rounded-md border border-transparent px-3 py-2.5 text-left text-xs transition-colors hover:opacity-80", "text-ink", flowId === flow.flow_id && cn("bg-surface", "border-line"))} key={flow.flow_id} onClick={() => onFlow(flow.flow_id)} type="button"><Workflow className={cn("size-3.5", "text-muted")} /><span className="min-w-0 flex-1 truncate">{flow.name || flow.flow_id}</span><span className={cn("font-mono text-xs", "text-faint")}>{flow.kind}</span></button>)}{!flows.length && <div className={cn("px-3 py-8 text-center text-xs", "text-muted")}>暂无已发布 Flow</div>}</div>}
  </aside>;
}

export function SessionHeader({ agent, session, runState, menuOpen, menuView, panelOpen, renameDraft, onDelete, onMenu, onMenuView, onRenameDraft, onTogglePanel, onUpdate }: {
  agent: AgentProfile | null;
  session: AgentSession | null;
  runState: "running" | "paused" | "idle";
  menuOpen: boolean;
  menuView: MenuView;
  panelOpen: boolean;
  renameDraft: string;
  onDelete: () => void;
  onMenu: () => void;
  onMenuView: (view: MenuView) => void;
  onRenameDraft: (value: string) => void;
  onTogglePanel: () => void;
  onUpdate: (update: Record<string, unknown>) => void;
}) {
  const menuRef = useDismissOnOutside(menuOpen, onMenu);
  return <header className={cn("flex min-h-[72px] shrink-0 items-center justify-between gap-5 border-b px-8 py-4", "border-line")}>
    <div className="flex min-w-0 items-center gap-3">
      <Button aria-label={panelOpen ? "收起 Session 面板" : "展开 Session 面板"} className={cn("size-8 shrink-0 px-0", "text-muted")} onClick={onTogglePanel} size="icon" title={panelOpen ? "收起面板" : "展开面板"} variant="ghost"><ChevronDown className={cn("size-4 transition-transform", panelOpen ? "rotate-90" : "-rotate-90")} /></Button>{agent && <span aria-hidden="true" className={cn("w-[3px] self-stretch shrink-0 rounded-full", agentTintClass(agent.agent_id))} />}      <span className={cn("grid size-7 shrink-0 place-items-center rounded-md border", "bg-accent", "text-accent-ink", "border-line-strong")}>{agent ? <BrandAgentIcon agentId={agent.agent_id} className="size-3.5" /> : <PixelMark className="size-3.5" />}</span><div className="min-w-0"><h2 className={cn("truncate font-brand text-sm font-normal tracking-[-0.02em]", "text-ink")}>{session?.title || (agent ? `${agent.display_name} Session` : "CodeBridge")}</h2><p className={cn("mt-0.5 truncate text-xs", "text-muted")}>{session?.cwd || agent?.display_name || "Agent Workbench"}{agent && agent.status !== "healthy" ? ` · ${statusLabel[agent.status] ?? agent.status}` : ""}</p></div></div>
    {session && <div className="relative flex items-center gap-2" ref={menuRef}>
      {runState !== "idle" && <span className={cn("hidden items-center gap-1.5 text-xs sm:flex", "text-muted")}><span className={cn("size-1.5 rounded-full", runState === "running" ? "bg-success" : "bg-warning")} />{runState === "running" ? "运行中" : "已暂停"}</span>}
      <Button aria-label="Session 操作" className={cn("size-8 px-0", "text-muted")} onClick={onMenu} size="icon" variant="ghost"><MoreHorizontal className="size-4" /></Button>
      {menuOpen && <div className={cn("absolute right-0 top-11 z-30 w-56 rounded-lg border p-1", "bg-surface", "border-line-strong", "shadow-panel")}>{menuView === "rename" ? <div className="space-y-2 p-2"><label className={cn("text-xs", "text-muted")} htmlFor="session-name">Session 名称</label><input autoFocus className={cn("h-9 w-full rounded-md border bg-transparent px-2.5 text-sm outline-none", "text-ink", "border-line-strong", "focus:border-muted focus-visible:ring-line-strong")} id="session-name" onChange={(event) => onRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && renameDraft.trim()) onUpdate({ title: renameDraft.trim() }); if (event.key === "Escape") onMenuView("actions"); }} value={renameDraft} /><div className="flex justify-end gap-1"><MenuButton onClick={() => onMenuView("actions")}>取消</MenuButton><MenuButton disabled={!renameDraft.trim()} onClick={() => onUpdate({ title: renameDraft.trim() })}>保存</MenuButton></div></div> : menuView === "delete" ? <div className="space-y-3 p-2"><p className={cn("text-xs leading-5", "text-muted")}>删除后无法从 CodeBridge 恢复这个 Session。</p><div className="flex justify-end gap-1"><MenuButton onClick={() => onMenuView("actions")}>取消</MenuButton><MenuButton danger onClick={onDelete}>删除</MenuButton></div></div> : <>
        <MenuButton onClick={() => onUpdate({ pinned: !session.pinned_at })}><Pin className="size-3.5" />{session.pinned_at ? "取消 PIN" : "PIN Session"}</MenuButton>
        <MenuButton onClick={() => { onRenameDraft(session.title || ""); onMenuView("rename"); }}><Pencil className="size-3.5" />重命名</MenuButton>
        <MenuButton onClick={() => onUpdate({ archived: !session.archived_at })}><Archive className="size-3.5" />{session.archived_at ? "恢复 Session" : "归档"}</MenuButton>
        <MenuButton danger onClick={() => onMenuView("delete")}><Trash2 className="size-3.5" />删除</MenuButton>
      </>}</div>}
    </div>}
  </header>;
}


function MenuButton({ children, danger = false, disabled = false, onClick }: { children: ReactNode; danger?: boolean; disabled?: boolean; onClick: () => void }) {
  return <Button className={cn("w-full justify-start text-xs", danger ? "text-danger" : "text-ink-soft")} disabled={disabled} onClick={onClick} size="sm" variant="ghost">{children}</Button>;
}
