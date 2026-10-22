import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getPath, setPath, isPlaintextSecret, isSecretRef, keychainServiceFor, resolveSecretRef, storeKeychainSecret, secretSourceOf, type SecretInspection, type SecretOptions } from "@codebridge/core";

function readJson(file: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(`运行凭据文件格式错误：${file}`); }
}

type SecretField = { path: string[]; service: string[]; name: string };
function files(dataDir: string): Array<{ file: string; data: Record<string, unknown>; fields: SecretField[] }> {
  const result: Array<{ file: string; data: Record<string, unknown>; fields: SecretField[] }> = [];
  const deployer = path.join(dataDir, "deployer", "config.json");
  if (fs.existsSync(deployer)) result.push({ file: fs.realpathSync(deployer), data: readJson(deployer), fields: [
    { path: ["token"], service: ["deployer", "token"], name: "deployer.token" },
    { path: ["runnerToken"], service: ["deployer", "runnerToken"], name: "deployer.runnerToken" },
    { path: ["feishu", "appSecret"], service: ["deployer", "feishu", "appSecret"], name: "deployer.feishu.appSecret" },
  ] });
  const publisher = path.join(dataDir, "publisher-tokens.json");
  if (fs.existsSync(publisher)) {
    const entries = readJson(publisher);
    if (!Array.isArray(entries)) throw new Error("publisher-tokens.json 必须是数组");
    result.push({ file: fs.realpathSync(publisher), data: entries as unknown as Record<string, unknown>, fields: entries.map((entry, index) => ({
      path: [String(index), "token"], service: ["publisher", createHash("sha256").update(`${entry.label}\0${entry.token}`).digest("hex").slice(0, 24)], name: `publisher.${entry.label}.token`,
    })) });
  }
  return result;
}

export function inspectRuntimeSecrets(dataDir: string, options: SecretOptions = {}): Record<string, SecretInspection> {
  const report: Record<string, SecretInspection> = {};
  let entries: ReturnType<typeof files>;
  try { entries = files(dataDir); } catch { return { runtime: { source: "missing", readable: false, error: "运行凭据文件格式错误" } }; }
  for (const item of entries) for (const field of item.fields) {
    const value = getPath(item.data, field.path);
    const inspection: SecretInspection = { source: secretSourceOf(value), readable: true };
    if (isSecretRef(value)) {
      try { resolveSecretRef(value, options); } catch { inspection.readable = false; inspection.error = "密钥引用不可读"; }
    } else if (!value) inspection.readable = false;
    report[field.name] = inspection;
  }
  return report;
}

/** Keep credential values unchanged; verify Keychain before atomically changing each JSON file. */
export function migrateRuntimeSecrets(dataDir: string, options: SecretOptions = {}): string[] {
  const migrated: string[] = [];
  for (const item of files(dataDir)) {
    let changed = false;
    for (const field of item.fields) {
      const value = getPath(item.data, field.path);
      if (!isPlaintextSecret(value)) continue;
      const service = keychainServiceFor(field.service, dataDir);
      let existing: string | undefined;
      try { existing = resolveSecretRef(`keychain:${service}`, options); } catch { /* A new item is expected. */ }
      if (existing !== undefined && existing !== value) throw new Error(`${field.name} 已存在不同的钥匙串条目，未覆盖`);
      if (existing === undefined) storeKeychainSecret(service, value, options);
      if (resolveSecretRef(`keychain:${service}`, options) !== value) throw new Error(`${field.name} 钥匙串校验失败，文件未修改`);
      setPath(item.data, field.path, `keychain:${service}`);
      migrated.push(field.name); changed = true;
    }
    if (changed) {
      const temporary = `${item.file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(temporary, `${JSON.stringify(item.data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, item.file);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
  }
  return migrated;
}
