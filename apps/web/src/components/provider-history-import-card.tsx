import { AlertTriangle, CheckCircle2, Download, History, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProviderHistoryImportResult, ProviderHistoryPreview } from "@/lib/types";

export type ProviderHistoryImportState =
  | { kind: "idle" }
  | { kind: "previewing"; sessionId: string }
  | { kind: "available"; sessionId: string; preview: ProviderHistoryPreview }
  | { kind: "importing"; sessionId: string; preview: ProviderHistoryPreview }
  | { kind: "imported"; sessionId: string; result: ProviderHistoryImportResult }
  | { kind: "empty"; sessionId: string }
  | {
      kind: "error";
      sessionId: string;
      code: string;
      message: string;
      retry: "preview" | "import" | null;
    };

type ErrorPresentation = Pick<
  Extract<ProviderHistoryImportState, { kind: "error" }>,
  "code" | "message" | "retry"
>;

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const candidate = error as { code?: unknown; error?: unknown };
  if (typeof candidate.code === "string" && candidate.code) return candidate.code;
  if (typeof candidate.error === "string" && candidate.error) return candidate.error;
  return "unknown";
}

export function providerHistoryErrorPresentation(
  error: unknown,
  phase: "preview" | "import",
): ErrorPresentation {
  const code = errorCode(error);
  switch (code) {
    case "confirmation_and_idempotency_key_required":
      return { code, message: "导入确认请求不完整，请刷新页面后重试。", retry: null };
    case "session_not_found":
      return { code, message: "Session 已不存在，请刷新 Session 列表。", retry: null };
    case "provider_session_not_bound":
      return { code, message: "当前 Session 未绑定 Provider 历史。", retry: null };
    case "provider_history_prefix_changed":
      return { code, message: "Provider 历史前缀已变化，无法安全自动合并。", retry: null };
    case "provider_history_cursor_conflict":
      return { code, message: "Provider 历史已发生变化，请重新检查后再次确认导入。", retry: "preview" };
    case "provider_history_unavailable":
      return { code, message: "暂时无法读取 Provider 历史。", retry: phase };
    case "runner_unavailable":
      return { code, message: "Runner 暂不可用，请恢复后重试。", retry: phase };
    default:
      return {
        code: "unknown",
        message: phase === "import"
          ? "导入结果未知，请使用同一次确认重试。"
          : "检查 Provider 历史失败，请重试。",
        retry: phase,
      };
  }
}

export function ProviderHistoryImportCard(props: {
  state: ProviderHistoryImportState;
  onImport?: () => void;
  onRetryPreview?: () => void;
  onRetryImport?: () => void;
}) {
  const { state } = props;
  if (state.kind === "idle") return null;

  if (state.kind === "previewing") {
    return <CardShell>
      <LoaderCircle className="size-4 animate-spin text-accent" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">正在检查历史…</p>
        <p className="mt-1 text-xs text-muted">正在读取 Provider Session，不会写入本地历史。</p>
      </div>
    </CardShell>;
  }

  if (state.kind === "available" || state.kind === "importing") {
    const importing = state.kind === "importing";
    return <CardShell>
      <History className="size-4 text-accent" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">
          发现 {state.preview.importableEvents} 条可导入历史记录
        </p>
        <p className="mt-1 text-xs text-muted">确认后才会写入当前 Session；Provider 原始记录不会被修改。</p>
      </div>
      <Button
        className="shrink-0"
        disabled={importing || !props.onImport}
        onClick={props.onImport}
        size="sm"
      >
        {importing
          ? <><LoaderCircle className="mr-1.5 size-3.5 animate-spin" />正在导入历史…</>
          : <><Download className="mr-1.5 size-3.5" />导入历史</>}
      </Button>
    </CardShell>;
  }

  if (state.kind === "imported") {
    return <CardShell tone="success">
      <CheckCircle2 className="size-4 text-success" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">已导入 {state.result.importedEvents} 条历史记录</p>
        <p className="mt-1 text-xs text-muted">已恢复 {state.result.importedTurns} 个 Turn，时间线已刷新。</p>
      </div>
    </CardShell>;
  }

  if (state.kind === "empty") {
    return <CardShell>
      <CheckCircle2 className="size-4 text-success" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">Provider 历史已同步</p>
        <p className="mt-1 text-xs text-muted">没有新的历史记录需要导入。</p>
      </div>
    </CardShell>;
  }

  const retryAction = state.retry === "preview"
    ? props.onRetryPreview
    : state.retry === "import"
      ? props.onRetryImport
      : undefined;
  return <CardShell tone="danger">
    <AlertTriangle className="size-4 text-danger" />
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium text-ink">无法加载 Provider 历史</p>
      <p className="mt-1 [overflow-wrap:anywhere] text-xs text-danger">{state.message}</p>
    </div>
    {state.retry && <Button
      className="shrink-0"
      disabled={!retryAction}
      onClick={retryAction}
      size="sm"
      variant="outline"
    >{state.retry === "preview" ? "重试检查" : "重试导入"}</Button>}
  </CardShell>;
}

function CardShell(props: {
  children: React.ReactNode;
  tone?: "neutral" | "success" | "danger";
}) {
  const border = props.tone === "success"
    ? "border-success/30 bg-success-soft"
    : props.tone === "danger"
      ? "border-danger/30 bg-danger-soft"
      : "border-line-strong bg-surface";
  return <section
    aria-live="polite"
    className={`flex min-w-0 items-start gap-3 rounded-xl border p-4 shadow-card ${border}`}
    data-provider-history
  >{props.children}</section>;
}
