import fs from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  ConfigSchema,
  defaultConfig,
  type AppConfig,
} from "./config-schema.js";
import { DEFAULT_DATA_DIR } from "./types.js";
import {
  SECRET_ENV_VARS,
  SECRET_PATHS,
  getPath,
  isSecretRef,
  resolveSecretRef,
  secretPathName,
  keychainServiceFor,
  storeKeychainSecret,
  secretSourceOf,
  setPath,
  type SecretOptions,
  type SecretSource,
} from "./secret-refs.js";

export interface ConfigStoreOptions {
  dataDir?: string;
  configFileName?: string;
  secrets?: SecretOptions;
  /**
   * Secret fields to resolve (e.g. ["runner.token"] for the Runner). Others keep their
   * ref text, so a process never fails on a secret it does not use. Default: all.
   */
  resolve?: readonly string[];
}

export interface SecretInspection {
  source: SecretSource;
  /** Whether the value (ref or env override) can be read right now. */
  readable: boolean;
  error?: string;
}

/** How a secret field was loaded, so persist() never writes a resolved/env value to disk. */
interface LoadedSecret {
  /** Value as written in config.yaml (a ref, plaintext, or absent). */
  disk: unknown;
  /** Env var that supplied the loaded value, if any. */
  envVar?: string;
  /** Value handed to the app after resolution and env overrides. */
  loaded: unknown;
  /** The loaded value came from a ref or an env override, not from plaintext on disk. */
  external: boolean;
}

export class ConfigStore {
  private config: AppConfig;
  private readonly configPath: string;
  private readonly secretOptions: SecretOptions;
  private secrets = new Map<string, LoadedSecret>();
  private listeners: Array<(config: AppConfig) => void> = [];

  constructor(options: ConfigStoreOptions = {}) {
    const dataDir = options.dataDir ?? process.env.DATA_DIR ?? DEFAULT_DATA_DIR;
    this.configPath = path.join(
      dataDir,
      options.configFileName ?? "config.yaml",
    );
    this.secretOptions = options.secrets ?? {};
    this.resolveFields = options.resolve;
    this.config = this.loadFromDisk();
  }

  private readonly resolveFields?: readonly string[];

