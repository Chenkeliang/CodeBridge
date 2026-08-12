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

const themes = {
  paper: {
    canvas: "bg-[#F6F7F4] text-[#191C16]",
    sidebar: "bg-[#FBFCFA]",
    surface: "bg-white",
    surfaceSoft: "bg-[#EEF1EB]",
    surfaceTint: "bg-[#F2F4EF]",
    ink: "text-[#191C16]",
    inkSoft: "text-[#373C32]",
    muted: "text-[#73796C]",
    faint: "text-[#9CA296]",
    line: "border-[#E0E4DC]",
    lineStrong: "border-[#CDD3C8]",
    accent: "bg-[#CCFF00]",
    accentText: "text-[#171A11]",
    accentSoft: "bg-[#E9F6AD]",
    success: "text-[#3B8659]",
    warning: "text-[#C27B18]",
    danger: "text-[#D25D3D]",
    shadow: "shadow-[0_20px_48px_rgba(25,28,22,0.08)]",
    shadowSmall: "shadow-[0_4px_16px_rgba(25,28,22,0.07)]",
  },
  carbon: {
    canvas: "bg-[#121411] text-[#F1F2EA]",
    sidebar: "bg-[#181A17]",
    surface: "bg-[#1C1F1B]",
    surfaceSoft: "bg-[#282C25]",
    surfaceTint: "bg-[#20231E]",
    ink: "text-[#F1F2EA]",
    inkSoft: "text-[#D2D6C9]",
    muted: "text-[#9DA496]",
    faint: "text-[#6E7669]",
    line: "border-[#30352D]",
    lineStrong: "border-[#444B40]",
    accent: "bg-[#FF683D]",
    accentText: "text-[#211610]",
    accentSoft: "bg-[#4B281F]",
    success: "text-[#74BF8F]",
    warning: "text-[#E7AA4E]",
    danger: "text-[#FF8063]",
    shadow: "shadow-[0_20px_56px_rgba(0,0,0,0.28)]",
    shadowSmall: "shadow-[0_5px_18px_rgba(0,0,0,0.22)]",
  },
} as const;

