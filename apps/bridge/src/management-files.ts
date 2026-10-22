import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { keychainServiceFor, resolveSecretRef, storeKeychainSecret, type SecretOptions } from "@codebridge/core";

export function fileRevision(file: string): string {
  return createHash("sha256").update(fs.existsSync(file) ? fs.readFileSync(file) : "missing").digest("hex");
}

/** Preserve untracked user data before replacement, without creating plaintext credential backups. */
export function replaceManagedFile(file: string, content: string, expected: string, dataDir: string, secrets?: SecretOptions) {
  const target = fs.realpathSync(file);
  if (fileRevision(target) !== expected) throw new Error("文件已被其他程序修改，请重新读取后再保存");
  const previous = fs.readFileSync(target);
  const id = `${Date.now()}-${randomUUID()}`;
  const service = keychainServiceFor(["management-backup", id], dataDir);
  const key = randomBytes(32);
  storeKeychainSecret(service, key.toString("base64"), secrets);
  if (resolveSecretRef(`keychain:${service}`, secrets) !== key.toString("base64")) throw new Error("备份密钥读回失败，原文件未修改");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(previous), cipher.final()]);
  const dir = path.join(dataDir, "management-backups");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const backup = path.join(dir, `${id}.json`);
  fs.writeFileSync(backup, JSON.stringify({ target, revision: expected, keyRef: `keychain:${service}`, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: encrypted.toString("base64") }), { mode: 0o600, flag: "wx" });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: fs.statSync(target).mode & 0o777, flag: "wx" });
    if (fileRevision(target) !== expected) throw new Error("文件已改变，保留备份且未覆盖当前内容");
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
  return { revision: fileRevision(target), backup };
}