  /**
   * Per-field secret report that never throws, for doctor/status: a broken ref is a
   * finding to show, not a reason to crash the diagnostic.
   */
  static inspectSecrets(configPath: string, options: SecretOptions = {}): Record<string, SecretInspection> {
    const parsed = fs.existsSync(configPath)
      ? ((parseYaml(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, unknown>)
      : {};
    const env = options.env ?? process.env;
    return Object.fromEntries(SECRET_PATHS.map((secretPath) => {
      const name = secretPathName(secretPath);
      const value = getPath(parsed, secretPath);
      const inspection: SecretInspection = { source: secretSourceOf(value), readable: true };
      if (env[SECRET_ENV_VARS[name]!]) return [name, inspection];
      if (isSecretRef(value)) {
        try {
          resolveSecretRef(value, options);
        } catch (error) {
          inspection.readable = false;
          inspection.error = error instanceof Error ? error.message : String(error);
        }
      } else if (inspection.source === "missing") {
        inspection.readable = false;
      }
      return [name, inspection];
    }));
  }

  /** Where each secret field comes from, as written on disk (no values). */
  secretSources(): Record<string, SecretSource> {
    return Object.fromEntries(SECRET_PATHS.map((secretPath) => {
      const entry = this.secrets.get(secretPathName(secretPath));
      return [secretPathName(secretPath), secretSourceOf(entry?.disk)];
    }));
  }

  /** The on-disk value of a secret field: a ref when one is configured. */
  diskSecret(name: string): unknown {
    return this.secrets.get(name)?.disk;
  }

  get path(): string {
    return this.configPath;
  }

  get(): AppConfig {
    return this.config;
  }

  reload(): AppConfig {
    this.config = this.loadFromDisk();
    this.notify();
    return this.config;
  }

  save(partial: Partial<AppConfig>): AppConfig {
    return this.update((current) => ({ ...current, ...partial }));
  }

  update(mutator: (current: AppConfig) => AppConfig): AppConfig {
    const previous = this.config;
    const previousSecrets = new Map(this.secrets);
    this.config = ConfigSchema.parse(mutator(structuredClone(previous)));
    try { this.persist(); }
    catch (error) {
      this.config = previous;
      this.secrets = previousSecrets;
      throw error;
    }
    this.notify();
    return this.config;
  }

  onChange(listener: (config: AppConfig) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notify(): void {
    for (const l of this.listeners) l(this.config);
  }

  private persist(): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const existed = fs.existsSync(this.configPath);
    const output = structuredClone(this.config) as unknown as Record<string, unknown>;
    for (const secretPath of SECRET_PATHS) {
      const name = secretPathName(secretPath);
      const entry = this.secrets.get(name);
      const current = getPath(output, secretPath);
      if (entry?.external && current === entry.loaded) {
        // Unchanged value from a ref or env: write back what was on disk, never the secret.
        // Env-only values become an env: ref so the file still loads where that env is set.
        setPath(output, secretPath, secretSourceOf(entry.disk) === "plaintext" && entry.envVar
          ? `env:${entry.envVar}` : entry.disk ?? (entry.envVar ? `env:${entry.envVar}` : undefined));
      } else if (typeof current === "string" && secretSourceOf(current) === "plaintext") {
        const service = `${keychainServiceFor(secretPath, dir)}.saved-${randomBytes(12).toString("hex")}`;
        storeKeychainSecret(service, current, this.secretOptions);
        const ref = `keychain:${service}`;
        if (resolveSecretRef(ref, this.secretOptions) !== current) throw new Error(`${name} 钥匙串读回校验失败，配置未写入`);
        setPath(output, secretPath, ref);
        this.secrets.set(name, { disk: ref, loaded: current, external: true });
      } else {
        this.secrets.set(name, { disk: current, loaded: current, external: false });
      }
    }
    const target = existed ? fs.realpathSync(this.configPath) : this.configPath;
    const temporary = `${target}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, stringifyYaml(output), { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, target);
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  private loadFromDisk(): AppConfig {
    const fromEnv = this.loadFromEnv();
    if (!fs.existsSync(this.configPath)) {
      const config = Object.keys(fromEnv).length > 0
        ? ConfigSchema.parse(deepMerge(defaultConfig() as unknown as Record<string, unknown>, fromEnv))
        : defaultConfig();
      this.recordSecrets(new Map(), fromEnv, config);
      return config;
    }
    const raw = fs.readFileSync(this.configPath, "utf8");
    const parsed = (parseYaml(raw) ?? {}) as Record<string, unknown>;
    const disk = new Map(SECRET_PATHS.map((secretPath) => [secretPathName(secretPath), getPath(parsed, secretPath)]));
    const resolved = structuredClone(parsed);
    for (const secretPath of SECRET_PATHS) {
      const value = getPath(resolved, secretPath);
      const wanted = !this.resolveFields || this.resolveFields.includes(secretPathName(secretPath));
      // An env override wins anyway; do not fail on a ref it replaces.
      if (isSecretRef(value) && wanted && getPath(fromEnv, secretPath) === undefined) {
        setPath(resolved, secretPath, resolveSecretRef(value, this.secretOptions));
      }
    }
    const config = ConfigSchema.parse(deepMerge(resolved, fromEnv));
    this.recordSecrets(disk, fromEnv, config);
    return config;
  }

  private recordSecrets(disk: Map<string, unknown>, fromEnv: Partial<AppConfig>, config: AppConfig): void {
    this.secrets = new Map(SECRET_PATHS.map((secretPath) => {
      const name = secretPathName(secretPath);
      const onDisk = disk.get(name);
      const fromEnvValue = getPath(fromEnv, secretPath) !== undefined;
      return [name, {
        disk: onDisk,
        envVar: fromEnvValue ? SECRET_ENV_VARS[name] : undefined,
        loaded: getPath(config, secretPath),
        external: isSecretRef(onDisk) || fromEnvValue,
      }];
    }));
  }

  private loadFromEnv(): Partial<AppConfig> {
    const result: Record<string, unknown> = {};
    if (process.env.FEISHU_APP_ID || process.env.FEISHU_APP_SECRET) {
      result.feishu = {
        domain: process.env.FEISHU_DOMAIN ?? "https://open.feishu.cn",
        appId: process.env.FEISHU_APP_ID,
        appSecret: process.env.FEISHU_APP_SECRET,
      };
    }
    if (process.env.RUNNER_URL || process.env.RUNNER_TOKEN) {
      result.runner = {
        url: process.env.RUNNER_URL,
        token: process.env.RUNNER_TOKEN,
      };
    }
    if (process.env.TELEGRAM_BOT_TOKEN) {
      result.telegram = {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
      };
    }
    if (process.env.DEFAULT_BACKEND) {
      result.defaultBackend = process.env.DEFAULT_BACKEND;
    }
    return result as Partial<AppConfig>;
  }
}

function deepMerge(
  base: Record<string, unknown>,
  override: Partial<AppConfig>,
): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof out[key] === "object" &&
      out[key] !== null &&
      !Array.isArray(out[key])
    ) {
      // Skip undefined: RUNNER_URL alone must not blank a runner.token from disk.
      const defined = Object.fromEntries(Object.entries(value as object).filter(([, v]) => v !== undefined));
      out[key] = { ...(out[key] as object), ...defined };
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
