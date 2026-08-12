import { useMemo, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Circle,
  Code2,
  FileCode2,
  Layers3,
  MoreHorizontal,
  Paperclip,
  Pin,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldAlert,
  Sun,
  Workflow,
  X,
} from "lucide-react";
import { BrandAgentIcon } from "@/components/brand-agent-icon";
import { PixelMark } from "@/components/pixel-mark";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Theme = "paper" | "carbon";
type Area = "agents" | "flows";

const agents = [
  { id: "codex", name: "Codex", status: "Ready" },
  { id: "pi", name: "Pi", status: "Ready" },
  { id: "cursor", name: "Cursor", status: "Ready" },
  { id: "claude", name: "Claude Code", status: "Ready" },
  { id: "opencode", name: "OpenCode", status: "Offline" },
] as const;

const sessionSets: Record<string, string[]> = {
  codex: ["Session switching performance", "Provider history review", "Workbench interaction pass", "Prepare a review branch"],
  pi: ["Investigate session hydration", "Review local tool access"],
  cursor: ["Workspace context review", "Provider history review", "Prepare a review branch"],
  claude: ["Review provider history", "Refine the error state", "Inspect workspace context"],
  opencode: [],
};

const flowNames = ["Repository review", "Workspace diagnosis", "Release verification"];

