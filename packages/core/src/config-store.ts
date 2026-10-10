import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  ConfigSchema,
  defaultConfig,
  type AppConfig,
} from "./config-schema.js";
import { DEFAULT_DATA_DIR } from "./types.js";
import {
  SECRET_PATHS,
  getPath,
  isSecretRef,
  resolveSecretRef,
  secretPathName,
  secretSourceOf,
  setPath,
  type SecretOptions,
  type SecretSource,
} from "./secret-refs.js";

export interface ConfigStoreOptions {
  dataDir?: string;
  configFileName?: string;
  secrets?: SecretOptions;
}

/** How a secret field was loaded, so persist() never writes a resolved/env value to disk. */
interface LoadedSecret {
  /** Value as written in config.yaml (a ref, plaintext, or absent). */
  disk: unknown;
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
    this.config = this.loadFromDisk();
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
    this.config = ConfigSchema.parse({ ...this.config, ...partial });
    this.persist();
    this.notify();
    return this.config;
  }

  update(mutator: (current: AppConfig) => AppConfig): AppConfig {
    this.config = ConfigSchema.parse(mutator(this.config));
    this.persist();
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
        setPath(output, secretPath, entry.disk);
      } else {
        this.secrets.set(name, { disk: current, loaded: current, external: false });
      }
    }
    fs.writeFileSync(this.configPath, stringifyYaml(output), {
      encoding: "utf8",
      mode: 0o600,
    });
    // writeFileSync's `mode` only applies when creating the file, so an
    // already-existing config.yaml keeps its prior permissions unless
    // explicitly tightened here.
    if (existed) fs.chmodSync(this.configPath, 0o600);
  }

  private loadFromDisk(): AppConfig {
    const fromEnv = this.loadFromEnv();
    if (!fs.existsSync(this.configPath)) {
      const config = Object.keys(fromEnv).length > 0
        ? ConfigSchema.parse({ ...defaultConfig(), ...fromEnv })
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
      if (isSecretRef(value)) setPath(resolved, secretPath, resolveSecretRef(value, this.secretOptions));
    }
    const config = ConfigSchema.parse(deepMerge(resolved, fromEnv));
    this.recordSecrets(disk, fromEnv, config);
    return config;
  }

  private recordSecrets(disk: Map<string, unknown>, fromEnv: Partial<AppConfig>, config: AppConfig): void {
    this.secrets = new Map(SECRET_PATHS.map((secretPath) => {
      const name = secretPathName(secretPath);
      const onDisk = disk.get(name);
      return [name, {
        disk: onDisk,
        loaded: getPath(config, secretPath),
        external: isSecretRef(onDisk) || getPath(fromEnv, secretPath) !== undefined,
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
        url: process.env.RUNNER_URL ?? "http://127.0.0.1:19789",
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
      out[key] = { ...(out[key] as object), ...(value as object) };
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
