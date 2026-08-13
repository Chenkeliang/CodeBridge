import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Pi provider management: validated read/write of `~/.pi/agent/models.json`
 * plus the built-in vendor preset catalog. See docs/orchestration/agent-providers.md.
 *
 * Security boundary: this module runs on the Runner host only; credentials
 * never leave the machine and must not be logged by callers.
 */

export type ThinkingLevelKey = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiProviderModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevelKey, string | null>>;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface PiProvider {
  baseUrl: string;
  api: string;
  apiKey?: string;
  authHeader?: boolean;
  models: PiProviderModel[];
  [key: string]: unknown;
}

export interface PiProvidersFile {
  providers: Record<string, PiProvider>;
}

export interface PiProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  models: PiProviderModel[];
}

const OPENAI_LEVEL_MAP: PiProviderModel["thinkingLevelMap"] = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
};

/** Vendor presets: templates only — never include credentials. */
export const PI_PROVIDER_PRESETS: PiProviderPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat", reasoning: false, contextWindow: 128000, maxTokens: 8192, input: ["text"] },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner", reasoning: true, contextWindow: 128000, maxTokens: 65536, input: ["text"], thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high" } },
    ],
  },
  {
    id: "glm",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
    models: [
      { id: "glm-4.6", name: "GLM-4.6", reasoning: true, contextWindow: 200000, maxTokens: 131072, input: ["text"], thinkingLevelMap: OPENAI_LEVEL_MAP },
      { id: "glm-4.6-air", name: "GLM-4.6 Air", reasoning: true, contextWindow: 131072, maxTokens: 131072, input: ["text"], thinkingLevelMap: OPENAI_LEVEL_MAP },
    ],
  },
  {
    id: "kimi",
    name: "Kimi(月之暗面)",
    baseUrl: "https://api.moonshot.cn/v1",
    api: "openai-completions",
    models: [
      { id: "kimi-k2-0905-preview", name: "Kimi K2", reasoning: false, contextWindow: 262144, maxTokens: 16384, input: ["text"] },
    ],
  },
  {
    id: "qwen",
    name: "通义 Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    models: [
      { id: "qwen3-max", name: "Qwen3 Max", reasoning: false, contextWindow: 262144, maxTokens: 65536, input: ["text"] },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    models: [],
  },
];

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function piModelsPath(): string {
  return path.join(getAgentDir(), "models.json");
}

export function validateProviders(input: unknown): string[] {
  const issues: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["providers 必须是对象"];
  const file = input as Record<string, unknown>;
  if (!file.providers || typeof file.providers !== "object" || Array.isArray(file.providers)) {
    return ["缺少 providers 对象"];
  }
  for (const [id, raw] of Object.entries(file.providers as Record<string, unknown>)) {
    if (!PROVIDER_ID_RE.test(id)) issues.push(`provider id 不合法: ${id}(小写字母/数字/连字符)`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { issues.push(`${id}: 必须是对象`); continue; }
    const provider = raw as Record<string, unknown>;
    if (typeof provider.baseUrl !== "string" || !/^https?:\/\//.test(provider.baseUrl)) {
      issues.push(`${id}: baseUrl 必须是 http(s) URL`);
    }
    if (typeof provider.api !== "string" || !provider.api.trim()) issues.push(`${id}: 缺少 api 协议`);
    if (!Array.isArray(provider.models)) { issues.push(`${id}: models 必须是数组`); continue; }
    const modelIds = new Set<string>();
    for (const [index, modelRaw] of provider.models.entries()) {
      const model = modelRaw as Record<string, unknown>;
      const label = `${id}.models[${index}]`;
      if (typeof model?.id !== "string" || !model.id.trim()) { issues.push(`${label}: 缺少 id`); continue; }
      if (modelIds.has(model.id)) issues.push(`${label}: 模型 id 重复: ${model.id}`);
      modelIds.add(model.id);
      if (model.reasoning === true) {
        const map = model.thinkingLevelMap as Record<string, unknown> | undefined;
        const usable = map && Object.values(map).some((value) => typeof value === "string" && value);
        if (!usable) issues.push(`${label}: reasoning 为 true 时 thinkingLevelMap 至少需要一个有效档位`);
      }
    }
  }
  return issues;
}

export function readPiProviders(modelsPath = piModelsPath()): PiProvidersFile {
  if (!fs.existsSync(modelsPath)) return { providers: {} };
  const raw = fs.readFileSync(modelsPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const issues = validateProviders(parsed);
  if (issues.length) throw new Error(`models.json 校验失败: ${issues.join("; ")}`);
  return parsed as PiProvidersFile;
}

export function writePiProviders(file: PiProvidersFile, modelsPath = piModelsPath()): void {
  const issues = validateProviders(file);
  if (issues.length) throw new Error(issues.join("; "));
  fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
  if (fs.existsSync(modelsPath)) {
    fs.copyFileSync(modelsPath, `${modelsPath}.bak`);
  }
  const tmp = `${modelsPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
  fs.renameSync(tmp, modelsPath);
}

export async function testPiProviderConnection(provider: Pick<PiProvider, "baseUrl" | "apiKey" | "authHeader">): Promise<{ ok: boolean; detail: string }> {
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const headers: Record<string, string> = {};
    if (provider.apiKey) {
      if (provider.authHeader) headers["authorization"] = `Bearer ${provider.apiKey}`;
      else headers["x-api-key"] = provider.apiKey;
    }
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
    if (response.ok) return { ok: true, detail: `连接成功(HTTP ${response.status})` };
    const hint = response.status === 401 || response.status === 403 ? "API key 无效或无权限" : `HTTP ${response.status}`;
    return { ok: false, detail: hint };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOTFOUND")) return { ok: false, detail: "域名无法解析,检查 baseUrl" };
    if (message.includes("TimeoutError") || message.includes("timed out")) return { ok: false, detail: "连接超时(5s)" };
    return { ok: false, detail: message };
  }
}
