import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  ConfigSchema,
  defaultConfig,
  type AppConfig,
} from "./config-schema.js";
import { DEFAULT_DATA_DIR } from "./types.js";

export interface ConfigStoreOptions {
  dataDir?: string;
  configFileName?: string;
}

export class ConfigStore {
  private config: AppConfig;
  private readonly configPath: string;
  private listeners: Array<(config: AppConfig) => void> = [];

  constructor(options: ConfigStoreOptions = {}) {
    const dataDir = options.dataDir ?? process.env.DATA_DIR ?? DEFAULT_DATA_DIR;
    this.configPath = path.join(
      dataDir,
      options.configFileName ?? "config.yaml",
    );
    this.config = this.loadFromDisk();
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
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.configPath, stringifyYaml(this.config), "utf8");
  }

  private loadFromDisk(): AppConfig {
    const fromEnv = this.loadFromEnv();
    if (!fs.existsSync(this.configPath)) {
      if (Object.keys(fromEnv).length > 0) {
        return ConfigSchema.parse({ ...defaultConfig(), ...fromEnv });
      }
      return defaultConfig();
    }
    const raw = fs.readFileSync(this.configPath, "utf8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const merged = deepMerge(parsed, fromEnv);
    return ConfigSchema.parse(merged);
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
