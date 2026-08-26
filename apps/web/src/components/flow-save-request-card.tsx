import {
  AlertTriangle,
  Check,
  CircleOff,
  FileClock,
  LoaderCircle,
  RotateCcw,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TimelineBlockView } from "@/lib/types";
import { cn } from "@/lib/utils";

export type FlowSaveRequestActionState = {
  phase: "confirm" | "dismiss" | null;
  error: string | null;
  retry: "confirm" | "dismiss" | null;
};

export function FlowSaveRequestCard(props: {
  block: TimelineBlockView;
  actionState: FlowSaveRequestActionState | null;
  onConfirm?: (requestId: string) => void;
  onDismiss?: (requestId: string) => void;
  onOpenCandidate?: (flowId: string) => void;
}) {
  const { block } = props;
  const requestId = stringMetadata(block.metadata, "request_id");
  const sourceSummary = stringMetadata(block.metadata, "source_title")
    ?? stringMetadata(block.metadata, "source_run_id")
    ?? "已选择的 Agent 回复";
  const userMessage = stringMetadata(block.metadata, "user_message");
  const imported = block.metadata.source_imported === true;
  const busy = props.actionState?.phase != null;

  if (block.status === "completed") {
    const flowId = stringMetadata(block.metadata, "flow_id");
    const name = stringMetadata(block.metadata, "name_hint") ?? flowId ?? "Candidate";
    return <CardShell requestId={requestId} status="completed">
      <Check className="mt-0.5 size-4 shrink-0 text-success" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">已生成 Candidate</p>
        <p className="mt-1 [overflow-wrap:anywhere] font-mono text-xs text-muted">{name}</p>
      </div>
      <Button
        className="shrink-0"
        disabled={!flowId || !props.onOpenCandidate}
        onClick={() => flowId && props.onOpenCandidate?.(flowId)}
        size="sm"
        variant="outline"
      >打开并预演</Button>
    </CardShell>;
  }

  if (block.status === "dismissed") {
    return <CardShell requestId={requestId} status="dismissed">
      <CircleOff className="mt-0.5 size-4 shrink-0 text-muted" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">已忽略</p>
        <p className="mt-1 text-xs text-muted">这次请求不会生成 Candidate。</p>
      </div>
    </CardShell>;
  }

  if (block.status === "failed") {
    const code = stringMetadata(block.metadata, "error_code")
      ?? stringMetadata(block.metadata, "code")
      ?? "flow_save_failed";
    return <CardShell requestId={requestId} status="failed">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">无法生成 Candidate</p>
        <p className="mt-1 [overflow-wrap:anywhere] font-mono text-xs text-danger">{code}</p>
        <p className="mt-1 text-xs text-muted">从 Turn 菜单重新选择来源。</p>
      </div>
    </CardShell>;
  }

  const confirming = props.actionState?.phase === "confirm";
  const dismissing = props.actionState?.phase === "dismiss";
  return <CardShell requestId={requestId} status="pending">
    <FileClock className="mt-0.5 size-4 shrink-0 text-control-accent" />
    <div className="grid min-w-0 flex-1 gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">存为 Flow？</p>
        <p className="mt-1 [overflow-wrap:anywhere] text-xs leading-5 text-ink-soft">
          <span className="text-muted">来源：</span>{sourceSummary}
        </p>
        {userMessage && userMessage !== sourceSummary && <p className="mt-1 [overflow-wrap:anywhere] text-xs leading-5 text-muted">
          你的请求：{userMessage}
        </p>}
        {imported && <p className="mt-2 flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning-soft px-2.5 py-2 text-xs leading-5 text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>来源为导入历史，请确认其步骤仍然适用。</span>
        </p>}
        <p className="mt-2 text-xs leading-5 text-muted">保存后将生成 Candidate，需要预演和审查后才能发布。</p>
        {props.actionState?.error && <p className="mt-2 [overflow-wrap:anywhere] text-xs leading-5 text-danger" role="alert">
          {props.actionState.error}
        </p>}
      </div>
      <div className="flex min-w-0 flex-wrap gap-2">
        {props.actionState?.retry !== "dismiss" && <Button
          disabled={!requestId || busy || !props.onConfirm}
          onClick={() => requestId && props.onConfirm?.(requestId)}
          size="sm"
        >
          {confirming
            ? <><LoaderCircle className="size-3.5 animate-spin" />正在生成 Candidate</>
            : props.actionState?.retry === "confirm"
              ? <><RotateCcw className="size-3.5" />重试生成</>
              : <><Workflow className="size-3.5" />生成 Candidate</>}
        </Button>}
        {props.actionState?.retry !== "confirm" && <Button
          disabled={!requestId || busy || !props.onDismiss}
          onClick={() => requestId && props.onDismiss?.(requestId)}
          size="sm"
          variant="ghost"
        >{dismissing
            ? <><LoaderCircle className="size-3.5 animate-spin" />正在忽略</>
            : props.actionState?.retry === "dismiss"
              ? <><RotateCcw className="size-3.5" />重试忽略</>
              : "忽略"}</Button>}
      </div>
    </div>
  </CardShell>;
}

function CardShell(props: {
  children: React.ReactNode;
  requestId: string | null;
  status: "pending" | "completed" | "dismissed" | "failed";
}) {
  return <section
    aria-live="polite"
    className={cn(
      "flex w-full min-w-0 max-w-full items-start gap-3 rounded-xl border p-3.5 shadow-card md:max-w-[780px]",
      props.status === "completed"
        ? "border-success/30 bg-success-soft"
        : props.status === "failed"
          ? "border-danger/30 bg-danger-soft"
          : props.status === "dismissed"
            ? "border-line bg-surface-tint"
            : "border-line-strong bg-surface",
    )}
    data-flow-save-request-id={props.requestId ?? undefined}
    data-flow-save-request={props.status}
    tabIndex={-1}
  >{props.children}</section>;
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value ? value : null;
}