export function DesignPreview() {
  const [theme, setTheme] = useState<Theme>("paper");
  const [area, setArea] = useState<Area>("agents");
  const [activeAgent, setActiveAgent] = useState("codex");
  const [activeSession, setActiveSession] = useState(sessionSets.codex[0]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [approval, setApproval] = useState<"pending" | "approved" | "denied">("pending");
  const [notice, setNotice] = useState("");
  const t = themes[theme];
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
    <div className={cn("grid h-[100dvh] min-h-[100dvh] min-w-[1040px] grid-cols-[60px_286px_minmax(0,1fr)] overflow-hidden font-sans text-[13px] tracking-[-0.01em]", t.canvas)}>
      <aside className={cn("flex min-h-0 flex-col items-center gap-3 border-r px-2.5 py-3", t.sidebar, t.line)}>
        <div className={cn("mb-3 grid size-9 place-items-center rounded-md border", t.accent, t.accentText, t.lineStrong)}><PixelMark className="size-4" /></div>
        <div className="grid w-full gap-2">
          {agents.map((agent) => <button aria-label={agent.name} aria-pressed={area === "agents" && activeAgent === agent.id} className={cn("group relative grid size-[42px] place-items-center rounded-md border border-transparent transition-all duration-150 hover:-translate-y-px hover:opacity-80", t.muted, area === "agents" && activeAgent === agent.id && cn(t.surface, t.ink, t.lineStrong, t.shadowSmall))} key={agent.id} onClick={() => selectAgent(agent.id)} title={agent.name} type="button">
            <BrandAgentIcon agentId={agent.id} className="size-[18px]" />
            <span className={cn("absolute bottom-1.5 right-1.5 size-1.5 rounded-full border-2", theme === "paper" ? "border-[#FBFCFA]" : "border-[#181A17]", agent.status === "Ready" ? "bg-[#74BF8F]" : "bg-[#6E7669]")} />
          </button>)}
        </div>
        <div className={cn("my-2 h-px w-8", theme === "paper" ? "bg-[#E0E4DC]" : "bg-[#30352D]")} />
        <button aria-label="Flows" aria-pressed={area === "flows"} className={cn("grid size-9 place-items-center rounded-md transition-colors hover:opacity-80", t.muted, area === "flows" && cn(t.surface, t.ink, t.shadowSmall))} onClick={() => setArea("flows")} title="Flows" type="button"><Workflow className="size-3.5" /></button>
        <div className="flex-1" />
        <button aria-label="切换主题" className={cn("grid size-9 place-items-center rounded-md transition-all hover:-translate-y-px hover:opacity-80", t.muted)} onClick={() => setTheme((current) => current === "paper" ? "carbon" : "paper")} title={theme === "paper" ? "Carbon Vermilion" : "Paper Lime"} type="button"><Sun className="size-3.5" /></button>
        <button aria-label="设置" className={cn("grid size-9 place-items-center rounded-md transition-colors hover:opacity-80", t.muted)} onClick={() => notify("设置将在确认设计后接入")} title="设置" type="button"><Settings2 className="size-3.5" /></button>
      </aside>

      <aside className={cn("flex min-h-0 min-w-0 flex-col border-r", t.sidebar, t.line)}>
        <header className="flex items-start justify-between gap-3 px-5 pb-4 pt-6">
          <div><p className={cn("mb-1 text-[10px] font-semibold uppercase tracking-[0.1em]", t.muted)}>Agent profile</p><h1 className={cn("text-lg font-semibold tracking-[-0.035em]", t.ink)}>{area === "agents" ? activeProfile.name : "Flows"}</h1><p className={cn("mt-1.5 flex items-center gap-1.5 text-[11px]", t.muted)}><Circle className={cn("size-1.5 fill-current", activeProfile.status === "Ready" ? t.success : t.faint)} />{area === "agents" ? `${activeProfile.status} · ${sessionSets[activeAgent]?.length ?? 0} sessions` : "Published definitions"}</p></div>
          <Button aria-label="新建 Session" className={cn("size-8 border px-0 hover:-translate-y-px hover:opacity-80", t.surface, t.ink, t.lineStrong)} onClick={() => { setActiveSession("New Session"); notify(`已为 ${activeProfile.name} 创建新 Session`); }} size="icon" variant="outline"><Plus className="size-4" /></Button>
        </header>
        {area === "agents" ? <>
          <div className="flex gap-2 px-4 pb-3"><label className={cn("flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-md border px-2.5", t.surface, t.line)}><Search className={cn("size-3.5", t.muted)} /><input aria-label="搜索 Session" className={cn("min-w-0 flex-1 bg-transparent text-xs outline-none", t.ink)} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Session" value={query} /></label><Button aria-label="筛选 Session" className={cn("size-[34px] px-0 hover:opacity-80", t.surface, t.muted, t.line)} onClick={() => notify("Session 筛选")} size="icon" variant="outline"><Layers3 className="size-3.5" /></Button></div>
          <div className="min-h-0 flex-1 overflow-auto px-2.5 pb-4">
            <div className={cn("px-2.5 py-2 text-[10px] font-semibold uppercase tracking-[0.1em]", t.faint)}><span>Sessions</span><span className="float-right font-mono">{filteredSessions.length}</span></div>
            {filteredSessions.map((session, index) => <button className={cn("relative grid w-full gap-1 rounded-md border border-transparent px-3 py-2.5 text-left transition-colors hover:opacity-80", t.ink, activeSession === session && cn(t.surface, t.line, t.shadowSmall))} key={session} onClick={() => { setActiveSession(session); notify(`已切换到 ${session}`); }} type="button"><span className="truncate pr-3 text-xs font-semibold">{session}</span><span className={cn("flex items-center gap-1.5 text-[10px]", t.muted)}>{index === 0 && <Pin className={cn("size-3", t.warning)} />}<span>{index === 0 ? "Running" : "Ready"}</span><span>·</span><span className="font-mono">{index === 0 ? "now" : `${index}h`}</span></span>{activeSession === session && <span className={cn("absolute right-2.5 top-3.5 size-1.5 rounded-full", t.accent)} />}</button>)}
            {!filteredSessions.length && <div className={cn("px-3 py-8 text-center text-xs", t.muted)}>没有匹配的 Session</div>}
          </div>
          <footer className={cn("flex items-center justify-between border-t px-4 py-3 text-[10px]", t.line, t.muted)}><Button className={cn("h-auto p-0 text-[10px] hover:opacity-80", t.muted)} onClick={() => notify("已归档 Session")} size="sm" variant="ghost">已归档</Button><span className="font-mono">{sessionSets[activeAgent]?.length ?? 0} active</span></footer>
        </> : <div className="min-h-0 flex-1 overflow-auto px-2.5 pb-4"><div className={cn("px-2.5 py-2 text-[10px] font-semibold uppercase tracking-[0.1em]", t.faint)}>Published</div>{flowNames.map((name, index) => <button className={cn("flex w-full items-center gap-2 rounded-md border border-transparent px-3 py-2.5 text-left text-xs transition-colors hover:opacity-80", t.ink)} key={name} onClick={() => notify(`Flow · ${name}`)} type="button"><Workflow className={cn("size-3.5", t.muted)} /><span className="min-w-0 flex-1 truncate">{name}</span><span className={cn("font-mono text-[10px]", t.faint)}>v1.{index + 1}</span></button>)}</div>}
      </aside>

      <main className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden", t.canvas)}>
        <header className={cn("flex min-h-[72px] items-center justify-between gap-5 border-b px-8 py-4", t.line)}>
          <div className="flex min-w-0 items-center gap-3"><span className={cn("grid size-7 place-items-center rounded-md border", t.surface, t.ink, t.lineStrong)}><BrandAgentIcon agentId={activeAgent} className="size-3.5" /></span><div className="min-w-0"><h2 className={cn("truncate text-sm font-semibold tracking-[-0.02em]", t.ink)}>{activeSession}</h2><p className={cn("mt-0.5 text-[11px]", t.muted)}>{activeProfile.name} · CodeBridge</p></div></div>
          <div className={cn("flex items-center gap-2 text-[11px]", t.muted)}><span className={cn("size-1.5 rounded-full", t.accent)} /><span>Running</span><code className={cn("rounded border px-1.5 py-0.5 font-mono text-[10px]", t.surfaceSoft, t.inkSoft, t.line)}>run_7a31</code><Button aria-label="更多操作" className={cn("size-8 px-0 hover:opacity-80", t.muted)} onClick={() => notify("Session actions")} size="icon" variant="ghost"><MoreHorizontal className="size-4" /></Button></div>
        </header>

        <section className="min-h-0 flex-1 overflow-auto px-8 pt-7" aria-label="Session conversation"><div className="mx-auto w-full max-w-[880px] pb-6">
          <div className={cn("mb-7 flex items-center justify-between gap-3 border-b py-2 text-[11px]", t.line, t.muted)}><div className="flex items-center gap-2"><span className={cn("inline-flex items-center gap-1.5 rounded px-2 py-1 text-[10px] font-semibold", t.accentSoft, t.inkSoft)}><Circle className="size-1.5 fill-current" />Run active</span><span>Agent is working through the current plan</span></div><code className={cn("font-mono text-[10px]", t.faint)}>workspace / CodeBridge</code></div>
          <Message role="user" theme={theme}>分析当前 Session 切换链路，并确认下一步需要哪些上下文。</Message>
          <div className="mb-7 grid gap-2.5"><span className={cn("text-[10px] font-semibold uppercase tracking-[0.08em]", t.muted)}>{activeProfile.name} · working</span><div className={cn("max-w-[760px] text-sm leading-7", t.inkSoft)}><p className="mb-3">我会先检查 Session、事件、资源加载和 Provider 恢复四段链路，再根据当前目录和权限判断下一步。</p><p>入口追踪已完成，正在验证 Provider 侧的会话集合。</p></div><PlanCard theme={theme} /></div>
          <div className="mb-4"><ToolCard theme={theme} /></div>
          <div className="mb-4"><DiffCard theme={theme} /></div>
          <ApprovalCard theme={theme} state={approval} onApprove={() => { setApproval("approved"); notify("Approval recorded"); }} onDeny={() => { setApproval("denied"); notify("Run paused"); }} />
        </div></section>

        <footer className="px-8 pb-5 pt-3"><div className={cn("mx-auto w-full max-w-[880px] rounded-xl border", t.surface, t.lineStrong, t.shadow)}><div className="flex items-center gap-1.5 px-3 pt-2.5"><ContextChip theme={theme} label="Auto" /><ContextChip theme={theme} label="Agent default" /><ContextChip theme={theme} label="Workspace" /><ContextChip theme={theme} label="Flow · Automatic" /><span className="flex-1" /><span className={cn("hidden text-[10px] sm:inline", t.faint)}>⌘ ↵ to send</span></div><Textarea aria-label="输入目标" className={cn("min-h-[70px] resize-none border-0 bg-transparent px-3.5 py-3 text-sm shadow-none focus:border-0 focus:ring-0", t.ink)} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); sendMessage(); } }} placeholder="输入目标，或继续调整当前工作…" value={draft} /><div className="flex items-center justify-between gap-3 px-3 pb-2.5"><div className="flex items-center gap-1"><Button aria-label="添加文件" className={cn("size-7 px-0 hover:opacity-80", t.muted)} onClick={() => notify("Attach files")} size="icon" variant="ghost"><Paperclip className="size-3.5" /></Button><Button aria-label="添加上下文" className={cn("size-7 px-0 text-xs hover:opacity-80", t.muted)} onClick={() => notify("Add context")} size="icon" variant="ghost"><span>@</span></Button><Button aria-label="Agent commands" className={cn("size-7 px-0 text-xs hover:opacity-80", t.muted)} onClick={() => notify("Agent commands")} size="icon" variant="ghost"><span>/</span></Button></div><Button aria-label="发送" className={cn("size-8 px-0 hover:opacity-80", t.accent, t.accentText)} disabled={!draft.trim()} onClick={sendMessage} size="icon"><Send className="size-4" /></Button></div></div></footer>
      </main>
      {notice && <div className={cn("fixed bottom-6 right-6 rounded-md border px-3 py-2 text-xs", t.surface, t.ink, t.lineStrong, t.shadow)} role="status">{notice}</div>}
    </div>
  );
}

