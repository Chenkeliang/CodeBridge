import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSecretRef, type SecretCommand } from "@codebridge/core";
import { inspectRuntimeSecrets, migrateRuntimeSecrets } from "./runtime-secret-migration.js";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function fixture(fail = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-runtime-secrets-")); dirs.push(dir);
  fs.mkdirSync(path.join(dir, "deployer"));
  const controller = { token: "fixture-controller", runnerToken: "env:CB_TEST_RUNNER", ownerOpenId: "ou_owner", feishu: { appSecret: "fixture-feishu" } };
  fs.writeFileSync(path.join(dir, "deployer/config.json"), JSON.stringify(controller), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "publisher-tokens.json"), JSON.stringify([{ label: "timer", token: "fixture-publisher", chatId: "oc_test", routes: ["markdown"] }]), { mode: 0o600 });
  const items = new Map<string, string>();
  const run: SecretCommand = (_file, args, input) => {
    if (args[0] === "-i") {
      if (fail) throw new Error("fixture locked keychain");
      const match = /-s (\S+) -a codebridge -w "([^"]*)"/.exec(input ?? "")!;
      items.set(match[1]!, match[2]!); return "";
    }
    const value = items.get(args[args.indexOf("-s") + 1]!);
    if (!value) throw new Error("fixture missing key"); return value;
  };
  return { dir, secrets: { platform: "darwin" as const, run, env: { CB_TEST_RUNNER: "fixture-runner" } }, controller };
}
describe("runtime credential migration", () => {
  it("preserves credentials and destinations while replacing every plaintext JSON value", () => {
    const f = fixture();
    expect(migrateRuntimeSecrets(f.dir, f.secrets)).toEqual(["deployer.token", "deployer.feishu.appSecret", "publisher.timer.token"]);
    const controller = JSON.parse(fs.readFileSync(path.join(f.dir, "deployer/config.json"), "utf8"));
    const publisher = JSON.parse(fs.readFileSync(path.join(f.dir, "publisher-tokens.json"), "utf8"))[0];
    expect(controller.ownerOpenId).toBe("ou_owner"); expect(publisher.chatId).toBe("oc_test"); expect(publisher.routes).toEqual(["markdown"]);
    expect(resolveSecretRef(controller.token, f.secrets)).toBe(f.controller.token);
    expect(resolveSecretRef(controller.feishu.appSecret, f.secrets)).toBe(f.controller.feishu.appSecret);
    expect(resolveSecretRef(publisher.token, f.secrets)).toBe("fixture-publisher");
    expect(fs.readFileSync(path.join(f.dir, "deployer/config.json"), "utf8")).not.toContain("fixture-controller");
    expect(fs.statSync(path.join(f.dir, "publisher-tokens.json")).mode & 0o777).toBe(0o600);
    expect(migrateRuntimeSecrets(f.dir, f.secrets)).toEqual([]);
    expect(Object.values(inspectRuntimeSecrets(f.dir, f.secrets)).every((row) => row.readable && row.source !== "plaintext")).toBe(true);
  });
  it("leaves a live config unchanged when secure storage fails", () => {
    const f = fixture(true); const file = path.join(f.dir, "deployer/config.json"); const before = fs.readFileSync(file, "utf8");
    expect(() => migrateRuntimeSecrets(f.dir, f.secrets)).toThrow("fixture locked keychain");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(path.join(f.dir, "deployer"))).toEqual(["config.json"]);
  });
  it("reports malformed credential files without echoing file contents", () => {
    const f = fixture();fs.writeFileSync(path.join(f.dir, "publisher-tokens.json"), "invalid fixture-sensitive");
    const report = inspectRuntimeSecrets(f.dir, f.secrets);
    expect(report.runtime?.readable).toBe(false);expect(JSON.stringify(report)).not.toContain("fixture-sensitive");
  });
});