export function DesignPreview() {
  const [theme, setTheme] = useState<Theme>("paper");
  const [area, setArea] = useState<Area>("agents");
  const [activeAgent, setActiveAgent] = useState("codex");
  const [activeSession, setActiveSession] = useState(sessionSets.codex[0]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [approval, setApproval] = useState<"pending" | "approved" | "denied">("pending");
  const [notice, setNotice] = useState("");
  const activeProfile = agents.find((agent) => agent.id === activeAgent) ?? agents[0];
  const filteredSessions = useMemo(
    () => (sessionSets[activeAgent] ?? []).filter((session) => session.toLowerCase().includes(query.toLowerCase())),
    [activeAgent, query],
  );

  function notify(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => current === message ? "" : current), 1800);
  }

  function selectAgent(agentId: string) {
    setActiveAgent(agentId);
    setActiveSession(sessionSets[agentId]?.[0] ?? "New Session");
    setArea("agents");
    setQuery("");
    notify(`已切换到 ${agents.find((agent) => agent.id === agentId)?.name ?? agentId}`);
  }

  function sendMessage() {
    if (!draft.trim()) return;
    notify("消息已加入当前 Session");
    setDraft("");
  }

  return (
    <div className={cn("grid h-[100dvh] min-h-[100dvh] min-w-[1040px] grid-cols-[60px_286px_minmax(0,1fr)] overflow-hidden font-sans text-[13px] tracking-[-0.01em]", "bg-canvas text-ink")} data-theme={theme}>
      <aside className={cn("flex min-h-0 flex-col items-center gap-3 border-r px-2.5 py-3", "bg-sidebar", "border-line")}>
        <div className={cn("mb-3 grid size-9 place-items-center rounded-md border", "bg-accent", "text-accent-ink", "border-line-strong")}><PixelMark className="size-4" /></div>
        <div className="grid w-full gap-2">
          {agents.map((agent) => <button aria-label={agent.name} aria-pressed={area === "agents" && activeAgent === agent.id} className={cn("group relative grid size-[42px] place-items-center rounded-md border border-transparent transition-all duration-150 hover:-translate-y-px hover:opacity-80", "text-muted", area === "agents" && activeAgent === agent.id && cn("bg-surface", "text-ink", "border-line-strong", "shadow-card"))} key={agent.id} onClick={() => selectAgent(agent.id)} title={agent.name} type="button">
            <BrandAgentIcon agentId={agent.id} className="size-[18px]" />
            <span className={cn("absolute bottom-1.5 right-1.5 size-1.5 rounded-full border-2", "border-sidebar", agent.status === "Ready" ? "bg-success" : "bg-faint")} />
          </button>)}
        </div>
        <div className={cn("my-2 h-px w-8", "bg-line")} />
        <button aria-label="Flows" aria-pressed={area === "flows"} className={cn("grid size-9 place-items-center rounded-md transition-colors hover:opacity-80", "text-muted", area === "flows" && cn("bg-surface", "text-ink", "shadow-card"))} onClick={() => setArea("flows")} title="Flows" type="button"><Workflow className="size-3.5" /></button>
        <div className="flex-1" />
        <button aria-label="切换主题" className={cn("grid size-9 place-items-center rounded-md transition-all hover:-translate-y-px hover:opacity-80", "text-muted")} onClick={() => setTheme((current) => current === "paper" ? "carbon" : "paper")} title={theme === "paper" ? "Carbon Vermilion" : "Paper Lime"} type="button"><Sun className="size-3.5" /></button>
        <button aria-label="设置" className={cn("grid size-9 place-items-center rounded-md transition-colors hover:opacity-80", "text-muted")} onClick={() => notify("设置将在确认设计后接入")} title="设置" type="button"><Settings2 className="size-3.5" /></button>
      </aside>

      <aside className={cn("flex min-h-0 min-w-0 flex-col border-r", "bg-sidebar", "border-line")}>
        <header className="flex items-start justify-between gap-3 px-5 pb-4 pt-6">
          <div><p className={cn("mb-1 text-[11px] font-semibold uppercase tracking-[0.1em]", "text-muted")}>Agent profile</p><h1 className={cn("text-lg font-semibold tracking-[-0.035em]", "text-ink")}>{area === "agents" ? activeProfile.name : "Flows"}</h1><p className={cn("mt-1.5 flex items-center gap-1.5 text-[11px]", "text-muted")}><Circle className={cn("size-1.5 fill-current", activeProfile.status === "Ready" ? "text-success" : "text-faint")} />{area === "agents" ? `${activeProfile.status} · ${sessionSets[activeAgent]?.length ?? 0} sessions` : "Published definitions"}</p></div>
          <Button aria-label="新建 Session" className={cn("size-8 border px-0 hover:-translate-y-px hover:opacity-80", "bg-surface", "text-ink", "border-line-strong")} onClick={() => { setActiveSession("New Session"); notify(`已为 ${activeProfile.name} 创建新 Session`); }} size="icon" variant="outline"><Plus className="size-4" /></Button>
        </header>
        {area === "agents" ? <>
          <div className="flex gap-2 px-4 pb-3"><label className={cn("flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-md border px-2.5", "bg-surface", "border-line")}><Search className={cn("size-3.5", "text-muted")} /><input aria-label="搜索 Session" className={cn("min-w-0 flex-1 bg-transparent text-xs outline-none", "text-ink")} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Session" value={query} /></label><Button aria-label="筛选 Session" className={cn("size-[34px] px-0 hover:opacity-80", "bg-surface", "text-muted", "border-line")} onClick={() => notify("Session 筛选")} size="icon" variant="outline"><Layers3 className="size-3.5" /></Button></div>
          <div className="min-h-0 flex-1 overflow-auto px-2.5 pb-4">
            <div className={cn("px-2.5 py-2 text-[11px] font-semibold uppercase tracking-[0.1em]", "text-faint")}><span>Sessions</span><span className="float-right font-mono">{filteredSessions.length}</span></div>
            {filteredSessions.map((session, index) => <button className={cn("relative grid w-full gap-1 rounded-md border border-transparent px-3 py-2.5 text-left transition-colors hover:opacity-80", "text-ink", activeSession === session && cn("bg-surface", "border-line", "shadow-card"))} key={session} onClick={() => { setActiveSession(session); notify(`已切换到 ${session}`); }} type="button"><span className="truncate pr-3 text-xs font-semibold">{session}</span><span className={cn("flex items-center gap-1.5 text-[11px]", "text-muted")}>{index === 0 && <Pin className={cn("size-3", "text-warning")} />}<span>{index === 0 ? "Running" : "Ready"}</span><span>·</span><span className="font-mono">{index === 0 ? "now" : `${index}h`}</span></span>{activeSession === session && <span className={cn("absolute right-2.5 top-3.5 size-1.5 rounded-full", "bg-accent")} />}</button>)}
            {!filteredSessions.length && <div className={cn("px-3 py-8 text-center text-xs", "text-muted")}>没有匹配的 Session</div>}
          </div>
          <footer className={cn("flex items-center justify-between border-t px-4 py-3 text-[11px]", "border-line", "text-muted")}><Button className={cn("h-auto p-0 text-[11px] hover:opacity-80", "text-muted")} onClick={() => notify("已归档 Session")} size="sm" variant="ghost">已归档</Button><span className="font-mono">{sessionSets[activeAgent]?.length ?? 0} active</span></footer>
        </> : <div className="min-h-0 flex-1 overflow-auto px-2.5 pb-4"><div className={cn("px-2.5 py-2 text-[11px] font-semibold uppercase tracking-[0.1em]", "text-faint")}>Published</div>{flowNames.map((name, index) => <button className={cn("flex w-full items-center gap-2 rounded-md border border-transparent px-3 py-2.5 text-left text-xs transition-colors hover:opacity-80", "text-ink")} key={name} onClick={() => notify(`Flow · ${name}`)} type="button"><Workflow className={cn("size-3.5", "text-muted")} /><span className="min-w-0 flex-1 truncate">{name}</span><span className={cn("font-mono text-[11px]", "text-faint")}>v1.{index + 1}</span></button>)}</div>}
      </aside>

      <main className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden", "bg-canvas text-ink")}>
        <header className={cn("flex min-h-[72px] items-center justify-between gap-5 border-b px-8 py-4", "border-line")}>
          <div className="flex min-w-0 items-center gap-3"><span className={cn("grid size-7 place-items-center rounded-md border", "bg-surface", "text-ink", "border-line-strong")}><BrandAgentIcon agentId={activeAgent} className="size-3.5" /></span><div className="min-w-0"><h2 className={cn("truncate text-sm font-semibold tracking-[-0.02em]", "text-ink")}>{activeSession}</h2><p className={cn("mt-0.5 text-[11px]", "text-muted")}>{activeProfile.name} · CodeBridge</p></div></div>
          <div className={cn("flex items-center gap-2 text-[11px]", "text-muted")}><span className={cn("size-1.5 rounded-full", "bg-accent")} /><span>Running</span><code className={cn("rounded border px-1.5 py-0.5 font-mono text-[11px]", "bg-surface-soft", "text-ink-soft", "border-line")}>run_7a31</code><Button aria-label="更多操作" className={cn("size-8 px-0 hover:opacity-80", "text-muted")} onClick={() => notify("Session actions")} size="icon" variant="ghost"><MoreHorizontal className="size-4" /></Button></div>
        </header>

        <section className="min-h-0 flex-1 overflow-auto px-8 pt-7" aria-label="Session conversation"><div className="mx-auto w-full max-w-[880px] pb-6">
          <div className={cn("mb-7 flex items-center justify-between gap-3 border-b py-2 text-[11px]", "border-line", "text-muted")}><div className="flex items-center gap-2"><span className={cn("inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-semibold", "bg-accent-soft", "text-ink-soft")}><Circle className="size-1.5 fill-current" />Run active</span><span>Agent is working through the current plan</span></div><code className={cn("font-mono text-[11px]", "text-faint")}>workspace / CodeBridge</code></div>
          <Message role="user">分析当前 Session 切换链路，并确认下一步需要哪些上下文。</Message>
          <div className="mb-7 grid gap-2.5"><span className={cn("text-[11px] font-semibold uppercase tracking-[0.08em]", "text-muted")}>{activeProfile.name} · working</span><div className={cn("max-w-[760px] text-sm leading-7", "text-ink-soft")}><p className="mb-3">我会先检查 Session、事件、资源加载和 Provider 恢复四段链路，再根据当前目录和权限判断下一步。</p><p>入口追踪已完成，正在验证 Provider 侧的会话集合。</p></div><PlanCard /></div>
          <div className="mb-4"><ToolCard /></div>
          <div className="mb-4"><DiffCard /></div>
          <ApprovalCard state={approval} onApprove={() => { setApproval("approved"); notify("Approval recorded"); }} onDeny={() => { setApproval("denied"); notify("Run paused"); }} />
        </div></section>

        <footer className="px-8 pb-5 pt-3"><div className={cn("mx-auto w-full max-w-[880px] rounded-xl border", "bg-surface", "border-line-strong", "shadow-panel")}><div className="flex items-center gap-1.5 px-3 pt-2.5"><ContextChip label="Auto" /><ContextChip label="Agent default" /><ContextChip label="Workspace" /><ContextChip label="Flow · Automatic" /><span className="flex-1" /><span className={cn("hidden text-[11px] sm:inline", "text-faint")}>⌘ ↵ to send</span></div><Textarea aria-label="输入目标" className={cn("min-h-[70px] resize-none border-0 bg-transparent px-3.5 py-3 text-sm shadow-none focus:border-0 focus:ring-0", "text-ink")} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); sendMessage(); } }} placeholder="输入目标，或继续调整当前工作…" value={draft} /><div className="flex items-center justify-between gap-3 px-3 pb-2.5"><div className="flex items-center gap-1"><Button aria-label="添加文件" className={cn("size-8 px-0 hover:opacity-80", "text-muted")} onClick={() => notify("Attach files")} size="icon" variant="ghost"><Paperclip className="size-3.5" /></Button><Button aria-label="添加上下文" className={cn("size-8 px-0 text-xs hover:opacity-80", "text-muted")} onClick={() => notify("Add context")} size="icon" variant="ghost"><span>@</span></Button><Button aria-label="Agent commands" className={cn("size-8 px-0 text-xs hover:opacity-80", "text-muted")} onClick={() => notify("Agent commands")} size="icon" variant="ghost"><span>/</span></Button></div><Button aria-label="发送" className={cn("size-8 px-0 hover:opacity-80", "bg-accent", "text-accent-ink")} disabled={!draft.trim()} onClick={sendMessage} size="icon"><Send className="size-4" /></Button></div></div></footer>
      </main>
      {notice && <div className={cn("fixed bottom-6 right-6 rounded-md border px-3 py-2 text-xs", "bg-surface", "text-ink", "border-line-strong", "shadow-panel")} role="status">{notice}</div>}
    </div>
  );
}

