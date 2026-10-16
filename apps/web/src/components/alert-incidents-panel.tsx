import { useCallback, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, ChevronRight, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { TaskError, TaskSelect, taskDate, useTaskResource } from "@/components/task-ui";
const labels: Record<string, string> = { investigating: "排查中", waiting: "等待补充", resolved: "已恢复", no_action: "无需处理", blocked: "处理受阻", dismissed: "已人工结束" };
export function AlertIncidentsPanel({ chatId, children, onOpenSession }: { chatId: string; children: ReactNode; onOpenSession?: (id: string) => Promise<void> }) {
  const [view, setView] = useState<"settings" | "incidents">("settings");
  return <div className="grid gap-5"><nav aria-label="告警任务视图" className="flex flex-wrap gap-2"><Button aria-pressed={view === "settings"} onClick={() => setView("settings")} size="sm" variant={view === "settings" ? "secondary" : "outline"}>任务设置</Button><Button aria-pressed={view === "incidents"} onClick={() => setView("incidents")} size="sm" variant={view === "incidents" ? "secondary" : "outline"}>查看告警案件</Button></nav>
    <div hidden={view !== "settings"}>{children}</div>{view === "incidents" && <AlertIncidents key={chatId} chatId={chatId} onOpenSession={onOpenSession} />}
  </div>;
}
export function AlertIncidents({ chatId, onOpenSession }: { chatId: string; onOpenSession?: (id: string) => Promise<void> }) {
  const [status, setStatus] = useState(""), [offset, setOffset] = useState(0), [selected, setSelected] = useState<string | null>(null);
  const loader = useCallback(() => api.alertIncidents(chatId, status, offset), [chatId, status, offset]), resource = useTaskResource(loader);
  const membersLoader = useCallback(() => api.managementMembers(chatId), [chatId]), directory = useTaskResource(membersLoader, false);
  const person = (id: string) => {
    const member = directory.data?.members.find((value) => value.id === id);
    if (!member) return id;
    return directory.data!.members.filter((value) => value.name === member.name).length > 1 ? `${member.name}（…${id.slice(-6)}）` : member.name;
  };
  const incident = resource.data?.items.find((item) => item.id === selected);
  return <section aria-label="告警案件" className="grid min-w-0 gap-5"><div className="flex flex-wrap items-center justify-between gap-3"><div className="w-full sm:w-60"><TaskSelect label="案件状态" onChange={(value) => { setStatus(value); setOffset(0); setSelected(null); }} options={[{ value: "", label: "所有状态" }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))]} value={status} /></div><Button aria-label="刷新告警案件" onClick={() => { void resource.reload(); void directory.reload(); }} size="sm" variant="outline"><RefreshCw className="mr-1.5 size-4" />刷新</Button></div><TaskError message={resource.error} />
    {!resource.data ? <p className="text-sm text-muted" role="status">{resource.loading ? "正在读取案件…" : "案件尚未读到，请刷新后重试。"}</p> : incident ? <div className="grid min-w-0 gap-5"><div><Button className="mb-3" onClick={() => setSelected(null)} size="sm" variant="ghost"><ArrowLeft className="mr-1.5 size-4" />案件列表</Button><h2 className="text-base font-medium text-ink">{labels[incident.status] ?? "未识别的状态"}</h2><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink-soft">{incident.summary}</p></div>
      <dl className="grid gap-4 border-y border-line py-4 text-sm sm:grid-cols-2"><div><dt className="text-muted">首次告警</dt><dd className="mt-1 text-ink">{taskDate(incident.firstSeenAt)}</dd></div><div><dt className="text-muted">最近出现</dt><dd className="mt-1 text-ink">{taskDate(incident.lastSeenAt)}</dd></div><div><dt className="text-muted">合并告警</dt><dd className="mt-1 text-ink">共{incident.repeatCount}条消息</dd></div><div><dt className="text-muted">来源应用</dt><dd className="mt-1 break-all font-mono text-xs text-ink">{incident.senderAppId}</dd></div></dl>
      <div><h3 className="text-sm font-medium text-ink">原告警内容</h3><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-ink-soft">{incident.content || "原卡片没有可读取的正文。"}</p></div>
      <div className="grid gap-2 border-t border-line pt-4 text-xs leading-6 text-muted"><p className="break-all">负责人：{incident.responsibleOpenIds.map(person).join("、") || "未配置"}</p><p className="break-all">操作审批人：{incident.approverOpenIds.map(person).join("、") || "未配置"}</p>{directory.error && <p>成员名称暂未读到，保留当前身份编号；可检查群成员读取权限后刷新。</p>}<p>人员身份以当前群的配置为准。查看案件不会更改状态、游标或触发排查。</p></div>
      {incident.dismissal && <p className="text-sm leading-6 text-muted">人工结束原因：{incident.dismissal.reason} · {taskDate(incident.dismissal.at)}</p>}
      {incident.sessionId && onOpenSession ? <Button className="w-fit" onClick={() => void onOpenSession(incident.sessionId!)} size="sm" variant="outline"><ArrowUpRight className="mr-1.5 size-4" />进入排查会话</Button> : <p className="text-xs text-muted">当前没有可进入的关联排查会话。</p>}
      <details className="border-t border-line pt-4"><summary className="cursor-pointer text-sm text-ink">关联消息编号</summary><ul className="mt-3 grid gap-2 break-all font-mono text-xs text-muted">{incident.sourceMessageIds.map((id) => <li key={id}>{id}</li>)}</ul></details>
    </div> : <><p className="text-xs text-muted">当前筛选共{resource.data.total}个案件，显示第{resource.data.items.length ? offset + 1 : 0}至{offset + resource.data.items.length}个。</p><div className="divide-y divide-line border-y border-line">{resource.data.items.map((item) => <button className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-4 text-left hover:bg-surface-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-muted" key={item.id} onClick={() => setSelected(item.id)} type="button"><span className="min-w-0"><span className="block text-xs text-muted">{labels[item.status] ?? item.status} · 合并{item.repeatCount}条 · {taskDate(item.lastSeenAt)}</span><span className="mt-1 block break-words text-sm leading-6 text-ink">{item.summary}</span></span><ChevronRight className="size-4 text-muted" /></button>)}{!resource.data.items.length && <p className="py-10 text-sm leading-6 text-muted">当前没有这类案件。案件来自原告警采集器，查看不会补抓或重新执行。</p>}</div>
      {(offset > 0 || resource.data.nextOffset !== null) && <div className="flex gap-2"><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))} size="sm" variant="outline">上一页</Button><Button disabled={resource.data.nextOffset === null} onClick={() => setOffset(resource.data!.nextOffset!)} size="sm" variant="outline">下一页</Button></div>}</>}
  </section>;
}
