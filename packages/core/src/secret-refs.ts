import { execFileSync } from "node:child_process";

/**
 * Config fields that may hold a secret reference instead of a plaintext value:
 *   env:NAME          read from the environment variable NAME
 *   keychain:SERVICE  macOS Keychain (security) or Linux Secret Service (secret-tool)
 */
export const SECRET_PATHS = [
  ["feishu", "appSecret"],
  ["runner", "token"],
  ["telegram", "botToken"],
] as const;

export type SecretPath = (typeof SECRET_PATHS)[number];
export type SecretSource = "keychain" | "env" | "plaintext" | "missing";

export const KEYCHAIN_ACCOUNT = "codebridge";
const PLACEHOLDERS = new Set(["secret_placeholder", "change-me-runner-token"]);

/** Runs a helper binary; `input` is written to stdin so secrets never appear in argv. */
export type SecretCommand = (file: string, args: string[], input?: string) => string;

export interface SecretOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: SecretCommand;
}

const defaultRun: SecretCommand = (file, args, input) =>
  execFileSync(file, args, { encoding: "utf8", input, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });

export function secretPathName(path: SecretPath): string {
  return path.join(".");
}

export function keychainServiceFor(path: SecretPath): string {
  return `codebridge.${secretPathName(path)}`;
}

export function isSecretRef(value: unknown): value is string {
  return typeof value === "string" && /^(env|keychain):\S+$/.test(value);
}

export function secretSourceOf(value: unknown): SecretSource {
  if (isSecretRef(value)) return value.startsWith("env:") ? "env" : "keychain";
  return typeof value === "string" && value !== "" ? "plaintext" : "missing";
}

/** A real plaintext secret worth migrating (not a default placeholder). */
export function isPlaintextSecret(value: unknown): value is string {
  return secretSourceOf(value) === "plaintext" && !PLACEHOLDERS.has(value as string);
}

export function resolveSecretRef(ref: string, options: SecretOptions = {}): string {
  const env = options.env ?? process.env;
  const run = options.run ?? defaultRun;
  const platform = options.platform ?? process.platform;
  const [kind, name] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
  let value: string | undefined;
  try {
    if (kind === "env") {
      value = env[name];
    } else if (platform === "darwin") {
      value = run("/usr/bin/security", ["find-generic-password", "-s", name, "-a", KEYCHAIN_ACCOUNT, "-w"]);
    } else if (platform === "linux") {
      value = run("secret-tool", ["lookup", "service", name, "account", KEYCHAIN_ACCOUNT]);
    } else {
      throw new Error(`当前平台 ${platform} 不支持 keychain 引用`);
    }
  } catch (error) {
    // Helper stderr never contains the secret; keep the cause readable.
    throw new Error(`读取密钥 ${ref} 失败：${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  const resolved = value?.replace(/\r?\n$/, "");
  if (!resolved) throw new Error(`读取密钥 ${ref} 失败：${kind === "env" ? "环境变量未设置" : "钥匙串中没有该条目"}`);
  return resolved;
}

export function storeKeychainSecret(service: string, value: string, options: SecretOptions = {}): void {
  const run = options.run ?? defaultRun;
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    // `security -i` reads the command from stdin; its parser has no escaping, so refuse
    // anything that could break out of the quoted argument instead of guessing.
    if (!/^[\x21-\x7e]+$/.test(value) || /["\\]/.test(value)) {
      throw new Error(`${service} 含引号、反斜杠或空白，无法安全写入钥匙串；请手动写入后改为 keychain:${service}`);
    }
    run("/usr/bin/security", ["-i"], `add-generic-password -U -s ${service} -a ${KEYCHAIN_ACCOUNT} -w "${value}"\n`);
  } else if (platform === "linux") {
    run("secret-tool", ["store", "--label", `CodeBridge ${service}`, "service", service, "account", KEYCHAIN_ACCOUNT], value);
  } else {
    throw new Error(`当前平台 ${platform} 不支持钥匙串`);
  }
}

export function getPath(root: unknown, path: readonly string[]): unknown {
  let node = root;
  for (const key of path) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Sets (or, for `undefined`, deletes) a nested value; never creates missing parents for a delete. */
export function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node = root;
  for (const key of path.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== "object") {
      if (value === undefined) return;
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  const last = path[path.length - 1]!;
  if (value === undefined) delete node[last];
  else node[last] = value;
}