function ContextChip({ label }: { label: string }) {
  return <button className={cn("inline-flex min-h-7 items-center gap-1.5 rounded border px-2 text-[11px] transition-opacity hover:opacity-80", "bg-surface-soft", "text-muted", "border-line")} type="button"><span className={cn("font-semibold", "text-ink-soft")}>{label}</span></button>;
}

function Message({ role, children }: { role: "user" | "assistant"; children: ReactNode }) {
  return <article className={cn("mb-7 grid gap-2", role === "user" && "justify-items-end")}><span className={cn("text-[11px] font-semibold uppercase tracking-[0.08em]", "text-muted")}>{role === "user" ? "You · just now" : "Agent"}</span><div className={cn("max-w-[72%] rounded-xl px-3.5 py-3 text-sm leading-6", role === "user" ? cn("text-ink", "bg-accent-soft") : "text-ink-soft")}>{children}</div></article>;
}

function PlanCard() {
  return <section className={cn("max-w-[760px] rounded-lg border", "bg-surface", "border-line", "shadow-card")}><div className={cn("flex items-center justify-between gap-3 border-b px-3.5 py-3", "border-line")}><span className={cn("flex items-center gap-2 text-[11px] font-semibold", "text-ink")}><Check className={cn("size-3.5", "text-muted")} />Plan</span><span className={cn("font-mono text-[11px]", "text-muted")}>2 / 3</span></div><ol className={cn("grid gap-2 px-3.5 py-3.5 text-xs", "text-muted")}><li className={cn("flex items-center gap-2", "text-ink-soft")}><Check className={cn("size-3.5", "text-success")} />Trace the Session switch path</li><li className={cn("flex items-center gap-2", "text-ink-soft")}><Check className={cn("size-3.5", "text-success")} />Measure Provider resource loading</li><li className={cn("flex items-center gap-2", "text-ink")}><Circle className={cn("size-3.5", "text-warning")} />Compare Agent history sources</li></ol></section>;
}

