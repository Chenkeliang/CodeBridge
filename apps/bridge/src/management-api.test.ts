import { ChannelConnections } from "./channel-connections.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify, parse } from "yaml";
import { ConfigStore, defaultConfig } from "@codebridge/core";
import { createManagementApp } from "./management-api.js";
import { LocalTaskManager } from "./managed-local-tasks.js";
import { ManagedRunbooks } from "./managed-runbooks.js";
import { FeishuAlertMonitor } from "./feishu-alert-monitor.js";

const keys = vi.hoisted(() => new Map<string, string>());
vi.mock("@codebridge/core", async (original) => {
  const real = await original<typeof import("@codebridge/core")>();
  return { ...real, storeKeychainSecret: (service: string, value: string) => keys.set(service, value),
    resolveSecretRef: (ref: string, options?: Parameters<typeof real.resolveSecretRef>[1]) => ref.startsWith("keychain:") ? keys.get(ref.slice(9))! : real.resolveSecretRef(ref, options) };
});
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); keys.clear(); roots.splice(0).forEach((p) => fs.rmSync(p, { recursive: true, force: true })); });
function fixture(connectionFactory?: (store: ConfigStore) => ChannelConnections) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-management-test-")); roots.push(root);
  const dataDir = path.join(root, "data"); fs.mkdirSync(dataDir);
  const skill = path.join(root, "skills", "fixture-rules"); fs.mkdirSync(path.join(skill, "references"), { recursive: true });
  const runbook = path.join(skill, "SKILL.md");
  fs.writeFileSync(runbook, "---\nname: fixture-rules\ndescription: Synthetic test instructions\n---\nRead [matrix](references/matrix.md).\n");
  fs.writeFileSync(path.join(skill, "references/matrix.md"), "# Synthetic matrix\n");
  const config = defaultConfig(); config.feishu = { ...config.feishu, appId: "cli_fixture", appSecret: "env:UNIT_FEISHU_SECRET", policy: { ...config.feishu.policy!, groupAllowlist: ["oc_fixture"] },
    alertMonitor: { enabled: true, pollIntervalMs: 30_000, lookbackMs: 600_000, dedupWindowMs: 1_800_000, maxConcurrent: 2, incidentRetentionMs: 604_800_000,
      groups: [{ chatId: "oc_fixture", senderAppIds: ["cli_fixture_alarm"], approverOpenIds: ["ou_fixture_old"], runbookPath: runbook }] } };
  config.runner.token = "env:UNIT_RUNNER_SECRET";
  config.telegram = { botToken: "env:UNIT_TELEGRAM_SECRET", allowedUsers: ["101"], allowedChats: ["-202"], pollingTimeoutSec: 25 };
  fs.writeFileSync(path.join(dataDir, "config.yaml"), stringify(config), { mode: 0o600 });
  const token = "fixture-management-runner";
  const store = new ConfigStore({ dataDir, secrets: { platform: "darwin", run: (_file, args, input) => {
    if (args[0] === "-i") { const match = input!.match(/-s ([A-Za-z0-9._-]+) -a codebridge -w "([^"]+)"/)!; keys.set(match[1]!, match[2]!); return ""; }
    if (args[0] === "find-generic-password") return keys.get(args[args.indexOf("-s") + 1]!) ?? "";
    return "";
  }, env: { UNIT_FEISHU_SECRET: "fixture-feishu-secret", UNIT_RUNNER_SECRET: token, UNIT_TELEGRAM_SECRET: "fixture-telegram-secret" } } });
  const members = vi.fn().mockResolvedValue([{ id: "ou_fixture_new", name: "Fixture member" }]);
  const chats = vi.fn().mockResolvedValue([{ id: "oc_fixture", name: "Fixture group" }, { id: "oc_other", name: "Other group" }]);
  const sources = vi.fn().mockResolvedValue([{ id: "cli_fixture_alarm", preview: "Synthetic alarm" }]);
  const app = createManagementApp({ dataDir, store, token, members, chats, sources, connections: connectionFactory?.(store), local: new LocalTaskManager({ dataDir, home: root, platform: "darwin", run: vi.fn(() => "") }), runbooks: new ManagedRunbooks(dataDir) });
  const request = (url: string, method = "GET", body?: unknown, revision?: string, origin?: string) => app.request(`/v1/management${url}`, { method,
    headers: { authorization: `Bearer ${token}`, ...(revision ? { "if-match": revision } : {}), ...(origin ? { origin } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const snapshot = async () => (await request("")).json() as Promise<any>;
  return { root, dataDir, store, app, members, chats, sources, request, snapshot, runbook };
}

describe("local channel/task management", () => {
  it("requires bearer authentication and never returns resolved credentials", async () => {
    const f = fixture(); expect((await f.app.request("/v1/management")).status).toBe(401);
    const response = await f.request(""); expect(response.status).toBe(200);
    const text = await response.text();
    for (const secret of ["fixture-feishu-secret", "fixture-telegram-secret", "fixture-management-runner"]) expect(text).not.toContain(secret);
    expect(JSON.parse(text).channels[0].allowedChats).toEqual(["oc_fixture"]);
  });
  it("edits channel-scoped roles, preserves unrelated fields/references, and rejects stale writes", async () => {
    const f = fixture(), before = await f.snapshot();
    const body = { ...before.channels[0], administrators: ["ou_fixture_new"], allowedChats: ["oc_fixture"] };
    const saved = await f.request("/channels/feishu", "PATCH", body, before.revision); expect(saved.status).toBe(200);
    expect(f.store.get().access?.admins).toEqual(["ou_fixture_new"]);
    expect(f.store.get().telegram?.allowedUsers).toEqual(["101"]);
    expect(f.store.get().feishu.alertMonitor?.groups[0]?.runbookPath).toBe(f.runbook);
    expect(fs.readFileSync(f.store.path, "utf8")).toContain("env:UNIT_FEISHU_SECRET");
    expect((await f.request("/channels/feishu", "PATCH", body, before.revision)).status).toBe(409);
  });
  it("rejects cross-origin writes, unknown channels and identities from the wrong channel", async () => {
    const f = fixture(), before = await f.snapshot();
    expect((await f.request("/channels/feishu", "PATCH", before.channels[0], before.revision, "https://untrusted.example")).status).toBe(403);
    expect((await f.request("/channels/telegram", "PATCH", { ...before.channels[1], administrators: ["ou_fixture"] }, before.revision)).status).toBe(400);
    expect((await f.request("/channels/unknown", "PATCH", {}, before.revision)).status).toBe(404);
    expect(f.store.get().telegram?.allowedUsers).toEqual(["101"]);
  });
  it("rejects a concurrent save with the same configuration revision", async () => {
    const f = fixture(), before = await f.snapshot();
    const responses = await Promise.all(["ou_first", "ou_second"].map((id) => f.request("/channels/feishu", "PATCH", { ...before.channels[0], administrators: [id] }, before.revision)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  });
  it("reloads external edits before returning a revision or saving", async () => {
    const f = fixture(); const disk = parse(fs.readFileSync(f.store.path, "utf8"));
    disk.backends.codex.model = "fixture-model"; fs.writeFileSync(f.store.path, stringify(disk));
    const fresh = await f.snapshot();
    expect((await f.request("/channels/feishu", "PATCH", fresh.channels[0], fresh.revision)).status).toBe(200);
    expect(f.store.get().backends.codex?.model).toBe("fixture-model");
  });
  it("only reads members of configured groups and does not infer cross-app roles", async () => {
    const f = fixture(); expect((await f.request("/feishu/members/oc_unknown")).status).toBe(403);
    expect(f.members).not.toHaveBeenCalled();
    expect((await f.request("/feishu/members/oc_fixture")).status).toBe(200);
    expect(f.members).toHaveBeenCalledWith("oc_fixture");
  });
  it("preserves incident state, the external Skill and current approver revocation", async () => {
    const f = fixture(), before = await f.snapshot();
    const statePath = path.join(f.dataDir, "feishu-alert-monitor.json");
    const alert = { messageId: "om_fixture", chatId: "oc_fixture", createdAt: 1, senderId: "cli_fixture_alarm", senderType: "app", content: "Synthetic incident" };
    fs.writeFileSync(statePath, JSON.stringify({ oc_fixture: { cursor: 100, activatedAt: 1, seen: {}, incidents: { om_fixture: {
      alert, ownerOpenId: "ou_fixture_old", approverOpenIds: ["ou_fixture_old"], fingerprint: "fixture", lastSeen: 100,
      submitted: true, active: false, replies: [], runbookPath: f.runbook, status: "waiting",
    } } } }));
    const original = fs.readFileSync(statePath, "utf8"), rule = fs.readFileSync(f.runbook, "utf8");
    const response = await f.request("/alerts/oc_fixture", "PUT", { ...before.alerts[0], approverOpenIds: ["ou_fixture_new"], enabled: false }, before.revision);
    expect(response.status).toBe(200); expect(fs.readFileSync(statePath, "utf8")).toBe(original); expect(fs.readFileSync(f.runbook, "utf8")).toBe(rule);
    const monitor = new FeishuAlertMonitor({ statePath, config: () => f.store.get().feishu.alertMonitor,
      transport: { readAlertMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }), investigateAlert: vi.fn(), isAlertActive: vi.fn().mockResolvedValue(false) }, log: vi.fn() });
    const message = { messageId: "om_reply", chatId: "oc_fixture", chatType: "group" as const, senderId: "ou_fixture_old", content: "/approve", rootId: "om_fixture" };
    expect((await monitor.prepareReply(message, "om_fixture"))?.allowed).toBe(false);
    expect((await monitor.prepareReply({ ...message, senderId: "ou_fixture_new" }, "om_fixture"))?.allowed).toBe(true);
  });
  it("keeps reconciling existing incident reactions after new collection is disabled", async () => {
    const f = fixture();
    f.store.update((config) => { config.feishu.alertMonitor!.groups[0]!.enabled = false; return config; });
    const statePath = path.join(f.dataDir, "feishu-alert-monitor.json");
    fs.writeFileSync(statePath, JSON.stringify({ oc_fixture: { cursor: 100, activatedAt: 1, seen: {}, incidents: { om_fixture: {
      alert: { messageId: "om_fixture", chatId: "oc_fixture", createdAt: 1, senderId: "cli_fixture_alarm", senderType: "app", content: "Synthetic incident" },
      ownerOpenId: "ou_fixture_old", approverOpenIds: ["ou_fixture_old"], fingerprint: "fixture", lastSeen: 100, submitted: true, active: false, replies: [], status: "waiting",
    } } } }));
    const readAlertDone = vi.fn().mockResolvedValue(undefined), readAlertMessages = vi.fn();
    const monitor = new FeishuAlertMonitor({ statePath, config: () => f.store.get().feishu.alertMonitor,
      transport: { readAlertDone, readAlertMessages, investigateAlert: vi.fn(), isAlertActive: vi.fn().mockResolvedValue(false) }, log: vi.fn() });
    await monitor.tick();
    expect(readAlertMessages).not.toHaveBeenCalled(); expect(readAlertDone).toHaveBeenCalledWith("om_fixture", undefined);
  });
  it("validates Skill layout before accepting alert changes", async () => {
    const f = fixture(), before = await f.snapshot();
    const response = await f.request("/alerts/oc_fixture", "PUT", { ...before.alerts[0], runbookPath: path.join(f.root, "missing.md") }, before.revision);
    expect(response.status).toBe(400); expect(f.store.get().feishu.alertMonitor?.groups[0]?.runbookPath).toBe(f.runbook);
    expect((await f.request("/alerts/oc_fixture/rules")).status).toBe(200);
    expect((await f.request("/alerts/oc_fixture/rules?file=../../../outside.md")).status).toBe(400);
  });
  it("enables one alert in a globally paused monitor without enabling other groups", async () => {
    const f = fixture();
    f.store.update((config) => { config.feishu.alertMonitor!.enabled = false;
      config.feishu.alertMonitor!.groups.push({ chatId: "oc_other", senderAppIds: ["cli_other"], approverOpenIds: ["ou_other"] }); return config; });
    const before = await f.snapshot();
    expect(before.alerts.every((group: { enabled: boolean }) => !group.enabled)).toBe(true);
    const response = await f.request("/alerts/oc_fixture", "PUT", { ...before.alerts[0], enabled: true }, before.revision);
    expect(response.status).toBe(200);
    const after = await response.json() as any;
    expect(after.alerts.find((group: { chatId: string }) => group.chatId === "oc_fixture").enabled).toBe(true);
    expect(after.alerts.find((group: { chatId: string }) => group.chatId === "oc_other").enabled).toBe(false);
  });
  it("changes publisher destinations without rotating the caller token", async () => {
    const f = fixture(); const token = "fixture-publisher-value-unchanged";
    keys.set("fixture-publisher", token);
    fs.writeFileSync(path.join(f.dataDir, "publisher-tokens.json"), JSON.stringify([{ label: "fixture-report", token: "keychain:fixture-publisher", chatId: "oc_fixture", routes: ["markdown"] }]), { mode: 0o600 });
    const before = await f.snapshot();
    expect((await f.request("/publishers/fixture-report", "PATCH", { chatId: "telegram:-202", routes: ["markdown", "mention"] }, before.revision)).status).toBe(200);
    const disk = JSON.parse(fs.readFileSync(path.join(f.dataDir, "publisher-tokens.json"), "utf8"));
    expect(disk[0].token).toMatch(/^keychain:/); expect(keys.get(disk[0].token.slice(9))).toBe(token);
    expect(JSON.stringify(await f.snapshot())).not.toContain(token);
  });
});

it("round-trips group reply exceptions through the canonical policy", async () => {
  const f = fixture();
  f.store.update((config) => { config.feishu.policy!.scenarios = [{ name: "Fixture group", chats: ["oc_fixture"], requireMention: false }]; return config; });
  const before = await f.snapshot();
  expect(before.channels[0].scenarios).toEqual([{ name: "Fixture group", chats: ["oc_fixture"], requireMention: false }]);
  const response = await f.request("/channels/feishu", "PATCH", { ...before.channels[0], scenarios: [] }, before.revision);
  expect(response.status).toBe(200);
  expect(f.store.get().feishu.policy!.scenarios).toEqual([]);
});
it("rejects invalid reply exceptions without modifying configuration", async () => {
  const f = fixture(), before = await f.snapshot();
  for (const scenarios of [[{ name: "Invalid", chats: ["telegram:-1"], requireMention: false }],
    [{ name: "Invalid", chats: ["oc_fixture"], requireMention: "false" }], [{ name: "Invalid", chats: [], requireMention: false }]]) {
    expect((await f.request("/channels/feishu", "PATCH", { ...before.channels[0], scenarios }, before.revision)).status).toBe(400);
  }
});
it("saves responsible people independently and uses current recipients for existing incidents", async () => {
  const f = fixture(), before = await f.snapshot();
  const response = await f.request("/alerts/oc_fixture", "PUT", { ...before.alerts[0], responsibleOpenIds: ["ou_responsible"] }, before.revision);
  expect(response.status).toBe(200);
  expect((await response.json() as any).alerts[0].responsibleOpenIds).toEqual(["ou_responsible"]);
  expect(f.store.get().feishu.alertMonitor!.groups[0]!.approverOpenIds).toEqual(["ou_fixture_old"]);
  const statePath = path.join(f.dataDir, "responsibility-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ oc_fixture: { cursor: 100, activatedAt: 1, seen: {}, incidents: { om_fixture: {
    alert: { messageId: "om_fixture", chatId: "oc_fixture", createdAt: 1, senderId: "cli_fixture_alarm", senderType: "app", content: "Synthetic failure" },
    ownerOpenId: "ou_fixture_old", fingerprint: "fixture", lastSeen: 100, submitted: true, active: false, replies: [], status: "waiting",
  } } } }));
  const notifyAlertOwner = vi.fn();
  const monitor = new FeishuAlertMonitor({ statePath, config: () => f.store.get().feishu.alertMonitor, transport: {
    readAlertMessages: vi.fn(), investigateAlert: vi.fn(), isAlertActive: vi.fn(), notifyAlertOwner,
  }, log: vi.fn() });
  await monitor.setStatus("oc_fixture", "om_fixture", "blocked", "Synthetic failure");
  expect(notifyAlertOwner).toHaveBeenLastCalledWith("oc_fixture", "om_fixture", ["ou_responsible"], expect.any(String));
  const next = await f.snapshot();
  await f.request("/alerts/oc_fixture", "PUT", { ...next.alerts[0], responsibleOpenIds: ["ou_next"] }, next.revision);
  await monitor.setStatus("oc_fixture", "om_fixture", "blocked", "Synthetic failure");
  expect(notifyAlertOwner).toHaveBeenLastCalledWith("oc_fixture", "om_fixture", ["ou_next"], expect.any(String));
  await monitor.setStatus("oc_fixture", "om_fixture", "waiting", "Synthetic decision");
  expect(notifyAlertOwner).toHaveBeenLastCalledWith("oc_fixture", "om_fixture", ["ou_fixture_old"], expect.any(String));
  expect((await monitor.prepareReply({ messageId: "om_answer", chatId: "oc_fixture", chatType: "group", senderId: "ou_next", content: "/approve" }, "om_fixture"))?.allowed).toBe(false);
  const last = await f.snapshot();
  expect((await f.request("/alerts/oc_fixture", "PUT", { ...last.alerts[0], responsibleOpenIds: [] }, last.revision)).status).toBe(400);
});

