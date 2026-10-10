import fs from "node:fs";
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

/**
 * Move plaintext secrets from config.yaml into the OS keychain and replace them with
 * keychain: refs. Each secret is read back before the file changes; the file is rewritten
 * once, atomically, keeping comments and layout.
 */
export function migrateConfigSecrets(configPath: string, options: SecretOptions = {}): SecretMigration {
  const doc = parseDocument(fs.readFileSync(configPath, "utf8"));
  const result: SecretMigration = { migrated: [], skipped: {} };
  for (const secretPath of SECRET_PATHS) {
    const name = secretPathName(secretPath);
    const value = doc.getIn(secretPath);
    if (!isPlaintextSecret(value)) {
      result.skipped[name] = secretSourceOf(value) === "plaintext" ? "placeholder" : secretSourceOf(value);
      continue;
    }
    const service = keychainServiceFor(secretPath);
    storeKeychainSecret(service, value, options);
    if (resolveSecretRef(`keychain:${service}`, options) !== value) {
      throw new Error(`${name} 写入钥匙串后读回不一致，config.yaml 未修改`);
    }
    doc.setIn(secretPath, `keychain:${service}`);
    result.migrated.push(name);
  }
  if (result.migrated.length) {
    const temporary = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, doc.toString(), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, configPath);
  }
  return result;
}
