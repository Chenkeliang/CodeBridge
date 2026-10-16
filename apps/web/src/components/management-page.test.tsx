// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagementSnapshot } from "@codebridge/core";
import { ManagementPage } from "./management-page";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: { management: vi.fn(), channelConnections: vi.fn(), testChannelConnection: vi.fn(), changeManagement: vi.fn(), managementMembers: vi.fn(), managementChats: vi.fn(), managementAlertSources: vi.fn(), availableLocalTasks: vi.fn(), managedRule: vi.fn(), saveManagedRule: vi.fn() } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const data: ManagementSnapshot = { revision: "fixture-revision", channels: [
  { channel: "feishu", configured: true, connected: true, credentialSource: "keychain", administrators: [], allowedUsers: [], allowedChats: ["oc_fixture"], dmMode: "open", dmAllowlist: [], requireMention: true },
  { channel: "telegram", configured: false, connected: null, credentialSource: "missing", administrators: [], allowedUsers: [], allowedChats: [] },
], alerts: [{ chatId: "oc_fixture", name: "Fixture alert", senderAppIds: ["cli_fixture"], approverOpenIds: ["ou_fixture"], enabled: true, pollIntervalMs: 30_000, runbookPath: "/fixture/skills/fixture/SKILL.md" }],
publishers: [{ label: "Fixture report", chatId: "oc_fixture", routes: ["markdown"] }], local: { tasks: [{ id: "fixture-task", name: "Fixture local task", source: "/fixture/LaunchAgents/fixture.plist", label: "fixture.report", command: "/fixture/report.py", calendar: [{ Hour: 9, Minute: 30 }], interval: null, loaded: true, running: false, lastExitCode: 0, revision: "fixture-file" }], issues: [], supported: true } };
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(api.management).mockResolvedValue(structuredClone(data)); vi.mocked(api.changeManagement).mockResolvedValue(structuredClone(data));
  vi.mocked(api.managementMembers).mockResolvedValue({ members: [{ id: "ou_fixture_new", name: "Fixture member" }] });
  vi.mocked(api.managementChats).mockResolvedValue({ chats: [{ id: "oc_fixture", name: "Fixture group" }, { id: "oc_new", name: "New project group" }] });
  vi.mocked(api.managementAlertSources).mockResolvedValue({ sources: [{ id: "cli_fixture", preview: "Synthetic alarm" }] });
  vi.mocked(api.channelConnections).mockResolvedValue({ channels: structuredClone(data.channels) });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const button = (text: string) => [...container.querySelectorAll("button")].find((el) => el.textContent?.includes(text))!;
