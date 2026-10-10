import fs from "node:fs";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import { ConfigStore, defaultConfig, keychainServiceFor, type SecretCommand } from "@codebridge/core";
import { applyLineInput, initDefaults, runInitWizard, terminalIo, type WizardIo } from "./init-wizard.js";

const FEISHU_SECRET = "feishuSecretValue1234";
const TG_TOKEN = "123456:ABCdefGHI_jkl-MNO";

/** Scripted terminal: every prompt must match the next expected question, in order. */
function scriptedIo(script: Array<[RegExp, string | boolean]>) {
  const printed: string[] = [];
  const next = (question: string) => {
    const step = script.shift();
    if (!step || !step[0].test(question)) throw new Error(`unexpected prompt: ${question}`);
    return step[1];
  };
  const io: WizardIo = {
    checkCancelled: () => {},
    print: (text) => { printed.push(text); },
    ask: async (question, defaultValue) => {
      const answer = next(question) as string;
      return answer === "" ? defaultValue ?? "" : answer;
    },
    askSecret: async (question) => next(question) as string,
    confirm: async (question) => next(question) as boolean,
  };
  return { io, printed, remaining: script };
}

function fakeKeychain(options: { fail?: boolean; failAt?: number } = {}) {
  const items = new Map<string, string>();
  let writes = 0;
  const run: SecretCommand = (_file, args, input) => {
    if (args[0] === "-i") {
      if (options.fail || ++writes === options.failAt) throw new Error("User interaction is not allowed.");
      const match = /-s (\S+) -a codebridge -w "([^"]*)"/.exec(input ?? "")!;
      items.set(match[1]!, match[2]!);
      return "";
    }
    if (args[0] === "delete-generic-password") { items.delete(args[args.indexOf("-s") + 1]!); return ""; }
    const value = items.get(args[args.indexOf("-s") + 1]!);
    if (value === undefined) throw new Error("not found");
    return `${value}\n`;
  };
  return { items, secrets: { platform: "darwin" as const, run } };
}

function fakeFetch(options: { feishuOk?: boolean; senderId?: number } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("tenant_access_token")) {
      const body = JSON.parse(String(init?.body)) as { app_secret: string };
      const ok = (options.feishuOk ?? true) && body.app_secret === FEISHU_SECRET;
      return Response.json(ok ? { code: 0, tenant_access_token: "t-x" } : { code: 10014, msg: "app secret invalid" });
    }
    if (href.endsWith("/getMe")) return Response.json({ ok: true, result: { username: "cb_test_bot" } });
    if (href.includes("/getUpdates")) {
      return Response.json({ ok: true, result: options.senderId ? [{ update_id: 1, message: { text: "cb-test", chat: { type: "private" }, from: { id: options.senderId, username: "fixture_user", is_bot: false } } }] : [] });
    }
    throw new Error(`unexpected fetch ${href}`);
  }) as typeof fetch;
  return { impl, calls };
}