it("does not replay legacy notifications merely because the application was upgraded", async () => {
  const f = fixture(), statePath = path.join(f.dataDir, "legacy-notice.json");
  fs.writeFileSync(statePath, JSON.stringify({ oc_fixture: { cursor: 100, activatedAt: 1, seen: {}, incidents: { om_fixture: {
    alert: { messageId: "om_fixture", chatId: "oc_fixture", createdAt: 1, senderId: "cli_fixture_alarm", senderType: "app", content: "Synthetic failure" },
    ownerOpenId: "ou_fixture_old", fingerprint: "fixture", lastSeen: 100, submitted: true, active: false, replies: [], status: "blocked", summary: "Legacy summary",
    ownerNotice: JSON.stringify(["blocked", "Legacy summary"]),
  } } } }));
  const notifyAlertOwner = vi.fn();
  const monitor = new FeishuAlertMonitor({ statePath, config: () => f.store.get().feishu.alertMonitor, transport: {
    readAlertMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }), investigateAlert: vi.fn(), isAlertActive: vi.fn(), notifyAlertOwner,
  }, log: vi.fn() });
  await monitor.tick();
  expect(notifyAlertOwner).not.toHaveBeenCalled();
});

it("discovers named bot groups without expanding existing allowed chats", async () => {
  const f = fixture();
  const response = await f.request("/feishu/chats");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ chats: [{ id: "oc_fixture", name: "Fixture group" }] });
  expect(f.store.get().feishu.policy!.groupAllowlist).toEqual(["oc_fixture"]);
  f.store.update((config) => { config.access = { allowedChats: ["oc_other"] }; return config; });
  expect((await (await f.request("/feishu/chats")).json() as any).chats).toEqual([]);
});
it("loads members and observed bot sources for a joined group when chat access is open", async () => {
  const f = fixture(); f.store.update((config) => { config.feishu.policy!.groupAllowlist = []; return config; });
  expect((await f.request("/feishu/members/oc_other")).status).toBe(200);
  const response = await f.request("/feishu/sources/oc_other");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sources: [{ id: "cli_fixture_alarm", preview: "Synthetic alarm" }] });
  expect((await f.request("/feishu/sources/oc_unknown")).status).toBe(403);
  expect(f.sources).toHaveBeenCalledTimes(1);
});
it("rejects unsupported alert channels instead of saving them as Feishu", async () => {
  const f = fixture(), before = await f.snapshot();
  expect((await f.request("/alerts/oc_fixture", "PUT", { ...before.alerts[0], channel: "telegram" }, before.revision)).status).toBe(400);
  expect(f.store.get().feishu.alertMonitor!.groups[0]!.senderAppIds).toEqual(["cli_fixture_alarm"]);
});
it("reports discovery errors without changing saved identities", async () => {
  const f = fixture(); f.chats.mockRejectedValueOnce(new Error("Missing chat read permission"));
  const response = await f.request("/feishu/chats");
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(await response.text()).toContain("Missing chat read permission");
  expect(f.store.get().feishu.alertMonitor!.groups[0]!.approverOpenIds).toEqual(["ou_fixture_old"]);
});

