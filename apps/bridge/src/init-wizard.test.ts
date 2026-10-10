import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import { ConfigStore, defaultConfig, type SecretCommand } from "@codebridge/core";
import { runInitWizard, type WizardIo } from "./init-wizard.js";

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

function fakeKeychain(options: { fail?: boolean } = {}) {
  const items = new Map<string, string>();
  const run: SecretCommand = (_file, args, input) => {
    if (args[0] === "-i") {
      if (options.fail) throw new Error("User interaction is not allowed.");
      const match = /-s (\S+) -a codebridge -w "([^"]*)"/.exec(input ?? "")!;
      items.set(match[1]!, match[2]!);
      return "";
    }
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
    if (href.endsWith("/getUpdates")) {
      return Response.json({ ok: true, result: options.senderId ? [{ message: { from: { id: options.senderId, username: "fixture_user" } } }] : [] });
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
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

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
    ]);
    await expect(runInitWizard({ dataDir, io, fetch: fakeFetch().impl, secrets: fakeKeychain().secrets, hasCommand: () => false, newToken: () => "tok-123456789" }))
      .rejects.toThrow("连续 3 次校验失败");
    expect(fs.existsSync(path.join(dataDir, "config.yaml"))).toBe(false);
    expect(printed.join("\n")).toContain("app secret invalid");
  });

  it("enables Telegram only with an allowlist, detected from the user's first message", async () => {
    const keychain = fakeKeychain();
    const { io, printed } = scriptedIo([
      [/启用飞书/, false],
      [/启用 Telegram/, true],
      [/bot token/, TG_TOKEN],
      [/自动识别/, true],
      [/已发送/, ""],
      [/识别到用户 @fixture_user \(4242\)/, true],
      [/项目根目录/, dataDir],
      [/默认 Agent/, ""],
    ]);
    await runInitWizard({ dataDir, io, fetch: fakeFetch({ senderId: 4242 }).impl, secrets: keychain.secrets, hasCommand: (c) => c === "codex", newToken: () => "tok-123456789" });
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
    const { io } = scriptedIo([[/改为明文写入/, false]]);
    await expect(runInitWizard({ dataDir, io, fetch: fakeFetch().impl, secrets: fakeKeychain({ fail: true }).secrets, newToken: () => "tok-123456789" }))
      .rejects.toThrow("runner.token 未保存，初始化中止");
    expect(fs.existsSync(path.join(dataDir, "config.yaml"))).toBe(false);
  });
});
