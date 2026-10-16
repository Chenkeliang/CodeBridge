import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { ConfigStore } from "./config-store.js";
import { defaultConfig } from "./config-schema.js";
import { isPlaintextSecret, keychainServiceFor, resolveSecretRef, storeKeychainSecret, type SecretCommand } from "./secret-refs.js";

const SECRET = "Fs3cret-from-keychain";

describe("secret references in config.yaml", () => {
  let dataDir: string;
  const saved = new Map<string, string>();
  const keychain: SecretCommand = (_file, args, input) => {
    if (args[0] === "-i") {
      const match = /-s (\S+) -a codebridge -w "([^"]*)"/.exec(input ?? "")!;
      saved.set(match[1]!, match[2]!); return "";
    }
    const stored = saved.get(args[args.indexOf("-s") + 1]!);
    if (stored !== undefined) return stored;
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
    expect(onDisk()).not.toContain("on-disk-secret");
    expect(onDisk()).toContain("appSecret: env:FEISHU_APP_SECRET");
  });

  it("writes env: refs, not values, for env-only secrets and the file still loads", () => {
    vi.stubEnv("FEISHU_APP_ID", "cli_env");
    vi.stubEnv("FEISHU_APP_SECRET", "env-only-secret");
    vi.stubEnv("RUNNER_TOKEN", "env-runner-token");
    new ConfigStore({ dataDir }).save({ defaultAgent: "codex" });
    expect(onDisk()).not.toMatch(/env-only-secret|env-runner-token/);
    expect(onDisk()).toContain("appSecret: env:FEISHU_APP_SECRET");
    expect(onDisk()).toContain("token: env:RUNNER_TOKEN");
    expect(new ConfigStore({ dataDir }).get().runner.token).toBe("env-runner-token");
  });

  it("lets an env override win without resolving the ref it replaces", () => {
    writeConfig((c) => { c.runner.token = "keychain:codebridge.runner.token"; });
    vi.stubEnv("RUNNER_TOKEN", "env-token-123456");
    // The keychain fake throws for runner.token, so resolving it would fail the load.
    const store = new ConfigStore({ dataDir, secrets: { platform: "darwin", run: keychain } });
    expect(store.get().runner.token).toBe("env-token-123456");
    store.update((current) => ({ ...current, defaultAgent: "codex" }));
    expect(onDisk()).toContain("token: keychain:codebridge.runner.token");
  });

  it("keeps a configured Runner URL when only its secret comes from the environment", () => {
    writeConfig((c) => { c.runner.url = "http://127.0.0.1:43210"; });
    vi.stubEnv("RUNNER_TOKEN", "fixture-runner-environment");
    expect(new ConfigStore({ dataDir }).get().runner.url).toBe("http://127.0.0.1:43210");
  });

  it("does not blank a secret when only a sibling env var is set", () => {
    writeConfig((c) => { c.runner.token = "disk-token-123456"; });
    vi.stubEnv("RUNNER_URL", "http://127.0.0.1:1");
    expect(new ConfigStore({ dataDir }).get().runner).toEqual({ url: "http://127.0.0.1:1", token: "disk-token-123456" });
  });

  it("resolves only the requested fields, so the Runner ignores secrets it does not use", () => {
    writeConfig((c) => { c.feishu.appSecret = "keychain:codebridge.broken"; c.runner.token = "env:CB_RUNNER"; });
    vi.stubEnv("CB_RUNNER", "runner-token-123");
    const store = new ConfigStore({ dataDir, resolve: ["runner.token"], secrets: { platform: "darwin", run: keychain } });
    expect(store.get().runner.token).toBe("runner-token-123");
    expect(store.get().feishu.appSecret).toBe("keychain:codebridge.broken");
  });

  it("never writes a newly supplied plaintext secret to config", () => {
    const items = new Map<string, string>();
    const run: SecretCommand = (_file, args, input) => {
      if (args[0] === "-i") {
        const match = /-s (\S+) -a codebridge -w "([^"]*)"/.exec(input ?? "")!;
        items.set(match[1]!, match[2]!); return "";
      }
      return items.get(args[args.indexOf("-s") + 1]!) ?? "";
    };
    const store = new ConfigStore({ dataDir, secrets: { platform: "darwin", run } });
    store.save({ runner: { url: "http://127.0.0.1:19789", token: "fixture-runner-secret" } });
    expect(onDisk()).not.toContain("fixture-runner-secret");
    expect(onDisk()).toContain("token: keychain:");
    expect(new ConfigStore({ dataDir, secrets: { platform: "darwin", run } }).get().runner.token).toBe("fixture-runner-secret");
  });

  it("inspects every field without throwing on a broken ref", () => {
    writeConfig((c) => { c.feishu.appSecret = "keychain:codebridge.broken"; c.runner.token = "plain-token-123"; });
    const report = ConfigStore.inspectSecrets(path.join(dataDir, "config.yaml"), { platform: "darwin", run: keychain, env: {} });
    expect(report["feishu.appSecret"]).toMatchObject({ source: "keychain", readable: false });
    expect(report["feishu.appSecret"]!.error).toContain("could not be found");
    expect(report["runner.token"]).toEqual({ source: "plaintext", readable: true });
  });

  it("persists a secret the app itself changed", () => {
    writeConfig((c) => { c.feishu.appSecret = "keychain:codebridge.feishu.appSecret"; });
    const store = new ConfigStore({ dataDir, secrets: { platform: "darwin", run: keychain } });
    store.update((current) => ({ ...current, runner: { ...current.runner, token: "rotated-runner-token" } }));
    expect(onDisk()).not.toContain("rotated-runner-token");
    expect(onDisk()).toContain("token: keychain:");
    expect(store.get().runner.token).toBe("rotated-runner-token");
    expect(onDisk()).toContain("appSecret: keychain:codebridge.feishu.appSecret");
  });

  it("fails loudly with the ref name, never the value, when a ref cannot be read", () => {
    writeConfig((c) => { c.runner.token = "keychain:codebridge.runner.token"; });
    expect(() => new ConfigStore({ dataDir, secrets: { platform: "darwin", run: keychain } }))
      .toThrow("读取密钥 keychain:codebridge.runner.token 失败：The specified item could not be found in the keychain.");
    expect(() => resolveSecretRef("env:CB_MISSING", { env: {} })).toThrow("读取密钥 env:CB_MISSING 失败：环境变量未设置");
    expect(resolveSecretRef("env:CB_SET", { env: { CB_SET: "x1" } })).toBe("x1");
  });

  it("reports the helper's stderr reason, not execFileSync's command line", () => {
    const run: SecretCommand = () => {
      throw Object.assign(new Error("Command failed: /usr/bin/security find-generic-password -s x -a codebridge -w\nsecurity: locked"),
        { stderr: "security: SecKeychainSearchCopyNext: User interaction is not allowed.\n" });
    };
    expect(() => resolveSecretRef("keychain:x", { platform: "darwin", run })).toThrow("失败：security: SecKeychainSearchCopyNext: User interaction is not allowed.");
    expect(() => resolveSecretRef("keychain:x", { platform: "darwin", run })).not.toThrow("Command failed");
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
    expect(() => storeKeychainSecret("svc -w x", "value", { platform: "darwin", run })).toThrow("含非法字符");
    storeKeychainSecret("svc", "linux-value", { platform: "linux", run });
    expect(run).toHaveBeenLastCalledWith("secret-tool", ["store", "--label", "CodeBridge svc", "service", "svc", "account", "codebridge"], "linux-value");
  });

  it("keeps short service names for the default data dir", () => {
    expect(keychainServiceFor(["runner", "token"], path.join(os.homedir(), ".codebridge"))).toBe("codebridge.runner.token");
    expect(keychainServiceFor(["runner", "token"], dataDir)).toMatch(/^codebridge\.[0-9a-f]{8}\.runner\.token$/);
  });

  it("does not treat default placeholders as secrets to migrate", () => {
    expect(isPlaintextSecret(defaultConfig().feishu.appSecret)).toBe(false);
    expect(isPlaintextSecret(defaultConfig().runner.token)).toBe(false);
    expect(isPlaintextSecret("real-secret")).toBe(true);
    expect(isPlaintextSecret("keychain:x")).toBe(false);
    writeConfig(() => {});
    expect(new ConfigStore({ dataDir }).secretSources()["runner.token"]).toBe("placeholder");
  });
});
