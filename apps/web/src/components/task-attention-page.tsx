import { useCallback, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronRight, Inbox, RefreshCw, X } from "lucide-react";
import type { TaskAttentionItem } from "@codebridge/core";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { TaskError, TaskSelect, taskDate, useTaskResource } from "@/components/task-ui";
const labels: Record<TaskAttentionItem["kind"], string> = { runtime_approval: "执行步骤审批", agent_permission: "Agent权限请求", paused_queue: "暂停的队列", failed_run: "执行未完成", task_delivery: "结果投递问题" };
export function TaskAttentionPage({ onOpenSession, onOpenTask }: { onOpenSession: (id: string) => Promise<void>; onOpenTask: (taskId: string, attemptId?: string) => void }) {
  const [kind, setKind] = useState<TaskAttentionItem["kind"] | "">(""), [offset, setOffset] = useState(0), [resolving, setResolving] = useState<string | null>(null), [actionError, setActionError] = useState<string | null>(null);
  const inFlight = useRef(false), loader = useCallback(() => api.pendingTasks(kind || undefined, offset), [kind, offset]), resource = useTaskResource(loader);
  async function resolve(item: TaskAttentionItem, approve: boolean) {
    if (!item.runId || !item.approvalId || inFlight.current) return;
    inFlight.current = true; setResolving(item.id); setActionError(null);
    try {
      const result = await api.resolveAgentPermission(item.runId, item.approvalId, approve);
      if (!result.resolved) throw new Error("请求已被处理或已过期，未批准其他请求，请刷新后查看");
      await resource.reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "权限处理未完成，请刷新后重试");
      await resource.reload();
    } finally { inFlight.current = false; setResolving(null); }
  }
  return <section aria-label="待处理总览" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line bg-sidebar px-5 py-5 md:px-8"><div><h1 className="font-brand text-xl font-normal tracking-tight text-ink">待处理</h1><p className="mt-1 text-sm leading-6 text-muted">找到正在等你的任务，进入原会话或结果记录处理。</p></div><Button aria-label="刷新待处理" onClick={() => void resource.reload()} size="sm" variant="outline"><RefreshCw className="mr-1.5 size-3.5" />刷新</Button></header>
    <div className="mx-auto grid w-full max-w-5xl gap-5 px-5 py-6 md:px-8"><div className="flex flex-wrap items-center justify-between gap-3"><div className="w-full sm:w-64"><TaskSelect label="待处理类型" onChange={(value) => { setKind(value as TaskAttentionItem["kind"] | ""); setOffset(0); }} options={[{ value: "", label: "全部类型" }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))]} value={kind} /></div>{resource.data && <span className="text-xs text-muted">共{resource.data.total}项 · {resource.loading ? "正在更新" : `检查于 ${taskDate(resource.data.checkedAt)}`}</span>}</div>
      <TaskError message={resource.error ?? actionError} />{resource.data?.issues.map((issue) => <p className="text-sm leading-6 text-danger" key={issue} role="alert">{issue}</p>)}
      {!resource.data ? <p className="py-10 text-sm text-muted" role="status">{resource.loading ? "正在读取待处理事项…" : "待处理事项尚未读到，请刷新后重试。"}</p> : !resource.data.items.length ? <div className="grid justify-items-start gap-3 border-y border-line py-12"><Inbox className="size-6 text-muted" /><h2 className="text-base font-medium text-ink">当前没有这类待处理事项</h2><p className="max-w-prose text-sm leading-6 text-muted">这里汇总权限请求、步骤审批、暂停队列、最近失败及定时任务投递问题。状态会自动更新。</p></div>
        : <div className="divide-y divide-line border-y border-line" aria-busy={resource.loading}>{resource.data.items.map((item) => <article className="grid min-w-0 gap-3 py-5" key={item.id}><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="text-xs text-muted">{labels[item.kind]}{item.agentId ? ` · ${item.agentId}` : ""}</p><h2 className="mt-1 break-words text-sm font-medium text-ink">{item.title}</h2></div><time className="text-xs text-muted" dateTime={item.updatedAt}>{taskDate(item.updatedAt)}</time></div><p className="whitespace-pre-wrap break-words text-sm leading-6 text-ink-soft">{item.summary}</p>
          {item.expiresAt && <p className="text-xs text-muted">本次步骤审批到期时间：{taskDate(item.expiresAt)}</p>}
          <div className="flex flex-wrap gap-2">{item.kind === "agent_permission" && item.approvalId && <><Button aria-label={`允许权限请求 ${item.title}`} disabled={resolving !== null} onClick={() => void resolve(item, true)} size="sm" variant="secondary"><Check className="mr-1.5 size-4" />{resolving === item.id ? "处理中…" : "允许本次操作"}</Button><Button aria-label={`拒绝权限请求 ${item.title}`} disabled={resolving !== null} onClick={() => void resolve(item, false)} size="sm" variant="outline"><X className="mr-1.5 size-4" />拒绝</Button></>}
            {item.taskId ? <Button onClick={() => onOpenTask(item.taskId!, item.attemptId)} size="sm" variant="outline">查看结果与恢复<ChevronRight className="ml-1 size-4" /></Button> : item.sessionId && <Button onClick={() => void onOpenSession(item.sessionId!)} size="sm" variant="outline"><ArrowUpRight className="mr-1.5 size-4" />{item.kind === "runtime_approval" ? "进入会话审批" : "进入会话处理"}</Button>}</div>
        </article>)}</div>}
      {resource.data && (offset > 0 || resource.data.nextOffset !== null) && <div className="flex gap-2"><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))} size="sm" variant="outline">上一页</Button><Button disabled={resource.data.nextOffset === null} onClick={() => setOffset(resource.data!.nextOffset!)} size="sm" variant="outline">下一页</Button></div>}
    </div>
  </section>;
}
