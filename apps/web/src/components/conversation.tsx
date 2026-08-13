import { isValidElement, memo, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { Check, ChevronDown, Circle, FileText, LoaderCircle, ShieldAlert, Terminal, Wrench, X } from "lucide-react";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { Button } from "@/components/ui/button";
import { describeTool, type ApprovalProjection, type ConversationProjection, type ToolProjection, type WorkProjection } from "@/lib/events";
import type { ApprovalRecord } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatElapsed, formatValue, type Theme } from "@/components/workbench-shared";

export function ProjectionItem({ approvals, cwd, item, onApproval, theme }: { approvals: ApprovalRecord[]; cwd: string | null; item: ConversationProjection; onApproval: (item: ApprovalProjection, approve: boolean) => Promise<void>; theme: Theme }) {
  if (item.kind === "user") return <article className="grid justify-items-end gap-2"><span className={cn("text-xs font-medium uppercase tracking-[0.08em]", "text-muted")}>你</span><div className={cn("max-w-[72%] rounded-xl px-3.5 py-3 text-sm leading-6", "text-ink", "bg-accent-soft")}>{item.content}</div></article>;
  if (item.kind === "assistant") return <article className="grid max-w-[780px] gap-2"><span className={cn("text-xs font-medium tracking-[0.08em]", "text-muted")}>Agent</span><Markdown content={item.content} theme={theme} /></article>;
  if (item.kind === "work") return <WorkActivity cwd={cwd} item={item} />;
  if (item.kind === "plan") return <section className={cn("max-w-[760px] rounded-lg border", "bg-surface", "border-line", "shadow-card")}><div className={cn("flex items-center justify-between gap-3 border-b px-3.5 py-3", "border-line")}><span className={cn("flex items-center gap-2 text-xs font-semibold", "text-ink")}><Check className={cn("size-3.5", "text-muted")} />计划</span><span className={cn("font-mono text-xs", "text-muted")}>{item.entries.filter((entry) => entry.status === "completed").length} / {item.entries.length}</span></div><ol className="grid gap-2 px-3.5 py-3.5">{item.entries.map((entry, index) => <li className={cn("flex items-start gap-2 text-xs", entry.status === "completed" ? "text-muted" : "text-ink-soft")} key={`${entry.content}-${index}`}>{entry.status === "completed" ? <Check className={cn("mt-0.5 size-3.5 shrink-0", "text-success")} /> : <Circle className={cn("mt-0.5 size-3.5 shrink-0", entry.status === "in_progress" ? "text-warning" : "text-faint")} />}<span>{entry.content}</span></li>)}</ol></section>;
  if (item.kind === "approval") {
    const approval = approvals.find((record) => record.id === item.requestId) ?? approvals.find((record) => record.run_id === item.runId);
    return <ApprovalCard approval={approval} item={item} onApproval={onApproval} />;
  }
  if (item.kind === "error") return <section className={cn("flex max-w-[760px] items-start gap-2 rounded-lg border p-3.5 text-xs", "bg-danger-soft", "text-danger", "border-line-strong")}><X className="mt-0.5 size-3.5 shrink-0" /><div><p className="font-semibold">{item.fatal ? "Run 失败" : "Agent 错误"}</p><p className="mt-1 leading-5">{item.content}</p></div></section>;
}

function LiveElapsed({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000));
  return <span className={cn("font-mono tabular-nums", "text-control-accent")}>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>;
}