function ToolCard() {
  return <section className={cn("max-w-[760px] rounded-lg border", "bg-surface", "border-line", "shadow-card")}><details><summary className={cn("flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-3 text-xs", "text-muted")}><Code2 className="size-3.5" /><span className={cn("min-w-0 flex-1 truncate font-semibold", "text-ink")}>Read · apps/bridge/src/session-api.ts</span><span className={cn("text-[11px]", "text-success")}>Completed</span><ChevronDown className="size-3.5" /></summary><div className={cn("grid gap-2.5 border-t px-3.5 py-3", "border-line")}><pre className={cn("max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-6", "text-muted")}>{"GET /v1/sessions/:id\nGET /v1/sessions/:id/config-options\nGET /v1/sessions/:id/events"}</pre></div></details></section>;
}

function DiffCard() {
  return <section className={cn("max-w-[760px] rounded-lg border", "bg-surface", "border-line", "shadow-card")}><div className={cn("flex items-center justify-between gap-3 border-b px-3.5 py-3", "border-line")}><span className={cn("flex items-center gap-2 text-[11px] font-semibold", "text-ink")}><FileCode2 className="size-3.5" />Proposed change</span><span className={cn("font-mono text-[11px]", "text-muted")}>2 files</span></div><div className="flex gap-1 px-2.5 pt-2"><Button className={cn("h-7 px-2 text-[11px]", "bg-surface-soft", "text-ink")} size="sm" variant="ghost">Diff</Button><Button className={cn("h-7 px-2 text-[11px]", "text-muted")} size="sm" variant="ghost">Files</Button></div><div className={cn("grid overflow-auto py-2 font-mono text-[11px] leading-6", "bg-surface-tint")}><code className={cn("px-3.5", "text-danger")}>- await loadSessionResources(session)</code><code className={cn("px-3.5", "text-success")}>+ void loadSessionResources(session)</code><code className={cn("px-3.5", "text-success")}>+ cache options by Agent and workspace</code></div></section>;
}

