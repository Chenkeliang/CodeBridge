import { AlertTriangle, FileClock, LoaderCircle, LocateFixed, RotateCcw, Workflow } from "lucide-react";
import type { FlowSaveRequestActionState } from "@/components/flow-save-request-card";
import { Button } from "@/components/ui/button";
import type { FlowSaveInboxRequest } from "@/lib/types";
import { cn } from "@/lib/utils";

export function FlowSaveInboxDetail(props: {
  request: FlowSaveInboxRequest;
  agentName: string;
  actionState: FlowSaveRequestActionState | null;
  onConfirm?: (requestId: string) => void;
  onDismiss?: (requestId: string) => void;
  onOpenSourceSession?: (sessionId: string) => void;
}) {
  const { request } = props;
  const title = request.name_hint || request.source_title || "未命名保存请求";
  const busy = props.actionState?.phase != null;
  const confirming = props.actionState?.phase === "confirm";
  const dismissing = props.actionState?.phase === "dismiss";

  return <article className={cn("mx-auto grid w-full max-w-[880px] min-w-0 gap-5 rounded-xl border p-5 shadow-card sm:p-6", "bg-surface", "border-line-strong")} data-flow-save-inbox-detail={request.request_id}>
    <header className="flex min-w-0 flex-wrap items-start gap-3">
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-md border", "bg-warning-soft", "text-warning", "border-warning/30")}><FileClock className="size-4" /></span>
      <div className="min-w-0 flex-1">
        <p className={cn("font-brand text-xs font-normal uppercase tracking-[0.1em]", "text-muted")}>待生成</p>
        <h2 className="mt-1 [overflow-wrap:anywhere] font-brand text-xl font-normal tracking-[-0.025em] text-ink">{title}</h2>
        <div className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          <span className="[overflow-wrap:anywhere]">Agent · {props.agentName}</span>
          <span className="[overflow-wrap:anywhere]">Session · {request.session_title || request.session_id}</span>
        </div>
      </div>
      <Button aria-label="定位来源 Session" className="shrink-0" disabled={!props.onOpenSourceSession} onClick={() => props.onOpenSourceSession?.(request.session_id)} size="sm" variant="outline"><LocateFixed className="size-3.5" />定位来源</Button>
    </header>

    <div className="grid min-w-0 gap-3 border-y border-line py-4 text-xs leading-5">
      <p className="[overflow-wrap:anywhere] text-ink-soft"><span className="text-muted">来源：</span>{request.source_title || request.source_run_id}</p>
      {request.user_message && <p className="[overflow-wrap:anywhere] text-ink-soft"><span className="text-muted">你的请求：</span>{request.user_message}</p>}
      {request.intent_summary && <p className="[overflow-wrap:anywhere] text-ink-soft"><span className="text-muted">意图摘要：</span>{request.intent_summary}</p>}
      {request.source_imported && <p className="flex min-w-0 items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-warning"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0 [overflow-wrap:anywhere]">来源为导入历史，请确认其步骤仍然适用。</span></p>}
    </div>

    {props.actionState?.error && <p className="[overflow-wrap:anywhere] text-xs leading-5 text-danger" role="alert">{props.actionState.error}</p>}
    <footer className="flex min-w-0 flex-wrap gap-2">
      {props.actionState?.retry !== "dismiss" && <Button disabled={busy || !props.onConfirm} onClick={() => props.onConfirm?.(request.request_id)} size="sm">
        {confirming
          ? <><LoaderCircle className="size-3.5 animate-spin" />正在生成 Candidate</>
          : props.actionState?.retry === "confirm"
            ? <><RotateCcw className="size-3.5" />重试生成</>
            : <><Workflow className="size-3.5" />生成 Candidate</>}
      </Button>}
      {props.actionState?.retry !== "confirm" && <Button disabled={busy || !props.onDismiss} onClick={() => props.onDismiss?.(request.request_id)} size="sm" variant="ghost">
        {dismissing
          ? <><LoaderCircle className="size-3.5 animate-spin" />正在忽略</>
          : props.actionState?.retry === "dismiss"
            ? <><RotateCcw className="size-3.5" />重试忽略</>
            : "忽略"}
      </Button>}
    </footer>
  </article>;
}
