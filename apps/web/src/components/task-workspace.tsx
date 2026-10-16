import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AgentTasksPage, type TaskLocation } from "@/components/agent-tasks-page";
import { ManagementPage } from "@/components/management-page";
export function TaskWorkspace({ initial, onNotify, onOpenSession }: { initial?: TaskLocation | null; onNotify: (message: string, kind?: "info" | "error") => void; onOpenSession: (id: string) => Promise<void> }) {
  const [tab, setTab] = useState<"agent" | "existing">("agent");
  return <section aria-label="任务工作区" className="flex min-h-0 flex-1 flex-col"><nav aria-label="任务类型" className="flex shrink-0 flex-wrap gap-2 border-b border-line bg-sidebar px-5 py-3 md:px-8"><Button aria-pressed={tab === "agent"} onClick={() => setTab("agent")} size="sm" variant={tab === "agent" ? "secondary" : "outline"}>Agent定时任务</Button><Button aria-pressed={tab === "existing"} onClick={() => setTab("existing")} size="sm" variant={tab === "existing" ? "secondary" : "outline"}>已有计划、推送与告警</Button></nav>
    {tab === "agent" ? <AgentTasksPage initial={initial} onNotify={onNotify} onOpenSession={onOpenSession} /> : <ManagementPage area="tasks" onNotify={onNotify} onOpenSession={onOpenSession} />}
  </section>;
}