function ContextChip({ label, theme }: { label: string; theme: Theme }) {
  const t = themes[theme];
  return <button className={cn("inline-flex min-h-6 items-center gap-1.5 rounded border px-2 text-[10px] transition-opacity hover:opacity-80", t.surfaceSoft, t.muted, t.line)} type="button"><span className={cn("font-semibold", t.inkSoft)}>{label}</span></button>;
}

function Message({ role, children, theme }: { role: "user" | "assistant"; children: ReactNode; theme: Theme }) {
  const t = themes[theme];
  return <article className={cn("mb-7 grid gap-2", role === "user" && "justify-items-end")}><span className={cn("text-[10px] font-semibold uppercase tracking-[0.08em]", t.muted)}>{role === "user" ? "You · just now" : "Agent"}</span><div className={cn("max-w-[72%] rounded-xl px-3.5 py-3 text-sm leading-6", role === "user" ? cn(t.ink, t.accentSoft) : t.inkSoft)}>{children}</div></article>;
}

function PlanCard({ theme }: { theme: Theme }) {
  const t = themes[theme];
  return <section className={cn("max-w-[760px] rounded-lg border", t.surface, t.line, t.shadowSmall)}><div className={cn("flex items-center justify-between gap-3 border-b px-3.5 py-3", t.line)}><span className={cn("flex items-center gap-2 text-[11px] font-semibold", t.ink)}><Check className={cn("size-3.5", t.muted)} />Plan</span><span className={cn("font-mono text-[10px]", t.muted)}>2 / 3</span></div><ol className={cn("grid gap-2 px-3.5 py-3.5 text-xs", t.muted)}><li className={cn("flex items-center gap-2", t.inkSoft)}><Check className={cn("size-3.5", t.success)} />Trace the Session switch path</li><li className={cn("flex items-center gap-2", t.inkSoft)}><Check className={cn("size-3.5", t.success)} />Measure Provider resource loading</li><li className={cn("flex items-center gap-2", t.ink)}><Circle className={cn("size-3.5", t.warning)} />Compare Agent history sources</li></ol></section>;
}

