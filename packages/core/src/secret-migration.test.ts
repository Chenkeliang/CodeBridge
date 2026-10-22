import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { defaultConfig } from "./config-schema.js";
import { ConfigStore } from "./config-store.js";
import { migrateConfigSecrets } from "./secret-migration.js";
import type { SecretCommand } from "./secret-refs.js";

/** In-memory keychain speaking the same commands as macOS `security`. */
function fakeKeychain(options: { corrupt?: boolean } = {}) {
  const items = new Map<string, string>();
  const run: SecretCommand = (_file, args, input) => {
    if (args[0] === "-i") {
      const match = /-s (\S+) -a codebridge -w "([^"]*)"/.exec(input ?? "")!;
      items.set(match[1]!, options.corrupt ? "corrupted" : match[2]!);
      return "";
    }
    const value = items.get(args[args.indexOf("-s") + 1]!);
    if (value === undefined) throw new Error("The specified item could not be found in the keychain.");
    return `${value}\n`;
  };
  return { items, options: { platform: "darwin" as const, run } };
}

const base = structuredClone(defaultConfig());
base.feishu.appSecret = "real-feishu-secret";
base.runner.token = "real-runner-token-0123456789";
const CONFIG = `# my notes stay\n${stringifyYaml(base)}`.replace(
  "appSecret: real-feishu-secret", "appSecret: real-feishu-secret # keep me",
);

describe("codebridge secrets migrate", () => {
  let dataDir: string;
  let file: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-secret-migrate-"));
    file = path.join(dataDir, "config.yaml");
    fs.writeFileSync(file, CONFIG, { mode: 0o600 });
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it("moves plaintext secrets into the keychain and leaves only refs and comments behind", () => {
    const keychain = fakeKeychain();
    expect(migrateConfigSecrets(file, keychain.options)).toEqual({
      migrated: ["feishu.appSecret", "runner.token"],
      skipped: { "telegram.botToken": "missing" },
    });
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toMatch(/real-feishu-secret|real-runner-token/);
    expect(text).toContain("# my notes stay");
    expect(text).toContain("# keep me");
    expect(text).toMatch(/appSecret: keychain:codebridge\.[0-9a-f]{8}\.feishu\.appSecret/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const store = new ConfigStore({ dataDir, secrets: keychain.options });
    expect(store.get().feishu.appSecret).toBe("real-feishu-secret");
    expect(store.get().runner.token).toBe("real-runner-token-0123456789");
    expect(store.secretSources()).toEqual({ "feishu.appSecret": "keychain", "runner.token": "keychain", "telegram.botToken": "missing" });
    expect(migrateConfigSecrets(file, keychain.options).migrated).toEqual([]);
  });

  it("updates the real file behind a symlinked config.yaml", () => {
    const real = path.join(dataDir, "dotfiles-config.yaml");
    fs.renameSync(file, real);
    fs.symlinkSync(real, file);
    migrateConfigSecrets(file, fakeKeychain().options);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).not.toContain("real-feishu-secret");
  });

  it("keeps a non-default data dir's items separate and never overwrites a different existing value", () => {
    const keychain = fakeKeychain();
    migrateConfigSecrets(file, keychain.options);
    const service = [...keychain.items.keys()].find((name) => name.endsWith(".runner.token"))!;
    expect(service).toMatch(/^codebridge\.[0-9a-f]{8}\.runner\.token$/);

    fs.writeFileSync(file, CONFIG.replace("real-runner-token-0123456789", "other-runner-token-0123456789"));
    expect(() => migrateConfigSecrets(file, keychain.options)).toThrow("已存在且值不同，未做任何修改");
    expect(keychain.items.get(service)).toBe("real-runner-token-0123456789");
    expect(fs.readFileSync(file, "utf8")).toContain("other-runner-token-0123456789");
  });

  it("leaves config.yaml untouched when a secret does not read back", () => {
    expect(() => migrateConfigSecrets(file, fakeKeychain({ corrupt: true }).options)).toThrow("读回不一致，config.yaml 未修改");
    expect(fs.readFileSync(file, "utf8")).toBe(CONFIG);
  });
});