function WorkActivity({ cwd, item }: { cwd: string | null; item: WorkProjection }) {
  const tools = item.entries.filter((entry): entry is ToolProjection => entry.kind === "tool");
  const running = item.running;
  return <details open={running || undefined} className={cn("group w-full max-w-[780px] border-t", "border-line")}>
    <summary className={cn("flex cursor-pointer list-none items-center gap-2 py-3 text-xs", "text-muted")}>
      {running && <LoaderCircle className={cn("size-3.5 animate-spin", "text-control-accent")} />}
      <span className={cn("font-medium", "text-ink-soft")}>{running ? "工作中" : `耗时 ${formatElapsed(item.startedAt, item.endedAt)}`}</span>
      {running && <LiveElapsed startedAt={item.startedAt} />}
      {tools.length > 0 && <span>{tools.length} 个工具调用</span>}
      <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
    </summary>
    <div className="relative grid w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)] gap-2 overflow-hidden pb-4">
      <span aria-hidden="true" className={cn("absolute bottom-4 left-[10px] top-1 w-px", "bg-line")} />
      {item.entries.map((entry, index) => {
        const dot = entry.kind === "tool"
          ? entry.status === "failed" ? "bg-danger" : entry.status === "completed" ? "bg-success" : cn("bg-warning", "animate-pulse")
          : entry.kind === "thought" ? "bg-warning" : "bg-faint";
        return <div className="grid w-full min-w-0 max-w-full grid-cols-[21px_minmax(0,1fr)] gap-2 overflow-hidden px-1 py-1" key={entry.kind === "tool" ? entry.id : `${entry.kind}-${index}`}>
          <span className={cn("relative z-10 ml-[3px] mt-1.5 size-2 rounded-full border-2", "border-canvas", dot)} />
          <div className="min-w-0">{entry.kind === "tool"
            ? <ToolActivity cwd={cwd} tool={entry} />
            : <><p className={cn("mb-1 text-xs font-medium uppercase tracking-[0.08em]", entry.kind === "thought" ? "text-warning" : "text-muted")}>{entry.kind === "thought" ? "推理" : "进度"}</p><WorkMarkdown content={entry.content} /></>}
          </div>
        </div>;
      })}
    </div>
  </details>;
}

function WorkMarkdown({ content }: { content: string }) {
  return <div className={cn("max-w-full break-words text-xs font-normal leading-5", "text-ink-soft")}><ReactMarkdown components={{
    code: ({ children }) => <code className={cn("rounded px-1 py-0.5 font-mono text-[0.92em]", "bg-surface-soft", "text-ink")}>{children}</code>,
    h1: ({ children }) => <h1 className="mb-1 text-xs font-medium leading-5">{children}</h1>,
    h2: ({ children }) => <h2 className="mb-1 text-xs font-medium leading-5">{children}</h2>,
    h3: ({ children }) => <h3 className="mb-1 text-xs font-medium leading-5">{children}</h3>,
    ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-4">{children}</ol>,
    p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-4">{children}</ul>,
  }} remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>;
}

function editPair(input: unknown): { oldText: string; newText: string } | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const oldText = typeof record.old_string === "string" ? record.old_string : typeof record.oldText === "string" ? record.oldText : null;
  const newText = typeof record.new_string === "string" ? record.new_string : typeof record.newText === "string" ? record.newText : null;
  return oldText !== null && newText !== null ? { oldText, newText } : null;
}

function EditDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const removed = oldText.split("\n");
  const added = newText.split("\n");
  return <div className={cn("overflow-hidden rounded-md border font-mono text-xs leading-5", "border-line")}>
    {removed.map((line, index) => <div className={cn("flex gap-2 px-2.5", "bg-danger-soft", "text-danger")} key={`r-${index}`}><span aria-hidden="true" className="shrink-0 select-none">−</span><span className="min-w-0 whitespace-pre-wrap break-all">{line || " "}</span></div>)}
    {added.map((line, index) => <div className={cn("flex gap-2 px-2.5", "bg-success-soft", "text-success")} key={`a-${index}`}><span aria-hidden="true" className="shrink-0 select-none">+</span><span className="min-w-0 whitespace-pre-wrap break-all">{line || " "}</span></div>)}
  </div>;
}

