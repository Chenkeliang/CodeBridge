import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { revisionTail } from "@/lib/revision-tail";
import type {
  FlowBatchDraft,
  FlowBatchDraftItem,
  FlowBatchSnapshot,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export function FlowBatchPanel(props: {
  draft?: FlowBatchDraft | null;
  batch?: FlowBatchSnapshot | null;
  busy?: boolean;
  error?: string | null;
  onSave?: (draft: FlowBatchDraft) => void;
  onConfirm?: (concurrency: number) => void;
  onCancelDraft?: () => void;
  onCancelBatch?: () => void;
  onRetryFailed?: () => void;
  onOpenRun?: (runId: string) => void;
  onClose?: () => void;
}) {
  const [items, setItems] = useState<FlowBatchDraftItem[]>(props.draft?.items ?? []);
  const [globalText, setGlobalText] = useState(() => pretty(props.draft?.global_inputs ?? {}));
  const [concurrency, setConcurrency] = useState(props.batch?.concurrency ?? 3);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    setItems(props.draft?.items ?? []);
    setGlobalText(pretty(props.draft?.global_inputs ?? {}));
    setParseError(null);
  }, [props.draft]);

  const blocking = useMemo(
    () => items.filter((item) => item.issues.some((issue) => issue.blocking)).length,
    [items],
  );
  const failed = props.batch?.items.filter((item) =>
    item.status === "failed" || item.status === "interrupted"
  ).length ?? 0;
  const draftDirty = Boolean(props.draft) && (
    globalText !== pretty(props.draft!.global_inputs)
    || JSON.stringify(items) !== JSON.stringify(props.draft!.items)
  );

  function save() {
    if (!props.draft) return;
    try {
      const globalInputs = parseObject(globalText);
      setParseError(null);
      props.onSave?.({ ...props.draft, global_inputs: globalInputs, items });
    } catch (error) {
      setParseError(error instanceof Error ? error.message : "参数不是有效 JSON");
    }
  }

  if (!props.draft && !props.batch) return null;
  const flowId = props.draft?.flow_id ?? props.batch!.flow_id;
  const revision = props.draft?.definition_revision ?? props.batch!.definition_revision;

  return <aside aria-label="Flow 批量执行" className="mb-5 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-panel">
    <header className="grid gap-3 border-b border-line bg-surface-tint px-4 py-4 md:grid-cols-[1fr_auto] md:items-start">
      <div className="min-w-0">
        <p className="font-brand text-[11px] uppercase tracking-[0.14em] text-muted">Flow batch control</p>
        <h2 className="mt-1 truncate font-brand text-lg font-medium tracking-[-0.02em] text-ink">批量调用预览</h2>
        <p className="mt-1 truncate font-mono text-[11px] text-muted">{flowId} · rev {revisionTail(revision)}</p>
      </div>
      <Button aria-label="关闭批量面板" onClick={props.onClose} size="sm" variant="ghost">关闭</Button>
    </header>

    {props.error && <p className="border-b border-danger/30 bg-danger-soft px-4 py-3 text-xs text-danger">{props.error}</p>}

    {props.draft ? <div className="grid gap-5 p-4">
      <section className="grid grid-cols-3 divide-x divide-line border-y border-line py-3">
        <Metric label="总项数" value={items.length} />
        <Metric label="可执行" value={items.length - blocking} tone="good" />
        <Metric label="需补充" value={blocking} tone={blocking ? "bad" : "muted"} />
      </section>

      <label className="grid gap-2 text-xs text-muted">
        <span className="font-medium text-ink">全局参数</span>
        <textarea
          className="min-h-20 resize-y rounded-lg border border-line-strong bg-canvas px-3 py-2 font-mono text-xs leading-5 text-ink outline-none focus:border-accent"
          onChange={(event) => setGlobalText(event.target.value)}
          spellCheck={false}
          value={globalText}
        />
      </label>

      <section className="grid gap-2" aria-label="批量参数项">
        {items.map((item, index) => <DraftRow
          item={item}
          key={item.item_id}
          onChange={(next) => setItems((current) => current.map((value) =>
            value.item_id === next.item_id ? next : value
          ))}
          onExclude={() => setItems((current) => current.filter((value) => value.item_id !== item.item_id))}
          position={index + 1}
        />)}
      </section>

      {(parseError || blocking > 0) && <p className="text-xs text-danger">{parseError ?? `${blocking} 项需要补充，修正并保存后才能确认。`}</p>}
      <div className="grid gap-3 border-t border-line pt-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <label className="grid max-w-40 gap-2 text-xs text-muted">
          <span className="font-medium text-ink">最大并发</span>
          <select className="h-9 rounded-lg border border-line-strong bg-canvas px-3 text-sm text-ink" onChange={(event) => setConcurrency(Number(event.target.value))} value={concurrency}>
            {[1, 2, 3, 5, 10].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <Button disabled={props.busy || !draftDirty || items.length === 0} onClick={save} variant="outline">保存修改</Button>
        <Button
          aria-label={`确认并执行 ${items.length} 项`}
          disabled={props.busy || blocking > 0 || draftDirty || props.draft.status !== "ready" || items.length === 0}
          onClick={() => props.onConfirm?.(concurrency)}
          variant="secondary"
        >确认并执行 {items.length} 项</Button>
      </div>
      <Button className="justify-self-start" disabled={props.busy || props.draft.status === "confirmed"} onClick={props.onCancelDraft} size="sm" variant="ghost">取消草稿</Button>
    </div> : null}

    {props.batch ? <div className="grid gap-5 p-4">
      <div className="grid gap-3 border-b border-line pb-4 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <p className="text-sm font-medium text-ink">{batchStatusLabel(props.batch.status)}</p>
          <p className="mt-1 font-mono text-xs text-muted">成功 {props.batch.counts.succeeded ?? 0} · 运行 {runningCount(props.batch)} · 失败 {failed} · 共 {props.batch.counts.total ?? props.batch.items.length}</p>
        </div>
        <span className={cn("w-fit rounded-md px-2 py-1 font-mono text-[11px]", batchTone(props.batch.status))}>{props.batch.status}</span>
      </div>
      <ol className="divide-y divide-line border-y border-line">
        {props.batch.items.map((item) => <li className="grid gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-center" key={`${item.item_id}:${item.attempt}`}>
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-ink">{item.item_id} · 第 {item.attempt} 次</p>
            <p className="mt-1 truncate font-mono text-[11px] text-muted">{pretty(item.inputs)}</p>
            {item.terminal_reason && <p className="mt-1 text-xs text-danger">{item.terminal_reason}</p>}
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-muted">{item.status}</span>
            <Button onClick={() => props.onOpenRun?.(item.run_id)} size="sm" variant="ghost">打开 Run</Button>
          </div>
        </li>)}
      </ol>
      <div className="flex flex-wrap gap-2">
        {failed > 0 && <Button aria-label={`只重试 ${failed} 个失败项`} disabled={props.busy} onClick={props.onRetryFailed} variant="secondary">只重试 {failed} 个失败项</Button>}
        {(props.batch.status === "queued" || props.batch.status === "running") && <Button disabled={props.busy} onClick={props.onCancelBatch} variant="destructive">取消未完成项</Button>}
      </div>
    </div> : null}
  </aside>;
}

