import { Fragment, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Search, Terminal, Zap } from "lucide-react";
import { BrandAgentIcon } from "@/components/brand-agent-icon";
import type { AgentProfile, AgentSession } from "@/lib/types";
import { cn } from "@/lib/utils";
import { relativeTime, statusLabel } from "@/components/workbench-shared";

interface PaletteItem {
  id: string;
  group: string;
  title: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette({ agents, sessions, selectedAgentId, canCreate, onClose, onSelectAgent, onSelectSession, onCreateSession, onToggleTheme }: {
  agents: AgentProfile[];
  sessions: AgentSession[];
  selectedAgentId: string | null;
  canCreate: boolean;
  onClose: () => void;
  onSelectAgent: (id: string) => void;
  onSelectSession: (session: AgentSession) => void;
  onCreateSession: () => void;
  onToggleTheme: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const items = useMemo<PaletteItem[]>(() => {
    const all: PaletteItem[] = [
      ...agents.map((agent) => ({
        id: `agent:${agent.agent_id}`,
        group: "Agent",
        title: agent.display_name,
        hint: statusLabel[agent.status] ?? agent.status,
        run: () => onSelectAgent(agent.agent_id),
      })),
      ...sessions.map((session) => ({
        id: `session:${session.session_id}`,
        group: "会话",
        title: session.title || "未命名 Session",
        hint: relativeTime(session.updated_at),
        run: () => onSelectSession(session),
      })),
      ...(canCreate ? [{ id: "action:new", group: "操作", title: "新建 Session", hint: "⌘N", run: onCreateSession }] : []),
      { id: "action:theme", group: "操作", title: "切换主题", hint: "", run: onToggleTheme },
    ];
    const lowered = query.toLowerCase();
    return lowered ? all.filter((item) => item.title.toLowerCase().includes(lowered)) : all;
  }, [agents, sessions, query, canCreate, onSelectAgent, onSelectSession, onCreateSession, onToggleTheme]);

  useEffect(() => setIndex(0), [query]);

  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") { onClose(); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); setIndex((i) => Math.min(i + 1, items.length - 1)); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); return; }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = items[index];
      if (item) { onClose(); item.run(); }
    }
  }

  let lastGroup = "";
  return <div aria-modal="true" className="fixed inset-0 z-50 bg-canvas/80" onClick={onClose} role="dialog">
    <div className={cn("mx-auto mt-[18vh] w-full max-w-[480px] overflow-hidden rounded-xl border", "bg-surface", "border-line-strong", "shadow-panel")} onClick={(event) => event.stopPropagation()}>
      <div className={cn("flex h-11 items-center gap-2 border-b px-3.5", "border-line")}>
        <Search className={cn("size-4 shrink-0", "text-muted")} />
        <input aria-label="命令面板" autoFocus className={cn("min-w-0 flex-1 bg-transparent text-sm outline-none", "text-ink", "placeholder:text-faint")} onChange={(event) => setQuery(event.target.value)} onKeyDown={handleKey} placeholder="切换 Agent / Session，或执行操作…" value={query} />
        <kbd className={cn("rounded border px-1.5 py-0.5 font-mono text-[11px]", "text-faint", "border-line")}>esc</kbd>
      </div>
      <div className="max-h-80 overflow-y-auto p-1.5">
        {items.map((item, itemIndex) => {
          const header = item.group !== lastGroup ? (lastGroup = item.group, <div className={cn("px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.1em]", "text-faint")} key={`group-${item.group}`}>{item.group}</div>) : null;
          return <Fragment key={item.id}>{header}<button aria-selected={itemIndex === index} className={cn("flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px]", "text-ink", itemIndex === index ? "bg-surface-soft" : "")} onClick={() => { onClose(); item.run(); }} onMouseEnter={() => setIndex(itemIndex)} ref={itemIndex === index ? (node) => node?.scrollIntoView({ block: "nearest" }) : undefined} type="button">
            {item.id.startsWith("agent:") ? <BrandAgentIcon agentId={item.id.slice(6)} className="size-3.5 shrink-0" /> : item.id.startsWith("session:") ? <Terminal className={cn("size-3.5 shrink-0", "text-muted")} /> : <Zap className={cn("size-3.5 shrink-0", "text-muted")} />}
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {item.hint && <span className={cn("shrink-0 font-mono text-[11px]", "text-faint")}>{item.hint}</span>}
          </button></Fragment>;
        })}
        {items.length === 0 && <div className={cn("px-3 py-8 text-center text-xs", "text-muted")}>没有匹配项</div>}
      </div>
    </div>
  </div>;
}