function ToolActivity({ cwd, tool }: { cwd: string | null; tool: ToolProjection }) {
  const presentation = describeTool(tool, cwd);
  const ToolIcon = presentation.category === "command" ? Terminal : presentation.category === "file" ? FileText : Wrench;
  const status = tool.status === "failed" ? "失败" : tool.status === "completed" ? "完成" : "运行中";
  const diff = presentation.category === "file" ? editPair(tool.input) : null;
  return <details className={cn("group/tool rounded-md border", "bg-surface-tint", "border-line")}>
    <summary className={cn("flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs", "text-muted")}>
      <span className="grid size-4 shrink-0 place-items-center"><ToolIcon className="size-3.5" /></span>
      <span className={cn("shrink-0 font-medium", "text-ink-soft")}>{presentation.label}</span>
      {presentation.target && <span className={cn("min-w-0 flex-1 truncate font-mono text-xs", "text-muted")} title={presentation.target}>{presentation.target}</span>}
      <span className={cn("text-xs", tool.status === "failed" ? "text-danger" : tool.status === "completed" ? "text-success" : "text-warning")}>{status}</span>
      <ChevronDown className="size-3.5 shrink-0 transition-transform group-open/tool:rotate-180" />
    </summary>
    <div className={cn("grid gap-3 border-t px-3 py-3", "border-line")}>
      {presentation.target && presentation.category === "file" && <div className={cn("flex items-start gap-2 font-mono text-xs leading-5", "text-ink-soft")}><FileText className="mt-0.5 size-3.5 shrink-0" /><span className="break-all">{presentation.target}</span></div>}
      {diff && <div><p className={cn("mb-1.5 text-xs font-medium uppercase tracking-[0.08em]", "text-muted")}>变更</p><EditDiff newText={diff.newText} oldText={diff.oldText} /></div>}
      {tool.input !== undefined && !diff && <div><p className={cn("mb-1.5 text-xs font-medium uppercase tracking-[0.08em]", "text-muted")}>输入</p><pre className={cn("max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5", "text-ink-soft")}>{formatValue(tool.input)}</pre></div>}
      {tool.output !== undefined && <div><p className={cn("mb-1.5 text-xs font-medium uppercase tracking-[0.08em]", "text-muted")}>输出</p><pre className={cn("max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5", "text-ink-soft")}>{formatValue(tool.output)}</pre></div>}
    </div>
  </details>;
}

function ApprovalCard({ approval, item, onApproval }: { approval: ApprovalRecord | undefined; item: ApprovalProjection; onApproval: (item: ApprovalProjection, approve: boolean) => Promise<void> }) {
  if (approval && approval.status !== "requested") return <section className={cn("max-w-[760px] rounded-lg border p-3.5", "bg-surface", "border-line", "shadow-card")}><div className={cn("flex items-center gap-2 text-xs font-semibold", approval.status === "granted" ? "text-success" : "text-danger")}>{approval.status === "granted" ? <Check className="size-3.5" /> : <X className="size-3.5" />}{approval.status === "granted" ? "已授权" : "已暂停 Run"}<span className={cn("ml-auto font-mono text-xs font-normal", "text-muted")}>{approval.status}</span></div></section>;
  return <section className={cn("relative max-w-[760px] overflow-hidden rounded-lg border", "bg-surface", "border-line-strong", "shadow-card")}><svg aria-hidden="true" className={cn("pointer-events-none absolute inset-0 size-full", "text-warning")}><rect className={cn("h-[calc(100%-2px)] w-[calc(100%-2px)]", "motion-safe:animate-march")} fill="none" rx="7" stroke="currentColor" strokeDasharray="4 4" strokeWidth="1.5" x="1" y="1" /></svg><div className={cn("flex items-center justify-between gap-3 border-b px-3.5 py-3", "border-line")}><span className={cn("flex items-center gap-2 text-xs font-semibold", "text-ink")}><ShieldAlert className={cn("size-3.5", "text-warning")} />需要审批</span><span className={cn("font-mono text-xs", "text-muted")}>仅本次 Run 有效</span></div><div className={cn("px-3.5 pb-1 pt-3 text-xs leading-5", "text-ink-soft")}>{item.title}</div><div className="flex gap-2 px-3.5 pb-3.5 pt-2"><Button className={cn("h-8 text-xs", "bg-accent", "text-accent-ink")} disabled={!approval} onClick={() => void onApproval(item, true)} size="sm">允许一次</Button><Button className={cn("h-8 border text-xs", "bg-surface", "text-ink", "border-line-strong")} disabled={!approval} onClick={() => void onApproval(item, false)} size="sm" variant="outline">拒绝</Button></div></section>;
}