function ApprovalCard({ state, onApprove, onDeny }: { state: "pending" | "approved" | "denied"; onApprove: () => void; onDeny: () => void }) {
  if (state === "approved") return <section className={cn("max-w-[760px] rounded-lg border p-3.5", "bg-surface", "border-line", "shadow-card")}><div className={cn("flex items-center gap-2 text-xs font-semibold", "text-success")}><Check className="size-3.5" />Approved<span className={cn("ml-auto font-mono text-[11px] font-normal", "text-muted")}>scoped to this Run</span></div></section>;
  if (state === "denied") return <section className={cn("max-w-[760px] rounded-lg border p-3.5", "bg-surface", "border-line", "shadow-card")}><div className={cn("flex items-center gap-2 text-xs font-semibold", "text-danger")}><X className="size-3.5" />Run paused<span className={cn("ml-auto font-mono text-[11px] font-normal", "text-muted")}>approval denied</span></div></section>;
  return <section className={cn("max-w-[760px] rounded-lg border", "bg-surface", "border-line-strong", "shadow-card")}><div className={cn("flex items-center justify-between gap-3 border-b px-3.5 py-3", "border-line")}><span className={cn("flex items-center gap-2 text-[11px] font-semibold", "text-ink")}><ShieldAlert className={cn("size-3.5", "text-warning")} />Needs approval</span><span className={cn("font-mono text-[11px]", "text-muted")}>before next step</span></div><div className={cn("px-3.5 pb-1 pt-3 text-xs leading-5", "text-ink-soft")}>Agent wants to apply the verified change to the current feature branch. No production or main branch mutation is included.<span className={cn("mt-2 flex items-center gap-1.5 text-[11px] font-semibold", "text-warning")}><Circle className="size-1.5 fill-current" />Branch write · reviewable</span></div><div className="flex gap-2 px-3.5 pb-3.5 pt-2"><Button className={cn("h-8 text-xs", "bg-accent", "text-accent-ink")} onClick={onApprove} size="sm">Allow once</Button><Button className={cn("h-8 text-xs", "bg-surface", "text-ink", "border-line-strong")} onClick={onDeny} size="sm" variant="outline">Deny</Button></div></section>;
}
