import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { ConfigStore } from "./config-store.js";
import { defaultConfig } from "./config-schema.js";
import { isPlaintextSecret, resolveSecretRef, storeKeychainSecret, type SecretCommand } from "./secret-refs.js";

const SECRET = "Fs3cret-from-keychain";

describe("secret references in config.yaml", () => {
  let dataDir: string;
  const keychain: SecretCommand = (_file, args) => {
    if (args.includes("codebridge.feishu.appSecret")) return `${SECRET}\n`;
    throw new Error("The specified item could not be found in the keychain.");
  };
  const writeConfig = (mutate: (config: Record<string, any>) => void) => {
    const config = structuredClone(defaultConfig()) as Record<string, any>;
    mutate(config);
    fs.writeFileSync(path.join(dataDir, "config.yaml"), stringifyYaml(config));
  };
  const onDisk = () => fs.readFileSync(path.join(dataDir, "config.yaml"), "utf8");

  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-secret-refs-")); });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  it("resolves a keychain ref and writes the ref, not the secret, when the app saves config", () => {
    writeConfig((c) => { c.feishu.appSecret = "keychain:codebridge.feishu.appSecret"; });
    const store = new ConfigStore({ dataDir, secrets: { platform: "darwin", run: keychain } });
    expect(store.get().feishu.appSecret).toBe(SECRET);
    store.update((current) => ({ ...current, defaultAgent: "codex" }));
    expect(onDisk()).toContain("appSecret: keychain:codebridge.feishu.appSecret");
    expect(onDisk()).not.toContain(SECRET);
    expect(store.secretSources()["feishu.appSecret"]).toBe("keychain");
  });

  it("never persists an env-provided secret over what is on disk", () => {
    // Before refs existed, saving config wrote FEISHU_APP_SECRET from the env into config.yaml.
    writeConfig((c) => { c.feishu.appSecret = "on-disk-secret"; });
    vi.stubEnv("FEISHU_APP_ID", "cli_env");
    vi.stubEnv("FEISHU_APP_SECRET", "env-only-secret");
    const store = new ConfigStore({ dataDir });
    expect(store.get().feishu.appSecret).toBe("env-only-secret");
    store.update((current) => ({ ...current, defaultAgent: "codex" }));
    expect(onDisk()).not.toContain("env-only-secret");
    expect(onDisk()).toContain("appSecret: on-disk-secret");
  });

  it("does not write env-only secrets when there was no config file", () => {
    vi.stubEnv("FEISHU_APP_ID", "cli_env");
    vi.stubEnv("FEISHU_APP_SECRET", "env-only-secret");
    vi.stubEnv("RUNNER_TOKEN", "env-runner-token");
    new ConfigStore({ dataDir }).save({ defaultAgent: "codex" });
    expect(onDisk()).not.toMatch(/env-only-secret|env-runner-token/);
  });

  it("persists a secret the app itself changed", () => {
    writeConfig((c) => { c.feishu.appSecret = "keychain:codebridge.feishu.appSecret"; });
    const store = new ConfigStore({ dataDir, secrets: { platform: "darwin", run: keychain } });
    store.update((current) => ({ ...current, runner: { ...current.runner, token: "rotated-runner-token" } }));
    expect(onDisk()).toContain("token: rotated-runner-token");
    expect(onDisk()).toContain("appSecret: keychain:codebridge.feishu.appSecret");
  });

  it("fails loudly with the ref name, never the value, when a ref cannot be read", () => {
    writeConfig((c) => { c.runner.token = "keychain:codebridge.runner.token"; });
    expect(() => new ConfigStore({ dataDir, secrets: { platform: "darwin", run: keychain } }))
      .toThrow("读取密钥 keychain:codebridge.runner.token 失败：The specified item could not be found in the keychain.");
    expect(() => resolveSecretRef("env:CB_MISSING", { env: {} })).toThrow("读取密钥 env:CB_MISSING 失败：环境变量未设置");
    expect(resolveSecretRef("env:CB_SET", { env: { CB_SET: "x1" } })).toBe("x1");
  });

  it("uses secret-tool on Linux", () => {
    const run = vi.fn<SecretCommand>(() => "linux-secret\n");
    expect(resolveSecretRef("keychain:svc", { platform: "linux", run })).toBe("linux-secret");
    expect(run).toHaveBeenCalledWith("secret-tool", ["lookup", "service", "svc", "account", "codebridge"]);
  });

  it("writes keychain secrets through stdin and refuses values it cannot quote safely", () => {
    const run = vi.fn<SecretCommand>(() => "");
    storeKeychainSecret("codebridge.runner.token", "abc:DEF-_123", { platform: "darwin", run });
    const [file, args, input] = run.mock.calls[0]!;
    expect(file).toBe("/usr/bin/security");
    expect(args).toEqual(["-i"]);
    expect(input).toContain('-w "abc:DEF-_123"');
    expect(JSON.stringify(args)).not.toContain("abc:DEF");
    expect(() => storeKeychainSecret("svc", 'has"quote', { platform: "darwin", run })).toThrow("无法安全写入钥匙串");
    storeKeychainSecret("svc", "linux-value", { platform: "linux", run });
    expect(run).toHaveBeenLastCalledWith("secret-tool", ["store", "--label", "CodeBridge svc", "service", "svc", "account", "codebridge"], "linux-value");
  });

  it("does not treat default placeholders as secrets to migrate", () => {
    expect(isPlaintextSecret(defaultConfig().feishu.appSecret)).toBe(false);
    expect(isPlaintextSecret(defaultConfig().runner.token)).toBe(false);
    expect(isPlaintextSecret("real-secret")).toBe(true);
    expect(isPlaintextSecret("keychain:x")).toBe(false);
  });
});
