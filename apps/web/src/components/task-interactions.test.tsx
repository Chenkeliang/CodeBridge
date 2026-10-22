// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentTaskAttemptDetail, AgentTaskDefinition, AgentTaskDraft, AgentTaskOptions } from "@codebridge/core";
import { AgentTaskEditor, AgentTasksPage } from "./agent-tasks-page";
import { TaskAttentionPage } from "./task-attention-page";
import { AlertIncidents, AlertIncidentsPanel } from "./alert-incidents-panel";
import { api } from "@/lib/api";
vi.mock("@/lib/api", () => ({ api: { agentTasks: vi.fn(), agentTaskOptions: vi.fn(), agentTask: vi.fn(), agentTaskAttempt: vi.fn(), preflightAgentTask: vi.fn(), saveAgentTask: vi.fn(), agentTaskAction: vi.fn(), downloadTaskFile: vi.fn(), pendingTasks: vi.fn(), resolveAgentPermission: vi.fn(), alertIncidents: vi.fn(), managementMembers: vi.fn() } }));
vi.mock("@/components/conversation", () => ({ Markdown: ({ content }: { content: string }) => <div>{content}</div> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const options: AgentTaskOptions = { agents: [{ id: "codex", name: "Fixture Agent", ready: true }], skills: [], targets: [{ label: "仅本地", target: { channel: "local" } }], defaultCwd: "/fixture", timezone: "Asia/Shanghai" };
const draft: AgentTaskDraft = { name: "Fixture task", prompt: "Read fixture", agentId: "codex", cwd: "/fixture", skills: [], model: null, effort: null, permissionMode: null, schedule: "每天09:00", timezone: "Asia/Shanghai", catchUp: "once", notification: "result", target: { channel: "feishu", chatId: "oc_fixture" }, enabled: false };
const task: AgentTaskDefinition = { ...draft, id: "task_fixture", version: 1, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z", nextRunAt: null, activeAttemptId: null, lastRunAt: null, pausedReason: "已暂停", parsedSchedule: { kind: "cron", expression: "0 9 * * *", label: "每天09:00" } };
const detail: AgentTaskAttemptDetail & { revision: string } = { revision: "fixture-revision", sessionAvailable: true,
  attempt: { id: "taskrun_fixture", taskId: task.id, definition: draft, sessionId: "sess_fixture", runId: "run_fixture", turnId: "turn_fixture", workItemId: "work_fixture", trigger: "manual", scheduledAt: task.createdAt, startedAt: task.createdAt, finishedAt: task.createdAt, status: "succeeded", reason: null, outcomeUncertain: false, result: "Fixture report", retryOf: null, deliveryState: "unknown" },
  notices: [], files: [{ id: "taskfile_fixture", attemptId: "taskrun_fixture", name: "fixture.md", path: "/fixture/fixture.md", sha256: "fixture-hash", size: 12, createdAt: task.createdAt, deliveryOwner: "task" }], events: [], eventsTruncated: false };
const pending = { total: 3, nextOffset: null, issues: [], checkedAt: task.createdAt, items: [
  { id: "permission", kind: "agent_permission" as const, title: "Fixture permission", summary: "Read fixture", sessionId: "sess_fixture", agentId: "codex", runId: "run_fixture", approvalId: "req_fixture", updatedAt: task.createdAt },
  { id: "approval", kind: "runtime_approval" as const, title: "Fixture step", summary: "Fixture target", sessionId: "sess_step", agentId: "codex", runId: "run_step", approvalId: "apr_fixture", updatedAt: task.createdAt },
  { id: "delivery", kind: "task_delivery" as const, title: "Fixture result", summary: "Resend needed", sessionId: "sess_delivery", agentId: "codex", runId: "run_delivery", taskId: task.id, attemptId: detail.attempt.id, updatedAt: task.createdAt },
] };
const cases = { total: 1, nextOffset: null, items: [{ id: "om_fixture", chatId: "oc_fixture", status: "blocked", summary: "Fixture blocked", content: "Synthetic original evidence", senderAppId: "cli_fixture", firstSeenAt: task.createdAt, lastSeenAt: task.createdAt, repeatCount: 2, sourceMessageIds: ["om_fixture", "om_duplicate"], responsibleOpenIds: ["ou_owner"], approverOpenIds: ["ou_approver"], sessionId: "sess_fixture", dismissal: null }] };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.mocked(api.agentTasks).mockResolvedValue({ revision: "fixture-revision", tasks: [structuredClone(task)], scheduler: { running: true, lastCheckAt: task.createdAt, lastError: null, maintenance: false } });
  vi.mocked(api.agentTaskOptions).mockResolvedValue(structuredClone(options));
  vi.mocked(api.agentTask).mockResolvedValue({ revision: "fixture-revision", task: structuredClone(task), runs: [structuredClone(detail.attempt)], total: 1, nextOffset: null });
  vi.mocked(api.agentTaskAttempt).mockResolvedValue(structuredClone(detail));
  vi.mocked(api.preflightAgentTask).mockResolvedValue({ valid: true, schedule: task.parsedSchedule, checks: [{ name: "Agent", ok: true, message: "已就绪" }], nextRuns: ["2026-10-16T01:00:00Z", "2026-10-17T01:00:00Z", "2026-10-18T01:00:00Z"] });
  vi.mocked(api.saveAgentTask).mockResolvedValue({ revision: "fixture-revision", task: structuredClone(task), preflight: { valid: true, checks: [], schedule: task.parsedSchedule, nextRuns: [] } });
  vi.mocked(api.agentTaskAction).mockResolvedValue({ revision: "fixture-revision", attempt: structuredClone(detail.attempt) });
  vi.mocked(api.downloadTaskFile).mockResolvedValue(undefined); vi.mocked(api.pendingTasks).mockResolvedValue(structuredClone(pending));
  vi.mocked(api.managementMembers).mockResolvedValue({ members: [{ id: "ou_owner", name: "Fixture responsible" }, { id: "ou_approver", name: "Fixture approver" }] });
  vi.mocked(api.resolveAgentPermission).mockResolvedValue({ resolved: true }); vi.mocked(api.alertIncidents).mockResolvedValue(structuredClone(cases));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const button = (text: string) => [...host.querySelectorAll("button")].find((el) => el.textContent?.trim() === text)!;
async function click(text: string) { await act(async () => button(text).click()); }
async function fill(label: string, value: string) { await act(async () => {
  const field = host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement;
  Object.getOwnPropertyDescriptor(field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}); }
async function submit() { await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }
it("previews without saving and clears stale preview when its inputs change", async () => {
  await act(async () => root.render(<AgentTaskEditor onCancel={vi.fn()} onSaved={vi.fn()} options={options} revision="fixture-revision" task={task} />));
  await click("检查并预览"); expect(host.textContent).toContain("接下来3次计划时间"); expect(api.saveAgentTask).not.toHaveBeenCalled();
  await fill("执行时间", "每天10:00"); expect(host.textContent).not.toContain("运行前检查通过");
});
it("preserves draft, original versions and the same retry key after an ambiguous save error", async () => {
  const saved = vi.fn(); vi.mocked(api.saveAgentTask).mockRejectedValueOnce(new Error("配置已更新"));
  await act(async () => root.render(<AgentTaskEditor onCancel={vi.fn()} onSaved={saved} options={options} revision="fixture-revision" task={task} />));
  await fill("执行指令", "Preserved draft");
  await act(async () => root.render(<AgentTaskEditor onCancel={vi.fn()} onSaved={saved} options={options} revision="polled-version" task={{ ...task, version: 2 }} />));
  await submit(); expect((host.querySelector('[aria-label="执行指令"]') as HTMLTextAreaElement).value).toBe("Preserved draft"); expect(host.textContent).toContain("配置已更新");
  const first = vi.mocked(api.saveAgentTask).mock.calls[0]!; expect(first[1]).toBe("fixture-revision"); expect(first[3]?.version).toBe(1);
  await submit(); expect(vi.mocked(api.saveAgentTask).mock.calls[1]![2]).toBe(first[2]); expect(saved).toHaveBeenCalledOnce();
});
it("resends the stored result without rerunning, downloads the file and opens its exact session", async () => {
  const open = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<AgentTasksPage initial={{ taskId: task.id, attemptId: detail.attempt.id }} onNotify={vi.fn()} onOpenSession={open} />));
  expect(host.textContent).toContain("Fixture report"); await click("仅补发已有结果");
  expect(api.agentTaskAction).toHaveBeenCalledWith(task.id, "resend", "fixture-revision", expect.any(Object), expect.any(String), detail.attempt.id);
  expect(vi.mocked(api.agentTaskAction).mock.calls.filter((call) => call[1] === "run" || call[1] === "retry")).toEqual([]);
  await click("下载"); expect(api.downloadTaskFile).toHaveBeenCalledWith("taskfile_fixture", "fixture.md");
  await click("进入会话处理"); expect(open).toHaveBeenCalledWith("sess_fixture");
});
it("requires acknowledgement before retrying an interrupted run and hides an unavailable session link", async () => {
  const value = structuredClone(detail); value.attempt.status = "interrupted"; value.sessionAvailable = false; vi.mocked(api.agentTaskAttempt).mockResolvedValue(value);
  await act(async () => root.render(<AgentTasksPage initial={{ taskId: task.id, attemptId: detail.attempt.id }} onNotify={vi.fn()} onOpenSession={vi.fn()} />));
  expect(button("重新执行这次").disabled).toBe(true); expect(button("进入会话处理")).toBeUndefined();
  await act(async () => (host.querySelector('[aria-label="已核对中断执行结果"]') as HTMLInputElement).click()); await click("重新执行这次");
  expect(api.agentTaskAction).toHaveBeenCalledWith(task.id, "retry", "fixture-revision", expect.objectContaining({ acknowledgeUnknown: true }), expect.any(String), detail.attempt.id);
});
it("uses exact permission identity, keeps stale errors visible and routes other work to its original destination", async () => {
  const open = vi.fn().mockResolvedValue(undefined), openTask = vi.fn();
  await act(async () => root.render(<TaskAttentionPage onOpenSession={open} onOpenTask={openTask} />));
  await click("允许本次操作"); expect(api.resolveAgentPermission).toHaveBeenCalledWith("run_fixture", "req_fixture", true);
  vi.mocked(api.resolveAgentPermission).mockRejectedValueOnce(new Error("请求已过期")); await click("允许本次操作");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("请求已过期"); expect(api.resolveAgentPermission).toHaveBeenCalledTimes(2);
  await click("进入会话审批"); expect(open).toHaveBeenCalledWith("sess_step"); await click("查看结果与恢复"); expect(openTask).toHaveBeenCalledWith(task.id, detail.attempt.id);
});
function FixtureForm() { const [text, setText] = useState("Original draft"); return <input aria-label="原配置草稿" onChange={(event) => setText(event.target.value)} value={text} />; }
it("opens read-only cases lazily, preserves the settings draft and enters the linked investigation", async () => {
  const open = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<AlertIncidentsPanel chatId="oc_fixture" onOpenSession={open}><FixtureForm /></AlertIncidentsPanel>));
  expect(api.alertIncidents).not.toHaveBeenCalled(); await fill("原配置草稿", "Unsaved settings"); await click("查看告警案件");
  expect(api.alertIncidents).toHaveBeenCalledWith("oc_fixture", "", 0); await act(async () => [...host.querySelectorAll("button")].find((node) => node.textContent?.includes("Fixture blocked"))!.click()); expect(host.textContent).toContain("Synthetic original evidence"); expect(host.textContent).toContain("共2条消息");
  await click("进入排查会话"); expect(open).toHaveBeenCalledWith("sess_fixture"); await click("任务设置");
  expect((host.querySelector('[aria-label="原配置草稿"]') as HTMLInputElement).value).toBe("Unsaved settings");
});
it("ignores a delayed case response from a previously selected group", async () => {
  let resolveOld!: (value: typeof cases) => void;
  vi.mocked(api.alertIncidents).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce({ ...cases, items: [{ ...cases.items[0]!, chatId: "oc_new", summary: "New group evidence" }] });
  await act(async () => root.render(<AlertIncidents chatId="oc_old" />)); await act(async () => root.render(<AlertIncidents chatId="oc_new" />)); await act(async () => resolveOld(cases));
  expect(host.textContent).toContain("New group evidence"); expect(host.textContent).not.toContain("Fixture blocked");
});