function ToolCard({ theme }: { theme: Theme }) {
  const t = themes[theme];
  return <section className={cn("max-w-[760px] rounded-lg border", t.surface, t.line, t.shadowSmall)}><details><summary className={cn("flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-3 text-xs", t.muted)}><Code2 className="size-3.5" /><span className={cn("min-w-0 flex-1 truncate font-semibold", t.ink)}>Read · apps/bridge/src/session-api.ts</span><span className={cn("text-[10px]", t.success)}>Completed</span><ChevronDown className="size-3.5" /></summary><div className={cn("grid gap-2.5 border-t px-3.5 py-3", t.line)}><pre className={cn("max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-6", t.muted)}>{"GET /v1/sessions/:id\nGET /v1/sessions/:id/config-options\nGET /v1/sessions/:id/events"}</pre></div></details></section>;
}

function DiffCard({ theme }: { theme: Theme }) {
  const t = themes[theme];
  return <section className={cn("max-w-[760px] rounded-lg border", t.surface, t.line, t.shadowSmall)}><div className={cn("flex items-center justify-between gap-3 border-b px-3.5 py-3", t.line)}><span className={cn("flex items-center gap-2 text-[11px] font-semibold", t.ink)}><FileCode2 className="size-3.5" />Proposed change</span><span className={cn("font-mono text-[10px]", t.muted)}>2 files</span></div><div className="flex gap-1 px-2.5 pt-2"><Button className={cn("h-7 px-2 text-[10px]", t.surfaceSoft, t.ink)} size="sm" variant="ghost">Diff</Button><Button className={cn("h-7 px-2 text-[10px]", t.muted)} size="sm" variant="ghost">Files</Button></div><div className={cn("grid overflow-auto py-2 font-mono text-[10px] leading-6", t.surfaceTint)}><code className={cn("px-3.5", t.danger)}>- await loadSessionResources(session)</code><code className={cn("px-3.5", t.success)}>+ void loadSessionResources(session)</code><code className={cn("px-3.5", t.success)}>+ cache options by Agent and workspace</code></div></section>;
}

