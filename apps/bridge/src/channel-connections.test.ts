import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { ConfigStore, defaultConfig, type AppConfig, type ChannelSessionIngress } from "@codebridge/core";
import { ChannelConnections, type ManagedChannelAdapter } from "./channel-connections.js";

const roots: string[] = [];
beforeEach(() => { for (const name of ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "TELEGRAM_BOT_TOKEN"]) vi.stubEnv(name, ""); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })); });
function adapter() {
  let connected = true;
  return { get isConnected() { return connected; }, displayName: "Fixture bot",
    connect: vi.fn(async () => { connected = true; }), disconnect: vi.fn(async () => { connected = false; }),
    updateConfig: vi.fn((_config: AppConfig) => {}), setSessionIngress: vi.fn(),
  } satisfies ManagedChannelAdapter;
}
function fixture(fresh = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-connections-")); roots.push(root);
  const keys = new Map<string, string>();
  const run = vi.fn((_file: string, args: string[], input?: string) => {
    if (args[0] === "-i") { const match = input!.match(/-s ([A-Za-z0-9._-]+) -a codebridge -w "([^"]+)"/)!; keys.set(match[1]!, match[2]!); return ""; }
    if (args[0] === "find-generic-password") return keys.get(args[args.indexOf("-s") + 1]!) ?? "";
    return "";
  });
  const config = defaultConfig(); config.runner.token = "env:UNIT_RUNNER";
  if (!fresh) { config.feishu = { ...config.feishu, appId: "cli_fixture", appSecret: "env:UNIT_FEISHU" };
    config.telegram = { botToken: "env:UNIT_TELEGRAM", allowedUsers: ["101"], pollingTimeoutSec: 25 }; }
  fs.writeFileSync(path.join(root, "config.yaml"), stringify(config));
  const store = new ConfigStore({ dataDir: root, secrets: { platform: "darwin", run, env: { UNIT_RUNNER: "fixture-runner-value", UNIT_FEISHU: "fixture-old-secret", UNIT_TELEGRAM: "12345:fixture_old_token" } } });
  const fetch = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("telegram.org")
    ? { ok: true, result: { id: 12345, username: "fixture_bot" } } : { code: 0, msg: "ok" }), { status: 200 }));
  const previous = adapter(), next = adapter(), busy = vi.fn(() => false), changed = vi.fn(async () => {});
  const create = vi.fn(() => next);
  const service = new ChannelConnections({ store, fetch: fetch as typeof globalThis.fetch, initial: fresh ? {} : { feishu: previous }, create, hasActiveRuns: busy, changed });
  const submit = vi.fn(async () => ({ sessionId: "fixture-session" }));
  const ingress = service.bindIngress({ submit } as unknown as ChannelSessionIngress);
  store.onChange(() => service.syncConfig());
  return { root, keys, run, store, fetch, previous, next, busy, changed, create, service, ingress, submit };
}