const Markdown = memo(function Markdown({ content, theme }: { content: string; theme: Theme }) {
  return <div className={cn("conversation-body max-w-[780px] text-sm font-normal leading-7 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-2", "text-ink-soft")}><ReactMarkdown components={{
    a: ({ children, href }) => <a className={cn("underline underline-offset-4", "text-ink")} href={href} rel="noreferrer" target="_blank">{children}</a>,
    blockquote: ({ children }) => <blockquote className={cn("my-3 border-l-2 pl-3", "border-line-strong", "text-muted")}>{children}</blockquote>,
    code: ({ children, className }) => {
      if (className?.includes("language-mermaid")) return <MermaidDiagram source={String(children).trimEnd()} theme={theme} />;
      if (className && /language-\w+/.test(className)) {
        return <code className={cn("font-mono text-[0.92em]", "text-ink")}>{highlightCode(String(children))}</code>;
      }
      return <code className={cn("rounded px-1 py-0.5 font-mono text-[0.9em]", "bg-surface-soft", "text-ink")}>{children}</code>;
    },
    h1: ({ children }) => <h1 className={cn("mb-3 mt-5 text-lg font-medium", "text-ink")}>{children}</h1>,
    h2: ({ children }) => <h2 className={cn("mb-2 mt-5 text-base font-medium", "text-ink")}>{children}</h2>,
    h3: ({ children }) => <h3 className={cn("mb-2 mt-4 text-sm font-medium", "text-ink")}>{children}</h3>,
    ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>,
    p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
    pre: ({ children }) => isValidElement(children) && children.type === MermaidDiagram
      ? children
      : <pre className={cn("my-3 max-w-full overflow-auto rounded-lg border p-3 font-mono text-xs leading-6", "bg-surface-tint", "border-line")}>{children}</pre>,
    table: ({ children }) => <div className="my-3 overflow-auto"><table className={cn("w-full border-collapse text-left text-xs [&_td]:border-b [&_td]:p-2 [&_th]:border-b [&_th]:p-2", "border-line")}>{children}</table></div>,
    ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-5">{children}</ul>,
  }} rehypePlugins={[rehypeKatex]} remarkPlugins={[remarkGfm, remarkMath]}>{content}</ReactMarkdown></div>;
});

const CODE_KEYWORDS = new Set("await async break case catch class const continue def delete do elif else enum except extends finally fn for from func go if impl import in instanceof interface lambda let match mod mut new None of package pass print protected pub public raise range readonly ref return self Self select static struct super switch this throw try True False type typeof undefined use var void where while with yield null true false".split(" "));
const CODE_TOKEN_RE = /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_][A-Za-z0-9_]*)\b/g;

/** Minimal regex highlighter: strings, comments, numbers, keywords — semantic token colors only. */
function highlightCode(source: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of source.matchAll(CODE_TOKEN_RE)) {
    if (match.index > last) nodes.push(source.slice(last, match.index));
    const [text, string, comment, number, word] = match;
    const cls = string ? "text-warning" : comment ? "text-faint" : number ? "text-success" : word && CODE_KEYWORDS.has(word) ? "text-control-accent" : null;
    nodes.push(cls ? <span className={cls} key={key++}>{text}</span> : text);
    last = match.index + text.length;
  }
  if (last < source.length) nodes.push(source.slice(last));
  return nodes;
}

export function LoadingConversation() {
  return <div className="grid gap-5" aria-label="正在加载 Session"><div className={cn("skeleton-pixel h-3 w-24 animate-pulse rounded", "bg-surface-soft")} /><div className={cn("skeleton-pixel h-16 w-2/3 animate-pulse rounded-lg", "bg-surface-soft")} /><div className={cn("skeleton-pixel ml-auto h-12 w-1/2 animate-pulse rounded-lg", "bg-surface-soft")} /></div>;
}

