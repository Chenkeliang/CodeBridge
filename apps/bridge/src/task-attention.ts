import type { TaskAttentionItem } from "@codebridge/core";
import type { ApprovalService } from "@codebridge/policy";
import type { SessionCatalogStore } from "@codebridge/session-catalog";
import type { SqliteEventStore } from "@codebridge/work-items";
import type { AgentTaskStore } from "./agent-task-store.js";
import type { PendingAgentPermission } from "./agent-tasks.js";

/** A read-only projection. Resolving an item still uses its original domain command. */
export class TaskAttentionService {
  constructor(private readonly options: {
    catalog: SessionCatalogStore;
    workItems: SqliteEventStore;
    approvals: Pick<ApprovalService, "listForRun">;
    tasks: AgentTaskStore;
    pendingPermissions: () => Promise<PendingAgentPermission[]>;
    now?: () => Date;
  }) {}
  async list(input: { offset: number; limit: number; kind?: TaskAttentionItem["kind"] }) {
    const now = (this.options.now ?? (() => new Date()))();
    const sessions = new Map(this.options.catalog.listSessions().filter((session) => session.status !== "closed").map((session) => [session.id, session]));
    const runs = this.options.workItems.listRunsByStatus(["queued", "running", "waiting", "failed", "interrupted", "succeeded", "cancelled"])
      .filter((run) => run.sessionId && sessions.has(run.sessionId));
    const items: TaskAttentionItem[] = [], issues: string[] = [];
    let permissions: PendingAgentPermission[] = [];
    try { permissions = await this.options.pendingPermissions(); }
    catch { issues.push("暂时无法读取Agent权限请求；其他待处理项仍可查看，请检查Runner后刷新"); }
    const permissionRuns = new Set<string>();
    for (const permission of permissions) {
      if (permissionRuns.has(permission.runId)) continue;
      permissionRuns.add(permission.runId);
      const run = runs.find((run) => run.id === permission.runId && run.status === "running");
      const session = run?.sessionId ? sessions.get(run.sessionId) : undefined;
      if (!run || !session) continue;
      items.push({ id: `permission:${run.id}:${permission.requestId}`, kind: "agent_permission", title: session.title ?? "Agent权限请求", summary: permission.title,
        sessionId: session.id, agentId: session.agentId, runId: run.id, approvalId: permission.requestId, updatedAt: run.updatedAt });
    }
    for (const run of runs.filter((run) => run.status === "waiting")) {
      const session = sessions.get(run.sessionId!)!;
      const approvals = this.options.approvals.listForRun(run.id);
      for (const approval of approvals.filter((approval) => approval.status === "requested" && new Date(approval.expiresAt) > now)) {
        items.push({ id: `approval:${approval.id}`, kind: "runtime_approval", title: session.title ?? "执行步骤审批", summary: [approval.capabilityId, approval.environment, approval.targetResource].filter(Boolean).join(" · "),
          sessionId: session.id, agentId: session.agentId, runId: run.id, approvalId: approval.id, expiresAt: approval.expiresAt, updatedAt: approval.createdAt });
      }
      if (!approvals.some((approval) => approval.status === "requested" && new Date(approval.expiresAt) > now)) items.push({
        id: `approval-expired:${run.id}`, kind: "runtime_approval", title: session.title ?? "等待中的任务", summary: "当前步骤没有有效审批，请进入会话核对、取消或重新发起", sessionId: session.id,
        agentId: session.agentId, runId: run.id, updatedAt: run.updatedAt,
      });
    }
    for (const session of sessions.values()) {
      const runtime = this.options.workItems.getSessionRuntime(session.id);
      const sessionRuns = runs.filter((run) => run.sessionId === session.id).sort((a, b) => (b.turnId ? this.options.workItems.getTurn(b.turnId)?.queuePosition ?? 0 : 0) - (a.turnId ? this.options.workItems.getTurn(a.turnId)?.queuePosition ?? 0 : 0) || b.createdAt.localeCompare(a.createdAt));
      const latest = sessionRuns[0];
      if (runtime?.queueState === "paused") {
        const queued = this.options.workItems.listQueuedTurns(session.id, { limit: 1 }).total;
        const activeQueued = runtime.activeRunId ? this.options.workItems.getRun(runtime.activeRunId)?.status === "queued" : false;
        if (queued || activeQueued) items.push({ id: `queue:${session.id}`, kind: "paused_queue", title: session.title ?? "暂停的会话队列", summary: `${queued + Number(activeQueued)}条消息或任务等待继续；原因：${({ failed: "上一轮失败", interrupted: "上一轮中断", cancelled: "已取消", stale: "排队已过期" } as Record<string, string>)[runtime.queuePauseReason ?? ""] ?? "队列已暂停"}`,
          sessionId: session.id, agentId: session.agentId, runId: runtime.activeRunId, updatedAt: session.updatedAt });
      }
      if (latest && ["failed", "interrupted"].includes(latest.status) && !runtime?.activeRunId) {
        const scheduled = this.options.tasks.forRun(latest.id);
        if (scheduled && this.options.tasks.latestAttempt(scheduled.taskId)?.id !== scheduled.id) continue;
        items.push({ id: `failure:${latest.id}`, kind: "failed_run", title: session.title ?? "执行未完成",
          summary: latest.status === "interrupted" || latest.replaySafety === "outcome_unknown" ? "运行结果需要核对；不会自动重新执行" : latest.terminalReason ?? "上一轮执行失败，请进入会话查看原因", sessionId: session.id,
          agentId: session.agentId, runId: latest.id, ...(scheduled ? { taskId: scheduled.taskId, attemptId: scheduled.id } : {}), updatedAt: latest.updatedAt });
      }
    }
    for (const attempt of this.options.tasks.deliveryIssues()) items.push({ id: `delivery:${attempt.id}`, kind: "task_delivery", title: attempt.definition.name,
      summary: attempt.deliveryState === "unknown" ? "结果发送未确认；请核对是否已收到，再决定是否补发" : "结果未发出，可查看原结果并仅补发", sessionId: attempt.sessionId,
      agentId: attempt.definition.agentId, runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.id, updatedAt: attempt.finishedAt ?? attempt.startedAt });
    const selected = items.filter((item) => !input.kind || item.kind === input.kind).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const page = selected.slice(input.offset, input.offset + input.limit);
    return { items: page, total: selected.length, nextOffset: input.offset + page.length < selected.length ? input.offset + page.length : null, issues, checkedAt: now.toISOString() };
  }
}