it("applies both chat restrictions to direct member and source requests", async () => {
  const f = fixture();
  f.store.update((config) => { config.access = { allowedChats: ["oc_other"] }; return config; });
  expect((await f.request("/feishu/members/oc_fixture")).status).toBe(403);
  expect((await f.request("/feishu/sources/oc_fixture")).status).toBe(403);
  expect(f.members).not.toHaveBeenCalled(); expect(f.sources).not.toHaveBeenCalled();
});

it("exposes verification/save metadata without returning credentials and preserves revision checks", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const f = fixture(), before = await f.snapshot();
  const original = fs.readFileSync(f.store.path, "utf8");
  const tested = await f.request("/connections/feishu/test", "POST", { appSecret: "fixture-new-secret" }, before.revision);
  expect(tested.status).toBe(200); expect(await tested.text()).not.toContain("fixture-new-secret");
  expect(fs.readFileSync(f.store.path, "utf8")).toBe(original);
  fetch.mockResolvedValue(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
  const saved = await f.request("/connections/feishu", "PUT", { appSecret: "fixture-new-secret" }, before.revision);
  expect(saved.status).toBe(200); const result = await saved.text();
  for (const secret of ["fixture-new-secret", "fixture-feishu-secret", "fixture-management-runner"]) expect(result).not.toContain(secret);
  expect(JSON.parse(result).channels[0].connection.state).toBe("pending");
  expect(fs.readFileSync(f.store.path, "utf8")).toContain("keychain:");
  expect((await f.request("/connections/feishu", "PUT", { appSecret: "fixture-next-secret" }, before.revision)).status).toBe(409);
});
it("checks revision freshness after an asynchronous credential verification", async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })); vi.stubGlobal("fetch", fetch);
  const f = fixture(), before = await f.snapshot();
  const pending = f.request("/connections/feishu", "PUT", { appSecret: "fixture-new-secret" }, before.revision);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  f.store.update((config) => ({ ...config, defaultBackend: "codex" }));
  finish(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
  expect((await pending).status).toBe(409); expect(f.store.get().feishu.appSecret).toBe("fixture-feishu-secret");
});
it("rejects unsafe management hosts and does not test credentials or return state", async () => {
  const f = fixture(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const response = await f.app.request("http://attacker.example/v1/management", { headers: { authorization: "Bearer fixture-management-runner" } });
  expect(response.status).toBe(403); expect(await response.text()).not.toContain("oc_fixture"); expect(fetch).not.toHaveBeenCalled();
});

it("completes verification, save and activation through the actual management contract", async () => {
  let connected = false;
  const connect = vi.fn(async () => { connected = true; });
  const fetch = vi.fn(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }));
  const f = fixture((store) => {
    const adapter = { get isConnected() { return connected; }, displayName: "Fixture runtime bot", connect,
      disconnect: vi.fn(async () => { connected = false; }), updateConfig: vi.fn(), setSessionIngress: vi.fn() };
    const service = new ChannelConnections({ store, fetch: fetch as typeof globalThis.fetch, initial: { feishu: adapter }, create: () => adapter });
    service.bindIngress({ submit: vi.fn() } as never); store.onChange(() => service.syncConfig()); return service;
  });
  const before = await f.snapshot(); expect(before.channels[0].connection.state).toBe("disconnected");
  const saved = await f.request("/connections/feishu", "PUT", { appSecret: "fixture-runtime-secret" }, before.revision);
  expect(saved.status).toBe(200); const snapshot = await saved.json() as any;
  expect(snapshot.channels[0].connection.state).toBe("pending"); expect(connect).not.toHaveBeenCalled();
  const applied = await f.request("/connections/feishu/apply", "POST", {}, snapshot.revision);
  expect(applied.status).toBe(200); expect(connect).toHaveBeenCalledOnce();
  const status = await (await f.request("/connections")).json() as any;
  expect(status.channels[0]).toMatchObject({ configured: true, connected: true, connection: { state: "connected", identity: "Fixture runtime bot" } });
  expect(JSON.stringify(status)).not.toContain("fixture-runtime-secret");
});
