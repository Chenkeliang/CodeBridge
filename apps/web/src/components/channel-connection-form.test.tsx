// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ManagedChannel } from "@codebridge/core";
import { api } from "@/lib/api";
import { ChannelConnectionForm } from "./channel-connection-form";
vi.mock("@/lib/api", () => ({ api: { testChannelConnection: vi.fn() } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const value: ManagedChannel = { channel: "feishu", configured: true, connected: true, credentialSource: "keychain", administrators: [], allowedUsers: [], allowedChats: [],
  connection: { state: "connected", canApply: true, environmentManaged: false, appId: "cli_fixture" } };
const change = vi.fn().mockResolvedValue(undefined), dirty = vi.fn();
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.testChannelConnection).mockResolvedValue({ valid: true, identity: "cli_fixture", message: "凭据有效" }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function show(next = value, accessDirty = false) { await act(async () => root.render(<ChannelConnectionForm accessDirty={accessDirty} busy={false} change={change} onDirty={dirty} revision="fixture-revision" value={next} />)); }
async function click(text: string) { await act(async () => [...container.querySelectorAll("button")].find((element) => element.textContent?.includes(text))!.click()); }
async function input(label: string, text: string) { await act(async () => { const field = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text); field.dispatchEvent(new Event("input", { bubbles: true })); }); }
it("renders no stored secret and verifies without saving or applying", async () => {
  await show(); const secret = container.querySelector('[aria-label="飞书 App Secret"]') as HTMLInputElement;
  expect(secret.type).toBe("password"); expect(secret.value).toBe("");
  expect((container.querySelector('[aria-label="飞书 App ID"]') as HTMLInputElement).readOnly).toBe(true);
  await input("飞书 App Secret", "fixture-new-secret"); await click("仅验证凭据");
  expect(api.testChannelConnection).toHaveBeenCalledWith("feishu", "fixture-revision", { appId: "cli_fixture", appSecret: "fixture-new-secret" });
  expect(change).not.toHaveBeenCalled(); expect(container.textContent).toContain("没有保存配置或发送消息");
});
it("saves credential fields only and clears the password after success", async () => {
  await show(); await input("飞书 App Secret", "fixture-new-secret"); await click("验证并保存凭据");
  expect(change).toHaveBeenCalledWith("/connections/feishu", "PUT", { appId: "cli_fixture", appSecret: "fixture-new-secret" });
  expect((container.querySelector('[aria-label="飞书 App Secret"]') as HTMLInputElement).value).toBe(""); expect(dirty).toHaveBeenLastCalledWith(false);
});
it("keeps the input after a failed save and blocks conflicting access edits", async () => {
  change.mockRejectedValueOnce(new Error("revision conflict"));
  await show(); await input("飞书 App Secret", "fixture-new-secret"); await click("验证并保存凭据");
  expect((container.querySelector('[aria-label="飞书 App Secret"]') as HTMLInputElement).value).toBe("fixture-new-secret");
  await show(value, true); expect([...container.querySelectorAll("button")].find((el) => el.textContent?.includes("验证并保存"))!.disabled).toBe(true);
  expect(container.textContent).toContain("访问设置有未保存");
});
it("applies saved settings separately and explains active-run protection", async () => {
  await show({ ...value, connection: { ...value.connection!, state: "pending", message: "新配置待应用" } });
  await click("应用连接"); expect(change).toHaveBeenCalledWith("/connections/feishu/apply", "POST", {});
  await show({ ...value, connection: { ...value.connection!, state: "pending", blockedReason: "任务尚未结束" } });
  expect([...container.querySelectorAll("button")].find((el) => el.textContent === "应用连接")!.disabled).toBe(true);
  expect(container.textContent).toContain("任务尚未结束");
});
it("tests the current environment-managed connection without sending editable values", async () => {
  await show({ ...value, connection: { ...value.connection!, environmentManaged: true } });
  expect((container.querySelector('[aria-label="飞书 App Secret"]') as HTMLInputElement).disabled).toBe(true);
  await click("仅验证凭据"); expect(api.testChannelConnection).toHaveBeenCalledWith("feishu", "fixture-revision", {});
});
it("keeps Telegram token entry private and displays verification failures", async () => {
  await show({ ...value, channel: "telegram", connection: { ...value.connection!, state: "pending" } });
  await input("Telegram Bot Token", "12345:fixture_new_token");
  vi.mocked(api.testChannelConnection).mockRejectedValueOnce(new Error("Telegram凭据无效")); await click("仅验证凭据");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Telegram凭据无效");
  expect(container.textContent).not.toContain("12345:fixture_new_token"); expect(change).not.toHaveBeenCalled();
});