function ApprovalCard({ theme, state, onApprove, onDeny }: { theme: Theme; state: "pending" | "approved" | "denied"; onApprove: () => void; onDeny: () => void }) {
  const t = themes[theme];
  if (state === "approved") return <section className={cn("max-w-[760px] rounded-lg border p-3.5", t.surface, t.line, t.shadowSmall)}><div className={cn("flex items-center gap-2 text-xs font-semibold", t.success)}><Check className="size-3.5" />Approved<span className={cn("ml-auto font-mono text-[10px] font-normal", t.muted)}>scoped to this Run</span></div></section>;
  if (state === "denied") return <section className={cn("max-w-[760px] rounded-lg border p-3.5", t.surface, t.line, t.shadowSmall)}><div className={cn("flex items-center gap-2 text-xs font-semibold", t.danger)}><X className="size-3.5" />Run paused<span className={cn("ml-auto font-mono text-[10px] font-normal", t.muted)}>approval denied</span></div></section>;
  return <section className={cn("max-w-[760px] rounded-lg border", t.surface, t.lineStrong, t.shadowSmall)}><div className={cn("flex items-center justify-between gap-3 border-b px-3.5 py-3", t.line)}><span className={cn("flex items-center gap-2 text-[11px] font-semibold", t.ink)}><ShieldAlert className={cn("size-3.5", t.warning)} />Needs approval</span><span className={cn("font-mono text-[10px]", t.muted)}>before next step</span></div><div className={cn("px-3.5 pb-1 pt-3 text-xs leading-5", t.inkSoft)}>Agent wants to apply the verified change to the current feature branch. No production or main branch mutation is included.<span className={cn("mt-2 flex items-center gap-1.5 text-[10px] font-semibold", t.warning)}><Circle className="size-1.5 fill-current" />Branch write · reviewable</span></div><div className="flex gap-2 px-3.5 pb-3.5 pt-2"><Button className={cn("h-8 text-xs", t.accent, t.accentText)} onClick={onApprove} size="sm">Allow once</Button><Button className={cn("h-8 text-xs", t.surface, t.ink, t.lineStrong)} onClick={onDeny} size="sm" variant="outline">Deny</Button></div></section>;
}