describe("codebridge init wizard", () => {
  let dataDir: string;
  let workspace: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-init-"));
    workspace = path.join(dataDir, "projects");
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  it("creates a verified config with secrets in the keychain and only refs on disk", async () => {
    const keychain = fakeKeychain();
    const net = fakeFetch();
    const { io, printed, remaining } = scriptedIo([
      [/启用飞书/, true],
      [/App ID/, "cli_real"],
      [/App Secret/, FEISHU_SECRET],
      [/启用 Telegram/, false],
      [/项目根目录/, workspace],
      [/不存在，现在创建/, true],
      [/默认 Agent/, "claude"],
    ]);
    const summary = await runInitWizard({
      dataDir, io, fetch: net.impl, secrets: keychain.secrets,
      hasCommand: (command) => ["claude", "codex"].includes(command), newToken: () => "generated-runner-token-0123",
    });

    expect(remaining).toEqual([]);
    expect(summary).toMatchObject({ channels: ["feishu"], defaultAgent: "claude", secretStorage: { "runner.token": "keychain", "feishu.appSecret": "keychain" } });
    const text = fs.readFileSync(path.join(dataDir, "config.yaml"), "utf8");
    expect(text).not.toMatch(new RegExp(`${FEISHU_SECRET}|generated-runner-token`));
    expect(fs.statSync(path.join(dataDir, "config.yaml")).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(workspace)).toBe(true);
    const config = new ConfigStore({ dataDir, secrets: keychain.secrets }).get();
    expect(config.feishu).toMatchObject({ appId: "cli_real", appSecret: FEISHU_SECRET });
    expect(config.runner.token).toBe("generated-runner-token-0123");
    expect(config).toMatchObject({ defaultAgent: "claude", defaultBackend: "claude", workspaces: { root: workspace } });
    expect(printed.join("\n")).not.toContain(FEISHU_SECRET);
  });

  it("only fills what is missing in an existing config and keeps comments and custom fields", async () => {
    const existing = parseDocument(stringifyYaml(defaultConfig()));
    existing.commentBefore = " team notes";
    existing.setIn(["feishu", "appId"], "cli_kept");
    existing.setIn(["feishu", "appSecret"], "keychain:codebridge.custom.feishu");
    existing.setIn(["feishu", "policy", "requireMention"], false);
    existing.setIn(["runner", "token"], "env:MY_RUNNER_TOKEN");
    existing.setIn(["workspaces", "root"], dataDir);
    existing.setIn(["defaultBackend"], "codex");
    fs.writeFileSync(path.join(dataDir, "config.yaml"), existing.toString());
    const { io } = scriptedIo([
      [/启用飞书/, true],
      [/已配置，是否重新填写/, false],
      [/启用 Telegram/, false],
      [/项目根目录/, ""],
      [/默认 Agent/, ""],
    ]);
    const summary = await runInitWizard({ dataDir, io, fetch: fakeFetch().impl, secrets: fakeKeychain().secrets, hasCommand: (c) => c === "codex" });
    const text = fs.readFileSync(path.join(dataDir, "config.yaml"), "utf8");
    expect(text).toContain("# team notes");
    expect(text).toContain("appSecret: keychain:codebridge.custom.feishu");
    expect(text).toContain("token: env:MY_RUNNER_TOKEN");
    expect(text).toContain("requireMention: false");
    expect(summary).toMatchObject({ defaultAgent: "codex", secretStorage: { "runner.token": "kept", "feishu.appSecret": "kept" } });
  });

  it("aborts without touching config.yaml after three rejected Feishu credentials", async () => {
    const { io, printed } = scriptedIo([
      [/启用飞书/, true],
      ...[1, 2, 3].flatMap(() => [[/App ID/, "cli_x"], [/App Secret/, "wrong-secret-123"]] as Array<[RegExp, string]>),
      [/连续 3 次校验失败/, false],
    ]);
    const keychain = fakeKeychain();
    await expect(runInitWizard({ dataDir, io, fetch: fakeFetch().impl, secrets: keychain.secrets, hasCommand: () => false, newToken: () => "tok-123456789" }))
      .rejects.toThrow("连续 3 次校验失败");
    expect(fs.existsSync(path.join(dataDir, "config.yaml"))).toBe(false);
    expect(printed.join("\n")).toContain("app secret invalid");
    expect(keychain.items.size).toBe(0);
  });

  it("enables Telegram only with an allowlist, detected from the user's first message", async () => {
    const keychain = fakeKeychain();
    const { io, printed } = scriptedIo([
      [/启用飞书/, false],
      [/启用 Telegram/, true],
      [/bot token/, TG_TOKEN],
      [/自动识别/, true],
      [/发送后/, ""],
      [/验证码来自 @fixture_user \(4242\)/, true],
      [/项目根目录/, dataDir],
      [/默认 Agent/, ""],
    ]);
    await runInitWizard({ dataDir, io, fetch: fakeFetch({ senderId: 4242 }).impl, newCode: () => "cb-test", secrets: keychain.secrets, hasCommand: (c) => c === "codex", newToken: () => "tok-123456789" });
    const config = new ConfigStore({ dataDir, secrets: keychain.secrets }).get();
    expect(config.telegram).toMatchObject({ botToken: TG_TOKEN, allowedUsers: ["4242"] });
    expect(fs.readFileSync(path.join(dataDir, "config.yaml"), "utf8")).not.toContain(TG_TOKEN);
    expect(printed.join("\n")).not.toContain(TG_TOKEN);
  });

  it("refuses an empty Telegram allowlist when entered by hand", async () => {
    const { io, printed } = scriptedIo([
      [/启用飞书/, false],
      [/启用 Telegram/, true],
      [/bot token/, TG_TOKEN],
      [/自动识别/, false],
      [/允许使用的 Telegram 用户 ID/, " , "],
      [/允许使用的 Telegram 用户 ID/, "@someone"],
      [/允许使用的 Telegram 用户 ID/, "111, 222"],
      [/项目根目录/, dataDir],
    ]);
    await runInitWizard({ dataDir, io, fetch: fakeFetch().impl, secrets: fakeKeychain().secrets, hasCommand: () => false, newToken: () => "tok-123456789" });
    expect(printed.filter((line) => line.includes("至少填写一个纯数字的用户 ID"))).toHaveLength(2);
    expect(fs.readFileSync(path.join(dataDir, "config.yaml"), "utf8")).toMatch(/allowedUsers:\n\s+- "111"\n\s+- "222"/);
  });

  it("asks before falling back to plaintext when the keychain is unavailable, and aborts on no", async () => {
    const { io } = scriptedIo([[/启用飞书/, false], [/启用 Telegram/, false], [/项目根目录/, dataDir], [/明文写入/, false]]);
    await expect(runInitWizard({ dataDir, io, fetch: fakeFetch().impl, secrets: fakeKeychain({ fail: true }).secrets, hasCommand: () => false, newToken: () => "tok-123456789" }))
      .rejects.toThrow("runner.token 未保存，初始化中止");
    expect(fs.existsSync(path.join(dataDir, "config.yaml"))).toBe(false);
  });
  function existingConfig(extra?: (doc: ReturnType<typeof parseDocument>) => void) {
    const doc = parseDocument(stringifyYaml(defaultConfig()));
    doc.setIn(["runner", "token"], "old-runner-token");
    doc.setIn(["workspaces", "root"], dataDir);
    extra?.(doc);
    fs.writeFileSync(path.join(dataDir, "config.yaml"), doc.toString());
    return doc.toString();
  }

  it.each(["pi", "my-custom-agent"])("preserves an existing %s default and unrelated config", async (agent) => {
    const before = existingConfig((doc) => {
      doc.setIn(["defaultAgent"], agent);
      doc.setIn(["backends", "my-custom-agent"], { type: "generic-spawn", acpCommand: "custom", acpArgs: ["--x"] });
      doc.setIn(["orchestration", "session", "autoRotate", "maxContextRatio"], 0.7);
      doc.commentBefore = " custom notes";
    });
    const { io } = scriptedIo([[/启用飞书/, false], [/启用 Telegram/, false], [/项目根目录/, ""], [/默认 Agent/, ""]]);
    const keychain = fakeKeychain();
    const summary = await runInitWizard({ dataDir, io, secrets: keychain.secrets, hasCommand: (c) => c === "claude" });
    expect(summary.defaultAgent).toBe(agent);
    expect(fs.readFileSync(path.join(dataDir, "config.yaml"), "utf8")).toBe(before);
    expect(keychain.items.size).toBe(0);
  });

  it("keeps a symlink and replaces its target atomically with private permissions", async () => {
    existingConfig();
    const targetDir = path.join(dataDir, "dotfiles");
    fs.mkdirSync(targetDir);
    const target = path.join(targetDir, "bridge.yaml");
    fs.renameSync(path.join(dataDir, "config.yaml"), target);
    fs.symlinkSync(target, path.join(dataDir, "config.yaml"));
    const { io } = scriptedIo([[/启用飞书/, false], [/启用 Telegram/, false], [/项目根目录/, ""], [/默认 Agent/, "codex"]]);
    await runInitWizard({ dataDir, io, secrets: fakeKeychain().secrets, hasCommand: (c) => c === "codex" });
    expect(fs.lstatSync(path.join(dataDir, "config.yaml")).isSymbolicLink()).toBe(true);
    expect(parseDocument(fs.readFileSync(target, "utf8")).get("defaultAgent")).toBe("codex");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(targetDir)).toEqual(["bridge.yaml"]);
  });

  it.each([true, false])("repairs an unrestricted existing Telegram even when setup=%s", async (setup) => {
    existingConfig((doc) => doc.setIn(["telegram", "botToken"], TG_TOKEN));
    const { io } = scriptedIo([
      [/启用飞书/, false], [/启用 Telegram/, setup],
      ...(setup ? [[/是否重新填写/, false] as [RegExp, boolean]] : []),
      [/自动识别/, false], [/允许使用的 Telegram/, "123"], [/项目根目录/, ""], [/默认 Agent/, ""],
    ]);
    await runInitWizard({ dataDir, io, hasCommand: () => false });
    expect(new ConfigStore({ dataDir }).get().telegram?.allowedUsers).toEqual(["123"]);
  });

  it.each(["allowedUsers", "allowedChats"])("keeps existing %s on Telegram token rotation", async (field) => {
    existingConfig((doc) => {
      doc.setIn(["telegram", "botToken"], "old-token");
      doc.setIn(["telegram", field], ["123", "456"]);
    });
    const { io } = scriptedIo([
      [/启用飞书/, false], [/启用 Telegram/, true], [/是否重新填写/, true], [/bot token/, TG_TOKEN],
      [/保留现有白名单/, true], [/项目根目录/, ""], [/默认 Agent/, ""],
    ]);
    const keychain = fakeKeychain();
    await runInitWizard({ dataDir, io, fetch: fakeFetch().impl, secrets: keychain.secrets, hasCommand: () => false });
    expect(new ConfigStore({ dataDir, secrets: keychain.secrets }).get().telegram?.[field as "allowedUsers"]).toEqual(["123", "456"]);
  });

  it("binds detection to a private human nonce, not the newest stranger or group message", async () => {
    const updates = [
      { update_id: 1, message: { text: "wrong", chat: { type: "private" }, from: { id: 11 } } },
      { update_id: 2, message: { text: "cb-test", chat: { type: "group" }, from: { id: 22 } } },
      { update_id: 3, message: { text: "cb-test", chat: { type: "private" }, from: { id: 33, is_bot: true } } },
      { update_id: 4, message: { text: "cb-test", chat: { type: "private" }, from: { id: 44, is_bot: false } } },
      { update_id: 5, message: { text: "hi", chat: { type: "private" }, from: { id: 55 } } },
    ];
    const calls: string[] = [];
    const net = (async (url: string | URL) => {
      calls.push(String(url));
      return Response.json({ ok: true, result: String(url).endsWith("getMe") ? { username: "test" } : updates });
    }) as typeof fetch;
    const { io } = scriptedIo([
      [/启用飞书/, false], [/启用 Telegram/, true], [/bot token/, TG_TOKEN], [/自动识别/, true],
      [/发送后/, ""], [/验证码来自 \(44\)/, true], [/项目根目录/, dataDir],
    ]);
    const confirm = io.confirm;
    io.confirm = async (q, def) => { if (q.includes("验证码来自")) expect(def).toBe(false); return confirm(q, def); };
    const keychain = fakeKeychain();
    await runInitWizard({ dataDir, io, fetch: net, secrets: keychain.secrets, hasCommand: () => false, newCode: () => "cb-test" });
    expect(new ConfigStore({ dataDir, secrets: keychain.secrets }).get().telegram?.allowedUsers).toEqual(["44"]);
    expect(calls.some((url) => url.endsWith("getUpdates?offset=5&limit=1"))).toBe(true);
  });

  it("leaves both the old credential and config untouched when cancelled after credential verification", async () => {
    const service = keychainServiceFor(["feishu", "appSecret"], dataDir);
    const before = existingConfig((doc) => {
      doc.setIn(["feishu", "appId"], "cli_old");
      doc.setIn(["feishu", "appSecret"], `keychain:${service}`);
    });
    const keychain = fakeKeychain();
    keychain.items.set(service, "old-secret");
    const { io } = scriptedIo([[/启用飞书/, true], [/重新填写/, true], [/App ID/, "cli_new"], [/App Secret/, FEISHU_SECRET]]);
    await expect(runInitWizard({ dataDir, io, fetch: fakeFetch().impl, secrets: keychain.secrets })).rejects.toThrow("unexpected prompt");
    expect(keychain.items).toEqual(new Map([[service, "old-secret"]]));
    expect(fs.readFileSync(path.join(dataDir, "config.yaml"), "utf8")).toBe(before);
  });

  it.each(["rename", "second-secret"])("rolls back staged secrets when %s fails", async (failure) => {
    const service = keychainServiceFor(["feishu", "appSecret"], dataDir);
    const before = existingConfig((doc) => {
      doc.setIn(["runner", "token"], "change-me-runner-token");
      doc.setIn(["feishu", "appId"], "cli_old");
      doc.setIn(["feishu", "appSecret"], `keychain:${service}`);
    });
    const keychain = fakeKeychain({ failAt: failure === "second-secret" ? 2 : undefined });
    keychain.items.set(service, "old-secret");
    const { io } = scriptedIo([
      [/启用飞书/, true], [/重新填写/, true], [/App ID/, "cli_new"], [/App Secret/, FEISHU_SECRET],
      [/启用 Telegram/, false], [/项目根目录/, ""], [/默认 Agent/, ""],
      ...(failure === "second-secret" ? [[/明文写入/, false] as [RegExp, boolean]] : []),
    ]);
    if (failure === "rename") vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("simulated disk failure"); });
    await expect(runInitWizard({ dataDir, io, fetch: fakeFetch().impl, secrets: keychain.secrets, hasCommand: () => false })).rejects.toThrow();
    expect(keychain.items).toEqual(new Map([[service, "old-secret"]]));
    expect(fs.readFileSync(path.join(dataDir, "config.yaml"), "utf8")).toBe(before);
    expect(fs.readdirSync(dataDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("successfully rotates credentials without overwriting a live keychain reference", async () => {
    const service = keychainServiceFor(["feishu", "appSecret"], dataDir);
    existingConfig((doc) => { doc.setIn(["feishu", "appId"], "cli_old"); doc.setIn(["feishu", "appSecret"], `keychain:${service}`); });
    const keychain = fakeKeychain();
    keychain.items.set(service, "old-secret");
    const { io } = scriptedIo([[/启用飞书/, true], [/重新填写/, true], [/App ID/, "cli_new"], [/App Secret/, FEISHU_SECRET], [/启用 Telegram/, false], [/项目根目录/, ""], [/默认 Agent/, ""]]);
    await runInitWizard({ dataDir, io, fetch: fakeFetch().impl, secrets: keychain.secrets, hasCommand: () => false });
    expect(keychain.items.get(service)).toBe("old-secret");
    expect(new ConfigStore({ dataDir, secrets: keychain.secrets }).get().feishu).toMatchObject({ appId: "cli_new", appSecret: FEISHU_SECRET });
  });

  it("validates env-completed configs like runtime without serializing the env secret", async () => {
    const before = existingConfig((doc) => doc.deleteIn(["feishu"]));
    vi.stubEnv("FEISHU_APP_ID", "cli_env");
    vi.stubEnv("FEISHU_APP_SECRET", FEISHU_SECRET);
    const { io } = scriptedIo([[/启用飞书/, true], [/重新填写/, false], [/启用 Telegram/, false], [/项目根目录/, ""], [/默认 Agent/, ""]]);
    await runInitWizard({ dataDir, io, hasCommand: () => false });
    expect(fs.readFileSync(path.join(dataDir, "config.yaml"), "utf8")).toBe(before);
  });

  it("rejects invalid config before writing any secrets and cleans the temporary file", async () => {
    const before = existingConfig((doc) => { doc.setIn(["runner", "token"], "change-me-runner-token"); doc.setIn(["runner", "url"], "not-a-url"); });
    const { io } = scriptedIo([[/启用飞书/, false], [/启用 Telegram/, false], [/项目根目录/, ""], [/默认 Agent/, ""]]);
    const keychain = fakeKeychain();
    await expect(runInitWizard({ dataDir, io, secrets: keychain.secrets, hasCommand: () => false })).rejects.toThrow("配置校验失败");
    expect(keychain.items.size).toBe(0);
    expect(fs.readFileSync(path.join(dataDir, "config.yaml"), "utf8")).toBe(before);
    expect(fs.readdirSync(dataDir)).toEqual(["config.yaml"]);
  });

  it("does not send credentials over HTTP and can skip the channel", async () => {
    existingConfig((doc) => doc.setIn(["feishu", "domain"], "http://example.test"));
    const { io } = scriptedIo([
      [/启用飞书/, true], ...[1, 2, 3].flatMap(() => [[/App ID/, "cli_x"], [/App Secret/, FEISHU_SECRET]] as Array<[RegExp, string]>),
      [/连续 3 次/, true], [/启用 Telegram/, false], [/项目根目录/, ""], [/默认 Agent/, ""],
    ]);
    const net = vi.fn();
    await runInitWizard({ dataDir, io, fetch: net, hasCommand: () => false });
    expect(net).not.toHaveBeenCalled();
  });

  it("aborts when Telegram cannot acknowledge the verification code", async () => {
    const net = (async (url: string | URL) => {
      if (String(url).includes("offset=")) return Response.json({ ok: false, description: "unavailable" });
      return fakeFetch({ senderId: 4242 }).impl(url);
    }) as typeof fetch;
    const { io } = scriptedIo([[/启用飞书/, false], [/启用 Telegram/, true], [/bot token/, TG_TOKEN], [/自动识别/, true], [/发送后/, ""]]);
    const keychain = fakeKeychain();
    await expect(runInitWizard({ dataDir, io, fetch: net, secrets: keychain.secrets, newCode: () => "cb-test" })).rejects.toThrow("验证码消息未能确认");
    expect(keychain.items.size).toBe(0);
    expect(fs.existsSync(path.join(dataDir, "config.yaml"))).toBe(false);
  });

  it("redacts credentials echoed by a failed verification transport", async () => {
    const { io, printed } = scriptedIo([
      [/启用飞书/, true], ...[1, 2, 3].flatMap(() => [[/App ID/, "cli_x"], [/App Secret/, FEISHU_SECRET]] as Array<[RegExp, string]>),
      [/连续 3 次/, true], [/启用 Telegram/, true], ...[1, 2, 3].map(() => [/bot token/, TG_TOKEN] as [RegExp, string]),
      [/连续 3 次/, false],
    ]);
    const net = (async (url: string | URL) => { throw new Error(String(url).includes("telegram") ? TG_TOKEN : FEISHU_SECRET); }) as typeof fetch;
    await expect(runInitWizard({ dataDir, io, fetch: net, secrets: fakeKeychain().secrets })).rejects.toThrow("连续 3 次");
    expect(printed.join("\n")).not.toContain(FEISHU_SECRET);
    expect(printed.join("\n")).not.toContain(TG_TOKEN);
    expect(printed.join("\n")).toContain("[REDACTED]");
  });


  it("uses the disk Telegram token when the environment override is empty", async () => {
    existingConfig((doc) => doc.setIn(["telegram", "botToken"], TG_TOKEN));
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const { io } = scriptedIo([[/启用飞书/, false], [/启用 Telegram/, false], [/自动识别/, false], [/允许使用的 Telegram/, "4242"], [/项目根目录/, ""], [/默认 Agent/, ""]]);
    await runInitWizard({ dataDir, io, hasCommand: () => false });
    expect(new ConfigStore({ dataDir }).get().telegram?.allowedUsers).toEqual(["4242"]);
  });

  it("keeps an environment-owned Telegram credential instead of verifying a different replacement bot", async () => {
    existingConfig((doc) => doc.setIn(["telegram", "botToken"], "111:disk"));
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "222:environment");
    const { io } = scriptedIo([[/启用飞书/, false], [/启用 Telegram/, true], [/自动识别/, false], [/允许使用的 Telegram/, "4242"], [/项目根目录/, ""], [/默认 Agent/, ""]]);
    const confirm = io.confirm;
    io.confirm = (question, defaultYes) => question.includes("重新填写") ? Promise.resolve(true) : confirm(question, defaultYes);
    const secretInput = vi.fn(async () => TG_TOKEN);
    io.askSecret = secretInput;
    const keychain = fakeKeychain();
    const net = fakeFetch();
    await runInitWizard({ dataDir, io, fetch: net.impl, secrets: keychain.secrets, hasCommand: () => false });
    expect(secretInput).not.toHaveBeenCalled();
    expect(net.calls).toEqual([]);
    expect(keychain.items.size).toBe(0);
    expect(new ConfigStore({ dataDir }).get().telegram).toMatchObject({ botToken: "222:environment", allowedUsers: ["4242"] });
  });

  it("clears old chat restrictions when replacing the existing whitelist", async () => {
    existingConfig((doc) => { doc.setIn(["telegram", "botToken"], TG_TOKEN); doc.setIn(["telegram", "allowedChats"], ["-1009"]); });
    const { io } = scriptedIo([[/启用飞书/, false], [/启用 Telegram/, true], [/重新填写/, true], [/bot token/, TG_TOKEN], [/保留现有白名单/, false], [/自动识别/, false], [/允许使用的 Telegram/, "4242"], [/项目根目录/, ""], [/默认 Agent/, ""]]);
    const keychain = fakeKeychain();
    await runInitWizard({ dataDir, io, fetch: fakeFetch().impl, secrets: keychain.secrets, hasCommand: () => false });
    const telegram = new ConfigStore({ dataDir, secrets: keychain.secrets }).get().telegram;
    expect(telegram?.allowedUsers).toEqual(["4242"]);
    expect(telegram?.allowedChats).toBeUndefined();
  });

  it("does not commit when Ctrl-C follows the final answer in the same input chunk", async () => {
    const before = existingConfig();
    const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode: vi.fn() });
    const stdin = vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const terminal = terminalIo();
    try {
      const { io } = scriptedIo([[/启用飞书/, false], [/启用 Telegram/, false], [/项目根目录/, ""]]);
      const ask = io.ask;
      io.checkCancelled = () => terminal.checkCancelled();
      io.ask = (question, defaultValue) => {
        if (!question.includes("默认 Agent")) return ask(question, defaultValue);
        const answer = terminal.ask(question, defaultValue);
        input.emit("data", Buffer.from("codex\r\x03"));
        return answer;
      };
      await expect(runInitWizard({ dataDir, io, hasCommand: (c) => c === "codex" })).rejects.toThrow("已取消");
      expect(fs.readFileSync(path.join(dataDir, "config.yaml"), "utf8")).toBe(before);
    } finally { terminal.close(); stdout.mockRestore(); stdin.mockRestore(); }
  });
  it("retains unchanged relative workspace text instead of normalizing it", async () => {
    const root = path.relative(process.cwd(), dataDir);
    const before = existingConfig((doc) => doc.setIn(["workspaces", "root"], root));
    const { io } = scriptedIo([[/启用飞书/, false], [/启用 Telegram/, false], [/项目根目录/, ""], [/默认 Agent/, ""]]);
    await runInitWizard({ dataDir, io, hasCommand: () => false });
    expect(fs.readFileSync(path.join(dataDir, "config.yaml"), "utf8")).toBe(before);
  });

  it("non-interactive defaults generate unique tokens, use private files and never overwrite", () => {
    const other = path.join(dataDir, "other");
    expect(initDefaults(dataDir).written).toBe(true);
    initDefaults(other);
    const filename = path.join(dataDir, "config.yaml");
    const before = fs.readFileSync(filename, "utf8");
    expect(new ConfigStore({ dataDir }).get().runner.token).toMatch(/^[0-9a-f]{48}$/);
    expect(new ConfigStore({ dataDir }).get().runner.token).not.toBe(new ConfigStore({ dataDir: other }).get().runner.token);
    expect(initDefaults(dataDir).written).toBe(false);
    expect(fs.readFileSync(filename, "utf8")).toBe(before);
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
  });

});