describe("channel connection lifecycle", () => {
  it("verifies without writing, then stores a reference while keeping the old connection credentials active", async () => {
    const f = fixture(), before = fs.readFileSync(f.store.path, "utf8"), check = vi.fn();
    const body = { appId: "cli_fixture", appSecret: "fixture-new-secret" };
    await expect(f.service.test("feishu", body)).resolves.toMatchObject({ valid: true, identity: "cli_fixture" });
    expect(fs.readFileSync(f.store.path, "utf8")).toBe(before);
    await f.service.save("feishu", body, check); expect(check).toHaveBeenCalledOnce();
    expect(fs.readFileSync(f.store.path, "utf8")).toContain("keychain:"); expect(fs.readFileSync(f.store.path, "utf8")).not.toContain(body.appSecret);
    expect(f.store.get().feishu.appSecret).toBe(body.appSecret);
    expect(f.service.activeConfig("feishu").feishu.appSecret).toBe("fixture-old-secret");
    expect(f.service.metadata("feishu").connection.state).toBe("pending");
    expect(JSON.stringify(f.service.metadata("feishu"))).not.toContain("fixture-new-secret");
    await f.service.apply("feishu");
    expect(f.previous.disconnect).toHaveBeenCalledOnce(); expect(f.next.connect).toHaveBeenCalledOnce();
    expect(f.service.metadata("feishu")).toMatchObject({ connected: true, connection: { state: "connected" } });
  });
  it("keeps a blank secret and its original reference", async () => {
    const f = fixture(), before = f.store.diskSecret("feishu.appSecret");
    await f.service.save("feishu", { appId: "cli_fixture", appSecret: "" }, () => {});
    expect(f.store.diskSecret("feishu.appSecret")).toBe(before); expect(f.keys.size).toBe(0);
  });
  it("does not write invalid credentials and masks returned provider errors", async () => {
    const f = fixture(), before = fs.readFileSync(f.store.path, "utf8");
    f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 100, msg: "invalid fixture-new-secret" }), { status: 401 }));
    await expect(f.service.save("feishu", { appSecret: "fixture-new-secret" }, () => {})).rejects.toThrow("[REDACTED]");
    expect(fs.readFileSync(f.store.path, "utf8")).toBe(before); expect(f.keys.size).toBe(0);
  });
  it("keeps the original config when Keychain persistence fails", async () => {
    const f = fixture(), before = fs.readFileSync(f.store.path, "utf8");
    f.run.mockImplementation(() => { throw new Error("fixture-new-secret should never be returned"); });
    await expect(f.service.save("feishu", { appSecret: "fixture-new-secret" }, () => {})).rejects.toThrow("原配置保持不变");
    expect(fs.readFileSync(f.store.path, "utf8")).toBe(before); expect(f.store.get().feishu.appSecret).toBe("fixture-old-secret");
  });
  it("checks the revision again after validation without storing a stale draft", async () => {
    const f = fixture(), before = fs.readFileSync(f.store.path, "utf8");
    await expect(f.service.save("feishu", { appSecret: "fixture-new-secret" }, () => { throw new Error("revision conflict"); })).rejects.toThrow("revision conflict");
    expect(fs.readFileSync(f.store.path, "utf8")).toBe(before); expect(f.keys.size).toBe(0);
  });
  it("does not overwrite direct environment-managed credentials or change account identity", async () => {
    const f = fixture(); vi.stubEnv("FEISHU_APP_SECRET", "fixture-direct-override");
    await expect(f.service.save("feishu", { appSecret: "fixture-new-secret" }, () => {})).rejects.toThrow("环境变量");
    expect(f.fetch).not.toHaveBeenCalled(); vi.stubEnv("FEISHU_APP_SECRET", "");
    await expect(f.service.test("feishu", { appId: "cli_other" })).rejects.toThrow("身份迁移");
    await expect(f.service.test("telegram", { botToken: "99999:fixture_other_bot" })).rejects.toThrow("消息游标");
    await expect(f.service.test("feishu", { domain: "https://attacker.example" })).rejects.toThrow("字段无效"); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("creates a first channel from the Web but keeps Telegram allowlist protection", async () => {
    const f = fixture(true);
    await f.service.save("telegram", { botToken: "12345:fixture_new_token" }, () => {});
    await expect(f.service.apply("telegram")).rejects.toThrow("允许的成员");
    f.store.update((current) => ({ ...current, telegram: { ...current.telegram!, allowedUsers: ["101"] } }));
    await f.service.apply("telegram"); expect(f.next.connect).toHaveBeenCalledOnce();
    expect(f.service.metadata("telegram")).toMatchObject({ configured: true, connected: true, connection: { state: "connected" } });
  });
  it("refuses to switch a connection while accepted or in-flight submissions exist", async () => {
    const f = fixture(); f.busy.mockReturnValue(true);
    await expect(f.service.apply("feishu")).rejects.toThrow("当前连接未中断"); expect(f.previous.disconnect).not.toHaveBeenCalled();
    f.busy.mockReturnValue(false);
    let release!: (value: { sessionId: string }) => void;
    f.submit.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.ingress.submit({ channel: "feishu" } as never);
    await expect(f.service.apply("feishu")).rejects.toThrow("当前连接未中断"); expect(f.previous.disconnect).not.toHaveBeenCalled();
    release({ sessionId: "fixture-session" }); await pending;
  });
  it("blocks new channel submissions during apply without starting business work", async () => {
    const f = fixture(); let release!: () => void;
    f.next.connect.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const applying = f.service.apply("feishu"); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(f.ingress.submit({ channel: "feishu" } as never)).rejects.toThrow("尚未提交执行"); expect(f.submit).not.toHaveBeenCalled();
    release(); await applying;
  });
  it("restores the old adapter and applied credentials after a failed activation hook", async () => {
    const f = fixture(); await f.service.save("feishu", { appSecret: "fixture-new-secret" }, () => {});
    f.changed.mockRejectedValueOnce(new Error("fixture-new-secret must not leak"));
    await expect(f.service.apply("feishu")).rejects.toThrow("已恢复旧连接");
    expect(f.service.activeConfig("feishu").feishu.appSecret).toBe("fixture-old-secret");
    expect(f.service.metadata("feishu").connected).toBe(true); expect(JSON.stringify(f.service.metadata("feishu"))).not.toContain("fixture-new-secret");
  });
});

it("keeps an offline startup repairable and clears the error after a real connection succeeds", async () => {
  const f = fixture(); await f.previous.disconnect(); f.service.noteStartupFailure("feishu");
  expect(f.service.metadata("feishu")).toMatchObject({ connected: false, connection: { state: "error" } });
  await f.service.apply("feishu"); expect(f.service.metadata("feishu")).toMatchObject({ connected: true, connection: { state: "connected" } });
});
it("does not create a second client if stopping the old client fails", async () => {
  const f = fixture(); f.previous.disconnect.mockRejectedValueOnce(new Error("uncertain shutdown"));
  await expect(f.service.apply("feishu")).rejects.toThrow("尚未创建新连接"); expect(f.create).not.toHaveBeenCalled();
});