async function show(area: "channels" | "tasks") { await act(async () => root.render(<ManagementPage area={area} onNotify={vi.fn()} />)); }
async function click(text: string) { await act(async () => button(text).click()); }
describe("Channels and Tasks active surface", () => {
  it("loads channel configuration and saves with the current revision", async () => {
    await show("channels"); expect(container.textContent).toContain("密钥");
    await act(async () => container.querySelector('[aria-label="渠道访问设置"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(api.changeManagement).toHaveBeenCalledWith("/channels/feishu", "PATCH", "fixture-revision", expect.objectContaining({ channel: "feishu" }));
  });
  it("selects verified member identities into the visible role field", async () => {
    await show("channels"); await click("读取成员"); await click("Fixture member");
    expect((container.querySelector('[aria-label="管理员"]') as HTMLTextAreaElement).value).toContain("ou_fixture_new");
  });
  it("shows failures and retains the current form for correction", async () => {
    vi.mocked(api.changeManagement).mockRejectedValueOnce(new Error("配置已更新，请刷新"));
    await show("channels"); await act(async () => container.querySelector('[aria-label="渠道访问设置"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("配置已更新"); expect(container.querySelector('[aria-label="允许的聊天"]')).not.toBeNull();
  });
  it("opens a local task and sends only an explicit run action", async () => {
    await show("tasks"); expect(api.changeManagement).not.toHaveBeenCalled(); await click("Fixture local task");
    expect(container.textContent).toContain("执行时间"); await click("运行一次");
    expect(api.changeManagement).toHaveBeenCalledWith("/local/fixture-task/run", "POST", "fixture-revision", { revision: "fixture-file" });
  });
  it("preserves a rule draft when saving fails and reports the encrypted backup after retry", async () => {
    vi.mocked(api.managedRule).mockResolvedValue({ root: "/fixture/skills/fixture", entry: "SKILL.md", relative: "SKILL.md", name: "fixture", description: "Fixture", files: ["SKILL.md"], content: "# Original fixture", revision: "rule-v1" });
    vi.mocked(api.saveManagedRule).mockRejectedValueOnce(new Error("文件已被修改，请重新读取"))
      .mockResolvedValueOnce({ revision: "rule-v2", backup: "/fixture/data/management-backups/fixture.json" });
    await show("tasks"); await click("Fixture alert"); await click("维护规则");
    const textarea = container.querySelector('[aria-label="规则内容"]') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "# Updated fixture");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("保存规则"); expect(textarea.value).toBe("# Updated fixture"); expect(container.textContent).toContain("文件已被修改");
    await click("保存规则"); expect(api.saveManagedRule).toHaveBeenLastCalledWith("oc_fixture", "fixture-revision", { file: "SKILL.md", revision: "rule-v1", content: "# Updated fixture" });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("management-backups/fixture.json");
  });
  it("keeps an existing alert's group identity fixed while allowing new task entry", async () => {
    await show("tasks"); await click("Fixture alert");
    expect((container.querySelector('[aria-label="告警群"]') as HTMLSelectElement).disabled).toBe(true);
    await click("所有任务"); await click("新增告警");
    expect((container.querySelector('[aria-label="告警群"]') as HTMLSelectElement).disabled).toBe(false);
  });
  it("keeps alert approval and delivery policy in the selected task", async () => {
    await show("tasks"); await click("Fixture alert"); expect([...container.querySelectorAll("legend")].some((element) => element.textContent === "操作审批人")).toBe(true);
    expect(container.querySelector('[aria-label="Skill 规则入口（可选）"]')).not.toBeNull(); await click("所有任务"); await click("Fixture report");
    expect(container.textContent).toContain("不需要修改现有推送脚本");
  });
});

it("saves automatic or mentioned-only replies and preserves editable group exceptions", async () => {
  const snapshot = structuredClone(data);
  snapshot.channels[0]!.scenarios = [{ name: "Fixture exception", chats: ["oc_fixture"], requireMention: false }];
  vi.mocked(api.management).mockResolvedValueOnce(snapshot);
  await show("channels");
  expect((container.querySelector('[aria-label="例外名称 1"]') as HTMLInputElement).value).toBe("Fixture exception");
  await act(async () => (container.querySelector('input[aria-label="自动回复"]') as HTMLInputElement).click());
  await click("保存渠道设置");
  expect(api.changeManagement).toHaveBeenLastCalledWith("/channels/feishu", "PATCH", "fixture-revision", expect.objectContaining({ requireMention: false, scenarios: snapshot.channels[0]!.scenarios }));
});
it("selects responsible people independently from approvers and saves the selected task", async () => {
  await show("tasks"); await click("Fixture alert");
  await act(async () => (container.querySelector('input[aria-label="Fixture member，设为负责人"]') as HTMLInputElement).click());
  expect(container.querySelector('[aria-label="已选负责人"]')?.textContent).toContain("Fixture member");
  await click("保存告警设置");
  expect(api.changeManagement).toHaveBeenLastCalledWith("/alerts/oc_fixture", "PUT", "fixture-revision", expect.objectContaining({ responsibleOpenIds: expect.arrayContaining(["ou_fixture_new"]), approverOpenIds: ["ou_fixture"] }));
});

it("automatically loads a named group and member choices when opening an existing alert", async () => {
  await show("tasks"); await click("Fixture alert");
  expect(api.managementChats).toHaveBeenCalled();
  expect(api.managementMembers).toHaveBeenCalledWith("oc_fixture");
  expect(container.querySelector('[aria-label="告警群"]')?.tagName).toBe("SELECT");
  expect(container.textContent).toContain("Fixture group");
  expect(container.querySelector('[aria-label="读取成员的群 ID"]')).toBeNull();
});
it("creates an alert by names with automatic task name and unique source, preserving role separation", async () => {
  const snapshot = structuredClone(data); snapshot.channels[0]!.administrators = ["ou_fixture"];
  vi.mocked(api.management).mockResolvedValueOnce(snapshot);
  vi.mocked(api.managementMembers).mockResolvedValue({ members: [{ id: "ou_fixture", name: "Approver member" }, { id: "ou_fixture_new", name: "Responsible member" }] });
  await show("tasks"); await click("新增告警");
  const choice = container.querySelector('[aria-label="告警群"]') as HTMLSelectElement;
  expect(choice.value).toBe("oc_new");
  const person = container.querySelector('input[aria-label="Responsible member，设为负责人"]') as HTMLInputElement;
  await act(async () => person.click()); await click("保存告警设置");
  expect(api.changeManagement).toHaveBeenLastCalledWith("/alerts/oc_new", "PUT", "fixture-revision", expect.objectContaining({
    name: "New project group告警", senderAppIds: ["cli_fixture"], responsibleOpenIds: ["ou_fixture_new"], approverOpenIds: ["ou_fixture"], channel: "feishu",
  }));
});

it("discards stale member and source responses after switching groups", async () => {
  const snapshot = structuredClone(data); snapshot.channels[0]!.administrators = ["ou_fixture"];
  vi.mocked(api.management).mockResolvedValueOnce(snapshot);
  vi.mocked(api.managementChats).mockResolvedValueOnce({ chats: [{ id: "oc_a", name: "Group A" }, { id: "oc_b", name: "Group B" }] });
  let resolveA!: (value: { members: Array<{ id: string; name: string }> }) => void;
  vi.mocked(api.managementMembers).mockImplementation((chat) => chat === "oc_a" ? new Promise((resolve) => { resolveA = resolve; }) : Promise.resolve({ members: [{ id: "ou_fixture", name: "Approver" }, { id: "ou_b", name: "Member B" }] }));
  vi.mocked(api.managementAlertSources).mockImplementation(async (chat) => ({ sources: [{ id: chat === "oc_a" ? "cli_a" : "cli_b", preview: chat === "oc_a" ? "Alarm A" : "Alarm B" }] }));
  await show("tasks"); await click("新增告警");
  const select = container.querySelector('[aria-label="告警群"]') as HTMLSelectElement;
  await act(async () => { select.value = "oc_a"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { const rule = container.querySelector('[aria-label="Skill 规则入口（可选）"]') as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(rule, "/fixture/old-group/SKILL.md"); rule.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { select.value = "oc_b"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => resolveA({ members: [{ id: "ou_a", name: "Stale member A" }] }));
  expect(container.textContent).not.toContain("Stale member A"); expect(container.textContent).toContain("Member B");
  await act(async () => (container.querySelector('input[aria-label="Member B，设为负责人"]') as HTMLInputElement).click());
  await click("保存告警设置");
  expect(api.changeManagement).toHaveBeenLastCalledWith("/alerts/oc_b", "PUT", "fixture-revision", expect.objectContaining({ senderAppIds: ["cli_b"], responsibleOpenIds: ["ou_b"], runbookPath: undefined }));
});
it("retains saved identities and explains recovery when directory permissions fail", async () => {
  vi.mocked(api.managementMembers).mockRejectedValueOnce(new Error("Missing members permission"));
  vi.mocked(api.managementAlertSources).mockRejectedValueOnce(new Error("Missing messages permission"));
  await show("tasks"); await click("Fixture alert");
  expect(container.textContent).toContain("Missing members permission"); expect(container.textContent).toContain("Missing messages permission");
  expect(container.textContent).toContain("已保存设置保留");
  await click("保存告警设置");
  expect(api.changeManagement).toHaveBeenLastCalledWith("/alerts/oc_fixture", "PUT", "fixture-revision", expect.objectContaining({ responsibleOpenIds: ["ou_fixture"], approverOpenIds: ["ou_fixture"], senderAppIds: ["cli_fixture"] }));
});

it("distinguishes people with identical names using their app-scoped identity", async () => {
  vi.mocked(api.managementMembers).mockResolvedValueOnce({ members: [{ id: "ou_first000001", name: "同名成员" }, { id: "ou_second000002", name: "同名成员" }] });
  await show("tasks"); await click("Fixture alert");
  await act(async () => (container.querySelector('input[aria-label="同名成员（…000002），设为负责人"]') as HTMLInputElement).click());
  expect(container.querySelector('[aria-label="已选负责人"]')?.textContent).toContain("同名成员（…000002）");
  await click("保存告警设置");
  const body = vi.mocked(api.changeManagement).mock.calls.at(-1)![3] as { responsibleOpenIds: string[] };
  expect(body.responsibleOpenIds).toContain("ou_second000002"); expect(body.responsibleOpenIds).not.toContain("ou_first000001");
});