describe("terminal input", () => {
  it("does not echo secrets or retain recallable history", () => {
    const entered = applyLineInput({ buffer: "" }, "secret123\r", true);
    expect(entered).toMatchObject({ buffer: "secret123", echo: "", done: true });
    expect(applyLineInput({ buffer: "" }, "\x1b[A\r", false)).toMatchObject({ buffer: "", echo: "", done: true });
  });
  it("drops multiline paste tail and handles split arrows", () => {
    expect(applyLineInput({ buffer: "" }, "app-id\rSECRET\r", false)).toMatchObject({ buffer: "app-id", echo: "app-id", done: true });
    const state = applyLineInput({ buffer: "" }, "\x1b[", false);
    expect(applyLineInput(state, "Aok\r", false)).toMatchObject({ buffer: "ok", echo: "ok", done: true });
  });
  it("supports unicode backspace and cancellation", () => {
    expect(applyLineInput({ buffer: "中文" }, "\x7f好\r", true)).toMatchObject({ buffer: "中好", echo: "" });
    expect(applyLineInput({ buffer: "" }, "\x03", true).cancelled).toBe(true);
    expect(applyLineInput({ buffer: "" }, "\x04", false).cancelled).toBe(true);
  });
});


describe("terminal lifecycle", () => {
  it("suppresses idle input and split bracketed paste, restores raw mode and closes cleanly", async () => {
    const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode: vi.fn() });
    const stdin = vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output += String(chunk); return true; });
    const io = terminalIo();
    try {
      const secret = io.askSecret("SECRET");
      input.emit("data", Buffer.from("\x1b[200~secret-value\r"));
      expect(await secret).toBe("secret-value");
      const next = io.ask("NEXT");
      input.emit("data", Buffer.from("pasted-secret\r\x1b[20"));
      input.emit("data", Buffer.from("1~"));
      input.emit("data", Buffer.from("ok\r"));
      expect(await next).toBe("ok");
      input.emit("data", Buffer.from("idle-secret"));
      expect(output).not.toContain("secret-value");
      expect(output).not.toContain("pasted-secret");
      expect(output).not.toContain("idle-secret");
    } finally { io.close(); stdout.mockRestore(); stdin.mockRestore(); }
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
  });

  it.each(["EOF", "Ctrl-C"])("cancels on %s and rejects later prompts", async (cause) => {
    const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode: vi.fn() });
    const stdin = vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const io = terminalIo();
    try {
      const answer = io.ask("FIRST");
      if (cause === "EOF") input.emit("end");
      else input.emit("data", Buffer.from("\x03"));
      await expect(answer).rejects.toThrow(cause === "EOF" ? "终端输入已关闭" : "已取消");
      await expect(io.ask("SECOND")).rejects.toThrow("已取消");
    } finally { io.close(); stdout.mockRestore(); stdin.mockRestore(); }
  });
});
