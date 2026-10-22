import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DEFAULT_SELECT_VALUE } from "@/components/workbench-shared";
export const taskInputClass = "w-full min-w-0 rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-muted disabled:opacity-50";
export const taskStatusLabels: Record<string, string> = { claimed: "准备执行", queued: "排队中", running: "运行中", waiting: "等待审批", succeeded: "已完成", failed: "执行失败", cancelled: "已取消", interrupted: "中断，结果待核对", skipped: "本次已跳过" };
export const taskDeliveryLabels: Record<string, string> = { pending: "等待结果投递", sending: "正在发送", sent: "渠道已确认发送", failed: "尚未发出", unknown: "发送结果未确认", suppressed: "按通知设置不发送", local: "仅保存在本地", acknowledged: "已确认无需补发" };
export function taskDate(value: string | null | undefined, timezone?: string): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", { hour12: false, ...(timezone ? { timeZone: timezone } : {}) });
}
export function TaskField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="grid min-w-0 gap-1.5 text-sm font-medium text-ink"><span>{label}</span>{children}{hint && <span className="text-xs font-normal leading-5 text-muted">{hint}</span>}</label>;
}
export function TaskSelect({ label, value, options, disabled, onChange }: { label: string; value: string; disabled?: boolean; options: Array<{ value: string; label: string; disabled?: boolean }>; onChange: (value: string) => void }) {
  return <Select disabled={disabled} onValueChange={(next) => onChange(next === DEFAULT_SELECT_VALUE ? "" : next)} value={value || DEFAULT_SELECT_VALUE}>
    <SelectTrigger aria-label={label} className={`${taskInputClass} h-10`}><SelectValue /></SelectTrigger><SelectContent className="border-line-strong bg-surface text-ink">{options.map((option) => <SelectItem disabled={option.disabled} key={option.value} value={option.value || DEFAULT_SELECT_VALUE}>{option.label}</SelectItem>)}</SelectContent>
  </Select>;
}
/** Status polling discards late responses and never owns an editor's draft or revision. */
export function useTaskResource<T>(loader: () => Promise<T>, poll = true) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true);
  const generation = useRef({ value: 0 });
  const reload = useCallback(async () => {
    const current = ++generation.current.value; setLoading(true);
    try { const value = await loader(); if (generation.current.value === current) { setData(value); setError(null); } }
    catch (caught) { if (generation.current.value === current) setError(caught instanceof Error ? caught.message : "读取未完成，请重试"); }
    finally { if (generation.current.value === current) setLoading(false); }
  }, [loader]);
  useEffect(() => {
    let active = true;
    const epoch = generation.current;
    void Promise.resolve().then(() => { if (active) return reload(); });
    const timer = poll ? setInterval(() => { if (!document.hidden) void reload(); }, 5_000) : undefined;
    return () => { active = false; epoch.value++; if (timer) clearInterval(timer); };
  }, [reload, poll]);
  return { data, error, loading, reload };
}
export function TaskError({ message }: { message: string | null | undefined }) {
  return message ? <p className="break-words rounded-md bg-danger-soft px-4 py-3 text-sm leading-6 text-danger" role="alert">{message}</p> : null;
}
