import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import {
  SECRET_PATHS,
  isPlaintextSecret,
  keychainServiceFor,
  resolveSecretRef,
  secretPathName,
  secretSourceOf,
  storeKeychainSecret,
  type SecretOptions,
} from "./secret-refs.js";

export interface SecretMigration {
  migrated: string[];
  /** Field name -> why it was left as is (already a ref, missing, placeholder). */
  skipped: Record<string, string>;
}

function readKeychain(service: string, options: SecretOptions): string | undefined {
  try {
    return resolveSecretRef(`keychain:${service}`, options);
  } catch {
    return undefined;
  }
}

/**
 * Move plaintext secrets from config.yaml into the OS keychain and replace them with
 * keychain: refs. Nothing is written if any target item already holds a different value;
 * each secret is read back before the file changes, and the file is rewritten once,
 * atomically, keeping comments. A symlinked config.yaml is updated at its real target.
 */
export function migrateConfigSecrets(configPath: string, options: SecretOptions = {}): SecretMigration {
  const target = fs.realpathSync(configPath);
  const dataDir = path.dirname(configPath);
  const doc = parseDocument(fs.readFileSync(target, "utf8"));
  const result: SecretMigration = { migrated: [], skipped: {} };
  const plan: Array<{ secretPath: (typeof SECRET_PATHS)[number]; service: string; value: string; stored: boolean }> = [];
  for (const secretPath of SECRET_PATHS) {
    const name = secretPathName(secretPath);
    const value = doc.getIn(secretPath);
    if (!isPlaintextSecret(value)) {
      result.skipped[name] = secretSourceOf(value);
      continue;
    }
    const service = keychainServiceFor(secretPath, dataDir);
    const existing = readKeychain(service, options);
    if (existing !== undefined && existing !== value) {
      throw new Error(`钥匙串条目 ${service} 已存在且值不同，未做任何修改（可能属于另一套 CodeBridge 配置）`);
    }
    plan.push({ secretPath, service, value, stored: existing === value });
  }
  for (const item of plan) {
    if (!item.stored) storeKeychainSecret(item.service, item.value, options);
    if (readKeychain(item.service, options) !== item.value) {
      throw new Error(`${secretPathName(item.secretPath)} 写入钥匙串后读回不一致，config.yaml 未修改`);
    }
    doc.setIn(item.secretPath, `keychain:${item.service}`);
    result.migrated.push(secretPathName(item.secretPath));
  }
  if (result.migrated.length) {
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, doc.toString(), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, target);
  }
  return result;
}
