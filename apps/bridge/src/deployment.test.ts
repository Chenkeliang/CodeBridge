import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeploymentService, hasPublishIntent, mountDeploymentRoutes, parseDeploymentCommand } from "./deployment.js";
import { createOutboundApp } from "./outbound-api.js";
import type { SqliteEventStore } from "@codebridge/work-items";
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function setup(config: object = { token: "secret", ownerOpenId: "ou_owner" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-test-")); directories.push(dir);
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ message: "正在准备" })));
  return { dir, configPath, request, service: new DeploymentService({ configPath, fetch: request }) };
}
const message = { senderId: "ou_owner", messageId: "om_native", chatId: "oc_chat", chatType: "p2p" as const, content: "准备发布" };
describe("deployment ingress", () => {
  it.each(["不要上线", "先别发布", "解释一下‘上线’", "把提示词改成上线", "修改菜单，测好后上线", '"上线"', "constructor", "toString", "请不要上线吧", "帮我解释上线", "上线后改菜单", "‘上线’？"])("preserves ordinary text %s", (text) => {
    expect(parseDeploymentCommand(text)).toBeUndefined();
  });
  it("parses only standalone commands", () => {
    expect(parseDeploymentCommand("测好后上线")).toEqual({ action: "prepare", publishAfterPrepare: true });
    expect(parseDeploymentCommand("上线了吗")).toEqual({ action: "status" });
    expect(parseDeploymentCommand("退回上一个版本")).toEqual({ action: "rollback" });
  });
  it("requires owner and sends native sender identity", async () => {
    const { service, request } = setup();
    expect(await service.handleFeishuMessage({ ...message, senderId: "ou_other" })).toContain("负责人");
    expect(request).not.toHaveBeenCalled();
    expect(await service.handleFeishuMessage(message)).toBe("正在准备");
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toMatchObject({ actorId: "ou_owner", chatId: "oc_chat", messageId: "om_native" });
  });
  it("lazily loads config and leaves unrelated messages alone", async () => {
    const { service, configPath } = setup(); fs.unlinkSync(configPath);
    expect(await service.handleFeishuMessage({ ...message, content: "你好" })).toBeUndefined();
    expect(await service.handleFeishuMessage(message)).toContain("没有配置");
    fs.writeFileSync(configPath, JSON.stringify({ token: "secret", ownerOpenId: "ou_owner" }));
    expect(await service.handleFeishuMessage(message)).toBe("正在准备");
  });
  it("binds only exact valid nonce once and writes private config", async () => {
    const { service, configPath } = setup({ token: "secret", pairingNonce: "nonce123" });
    expect(await service.handleFeishuMessage({ ...message, content: "开启安全发布 wrong" })).toContain("未通过");
    expect(await service.handleFeishuMessage({ ...message, content: "开启安全发布 nonce123" })).toContain("已绑定");
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({ token: "secret", ownerOpenId: "ou_owner" });
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });
  it("reports maintenance and controller failure without failing normal chat", async () => {
    const { service, request, dir } = setup();
    fs.writeFileSync(path.join(dir, "maintenance.json"), "{}");
    expect(service.isMaintenance()).toBe(true);
    request.mockRejectedValueOnce(new Error("offline"));
    expect(await service.handleFeishuMessage(message)).toContain("联系不上");
    expect(await service.handleFeishuMessage({ ...message, content: "继续解释代码" })).toBeUndefined();
  });
  it("recognizes positive final publish instruction but rejects negation/quoted prompts", () => {
    expect(hasPublishIntent("把菜单改好，测好后上线")).toBe(true);
    expect(hasPublishIntent("不要上线，改提示词为测好后上线")).toBe(false);
    expect(hasPublishIntent('把提示词改成“测好后上线”')).toBe(false);
  });
  it("inherits readiness authentication and rejects forged run context", async () => {
    const { service } = setup();
    const app = createOutboundApp({} as never, "runner-secret");
    mountDeploymentRoutes(app, service, { getRun: () => undefined } as unknown as SqliteEventStore);
    expect((await app.request("/deploy/readiness")).status).toBe(401);
    const response = await app.request("/deploy/readiness", { headers: { authorization: "Bearer runner-secret" } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, feishuConnected: false });
    expect((await app.request("/deploy/command", { method: "POST", headers: { authorization: "Bearer runner-secret", "content-type": "application/json" }, body: JSON.stringify({ action: "prepare", runId: "forged", actorId: "ou_owner" }) })).status).toBe(403);
  });
  it("requires native publish authorization even for a persisted owner run", async () => {
    const { service, request } = setup();
    const app = createOutboundApp({} as never, "runner-secret");
    const store = {
      getRun: () => ({ id: "run_1", turnId: "turn_1", status: "running" }),
      getTurn: () => ({ turnId: "turn_1", message: { actorRef: { channel: "feishu", id: "ou_owner" } } }),
      listDeliveries: () => [{ turnId: "turn_1", runId: "run_1", conversationId: "oc_chat|thread", replyToMessageId: "om_native" }],
    } as unknown as SqliteEventStore;
    mountDeploymentRoutes(app, service, store);
    const call = (publishAfterPrepare: boolean) => app.request("/deploy/command", {
      method: "POST", headers: { authorization: "Bearer runner-secret", "content-type": "application/json" },
      body: JSON.stringify({ action: "prepare", runId: "run_1", publishAfterPrepare, actorId: "ou_owner" }),
    });
    expect((await call(false)).status).toBe(403);
    await service.handleFeishuMessage({ ...message, content: "修改菜单，不要上线" });
    expect((await call(true)).status).toBe(403);
    expect(request).not.toHaveBeenCalled();
    expect((await call(false)).status).toBe(200);
    await service.handleFeishuMessage({ ...message, content: "修改菜单，测好后上线" });
    expect((await call(true)).status).toBe(200);
    expect(JSON.parse(request.mock.calls.at(-1)![1]!.body as string)).toMatchObject({ chatId: "oc_chat", actorId: "ou_owner", publishAfterPrepare: true });
  });

  it.each(["上线了吗？", "请上线了吗？", "帮我发布状态吧！"])("accepts bounded oral status command %s", (text) => {
    expect(parseDeploymentCommand(text)).toEqual({ action: "status" });
  });
  it("accepts polite publish commands without capturing embedded text", () => {
    expect(parseDeploymentCommand("请把刚才改的上线吧")).toEqual({ action: "publish" });
    expect(parseDeploymentCommand("帮我准备发布吧。 ")).toEqual({ action: "prepare" });
  });
  it("builds guidance from native text and names the configured source repo", async () => {
    const { service } = setup({ token: "secret", ownerOpenId: "ou_owner", sourceRepo: "/projects/CodeBridge-safe" });
    const store = {
      getRun: () => ({ id: "run_1", turnId: "turn_1" }),
      getTurn: () => ({ turnId: "turn_1", message: { text: "修改菜单，测好后上线\n[系统添加的说明]", actorRef: { channel: "feishu", id: "ou_owner" } } }),
      listDeliveries: () => [{ turnId: "turn_1", runId: "run_1", conversationId: "oc_chat|thread", replyToMessageId: "om_native" }],
    } as unknown as SqliteEventStore;
    expect(service.guidanceForRun("run_1", store)).toBe("");
    await service.handleFeishuMessage({ ...message, content: "修改菜单，测好后上线" });
    expect(service.guidanceForRun("run_1", store)).toContain("本轮已明确授权");
    expect(service.guidanceForRun("run_1", store)).toContain("/projects/CodeBridge-safe");
    await service.handleFeishuMessage({ ...message, content: "修改菜单，不要上线" });
    expect(service.guidanceForRun("run_1", store)).toContain("本轮未授权");
  });

});