function DraftRow(props: {
  item: FlowBatchDraftItem;
  position: number;
  onChange: (item: FlowBatchDraftItem) => void;
  onExclude: () => void;
}) {
  const [text, setText] = useState(() => pretty(props.item.inputs));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(pretty(props.item.inputs)), [props.item.inputs]);
  function commit() {
    try {
      const inputs = parseObject(text);
      setError(null);
      props.onChange({ ...props.item, inputs });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "参数不是有效 JSON");
    }
  }
  return <details className="group border-t border-line py-3" open={props.item.issues.some((issue) => issue.blocking) || undefined}>
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs">
      <span className="min-w-0 truncate font-medium text-ink">{String(props.position).padStart(2, "0")} · {props.item.label ?? props.item.item_id}</span>
      <span className={props.item.issues.some((issue) => issue.blocking) ? "text-danger" : "text-success"}>{props.item.issues.some((issue) => issue.blocking) ? "需要补充" : "可执行"}</span>
    </summary>
    <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(180px,0.55fr)]">
      <label className="grid gap-2 text-xs text-muted">
        <span>参数 JSON</span>
        <textarea className="min-h-28 resize-y rounded-lg border border-line-strong bg-canvas px-3 py-2 font-mono text-xs leading-5 text-ink" onBlur={commit} onChange={(event) => setText(event.target.value)} spellCheck={false} value={text} />
        {error && <span className="text-danger">{error}</span>}
      </label>
      <div className="grid content-start gap-2 text-xs text-muted">
        <span className="font-medium text-ink">证据与问题</span>
        <p>{Object.keys(props.item.evidence).length} 个字段有来源证据</p>
        {props.item.issues.map((issue, index) => <p className={issue.blocking ? "text-danger" : "text-warning"} key={`${issue.code}:${issue.field}:${index}`}>{issue.field ? `${issue.field}: ` : ""}{issue.message}</p>)}
        <Button className="mt-2 justify-self-start" onClick={props.onExclude} size="sm" variant="ghost">排除此项</Button>
      </div>
    </div>
  </details>;
}

function Metric({ label, value, tone = "muted" }: { label: string; value: number; tone?: "muted" | "good" | "bad" }) {
  return <div className="px-3 first:pl-0 last:pr-0">
    <p className={cn("font-mono text-xl", tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : "text-ink")}>{value}</p>
    <p className="mt-1 text-[11px] text-muted">{label}</p>
  </div>;
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("参数必须是 JSON 对象");
  return parsed as Record<string, unknown>;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function runningCount(batch: FlowBatchSnapshot): number {
  return batch.items.filter((item) => item.status === "queued" || item.status === "running" || item.status === "waiting").length;
}

function batchStatusLabel(status: FlowBatchSnapshot["status"]): string {
  switch (status) {
    case "queued": return "等待 Runtime 调度";
    case "running": return "Runtime 正在逐项执行";
    case "succeeded": return "全部执行成功";
    case "partial_succeeded": return "部分成功，可只重试失败项";
    case "failed": return "全部执行失败";
    case "cancelled": return "批次已取消";
  }
}

function batchTone(status: FlowBatchSnapshot["status"]): string {
  if (status === "succeeded") return "bg-success-soft text-success";
  if (status === "failed" || status === "partial_succeeded") return "bg-danger-soft text-danger";
  if (status === "cancelled") return "bg-surface-tint text-muted";
  return "bg-accent-soft text-ink";
}
