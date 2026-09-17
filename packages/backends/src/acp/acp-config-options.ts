import {
  methods,
  type ClientConnection,
  type SessionConfigOption,
  type SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import type {
  AcpPermissionPolicy,
  BackendConfigOption,
  RunContext,
} from "@codebridge/core";

type Agent = ClientConnection["agent"];

export interface DesiredSessionConfig {
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** true 时，想要的 model 不在适配器可选值内会直接抛错中止本轮，而非静默沿用适配器默认 */
  strictModel?: boolean;
}

export type CustomSessionConfig = Record<string, string | boolean>;

/** 展平 select 选项（可能是「分组」结构），拿到全部可选值 */
function flattenSelectOptions(
  option: SessionConfigOption,
): SessionConfigSelectOption[] {
  if (option.type !== "select") return [];
  const out: SessionConfigSelectOption[] = [];
  for (const entry of option.options) {
    if ("group" in entry) out.push(...entry.options);
    else out.push(entry);
  }
  return out;
}

/**
 * 把用户输入（如 `sonnet` / `opus` / `medium`）匹配到 advertise 的某个 value id：
 * 精确 value → 大小写不敏感 name → 大小写不敏感 value 前缀（把 `opus` 映射到 `opus[1m]`）。
 * 匹配不到返回 undefined。
 */
export function matchConfigValue(
  option: SessionConfigOption,
  desired: string,
): string | undefined {
  const opts = flattenSelectOptions(option);
  const want = desired.trim().toLowerCase();
  return (
    opts.find((o) => o.value.toLowerCase() === want)?.value ??
    opts.find((o) => o.name.toLowerCase() === want)?.value ??
    opts.find((o) => o.value.toLowerCase().startsWith(want))?.value
  );
}

/**
 * 由 RunContext + 全局 permission 策略解析本轮想要的三项 ACP 配置：
 * - model/effort：有则设、无则不设（尊重适配器默认）；
 * - mode：三个后端都接受 `/permission` 的显式会话覆盖；Claude 未覆盖时再使用兼容配置或
 *   acpPermissionPolicy 推导默认值，让 requestPermission 处理器与全局策略保持一致。
 */
export function resolveDesiredConfig(
  ctx: RunContext,
  permissionPolicy: AcpPermissionPolicy,
): DesiredSessionConfig {
  const bc = ctx.backendConfig;
  const desired: DesiredSessionConfig = {
    model: ctx.model ?? bc.model,
    effort: ctx.effort ?? bc.effort,
    permissionMode: ctx.mode,
    strictModel: bc.strictModel ?? false,
  };
  if (bc.type === "claude-code") {
    // prompt_deny / prompt_feishu 都需要适配器真的「发问」（default 模式）：
    // prompt_deny 由客户端 handler 拒，prompt_feishu 转发飞书等 /approve。
    // 只有 auto_allow 才使用 bypassPermissions（不问直接放行）。
    desired.permissionMode ??=
      ctx.claudePermissionMode ??
      bc.claudePermissionMode ??
      (permissionPolicy === "auto_allow" ? "bypassPermissions" : "default");
  }
  return desired;
}

/**
 * 把 SDK 的 configOptions（含分组 select）映射为跨包共享的精简形态，供 /model 等
 * 动态列表展示。select 和 boolean 都保留，供 /model 与通用 /config 使用。
 */
export function mapSessionConfigOptions(
  options: SessionConfigOption[],
): BackendConfigOption[] {
  const out: BackendConfigOption[] = [];
  for (const option of options) {
    if (option.type === "boolean") {
      out.push({
        id: option.id,
        name: option.name,
        type: "boolean",
        category: option.category ?? undefined,
        currentValue: String(option.currentValue),
        values: [
          { value: "true", name: "On" },
          { value: "false", name: "Off" },
        ],
      });
      continue;
    }
    out.push({
      id: option.id,
      name: option.name,
      type: "select",
      category: option.category ?? undefined,
      currentValue: option.currentValue,
      values: flattenSelectOptions(option).map((v) => ({
        value: v.value,
        name: v.name || undefined,
        description: v.description ?? undefined,
      })),
    });
  }
  return out;
}

/** desired 里想设的项与 advertise 选项的 category 映射 */
const CATEGORY_BY_FIELD = {
  model: "model",
  effort: "thought_level",
  permissionMode: "mode",
} as const;

/**
 * 会话打开后、首个 prompt 之前，用 ACP 标准 `session/set_config_option`（Zed 同款机制）把
 * 想要的 model/effort/permission 应用到会话上。适配器 advertise 的选项来自
 * `newSessionResponse.configOptions`（新建 + claude 续聊均带）。每次运行都要重设：续聊到新
 * 适配器进程时 model 会退回适配器默认（实测 Fable 5）。匹配不到的项只收集非致命 warning、不中断
 * ——适配器没有对应 category 时就自然跳过（除非 desired.strictModel 对 model 字段要求硬失败）。
 */
export async function applySessionConfigOptions(
  agent: Agent,
  sessionId: string,
  configOptions: SessionConfigOption[],
  desired: DesiredSessionConfig,
  custom: CustomSessionConfig = {},
): Promise<{
  warnings: string[];
  configOptions: SessionConfigOption[];
  /** model 分类选项在本轮 set-config 回合后的实际 currentValue（可能与 desired.model 不同） */
  effectiveModel?: string;
  /** desired.model 未被适配器采纳时的请求值/实际生效值对照，供上层告知用户。
   *  effective 缺省表示适配器没有报告实际模型，此时不要编造一个名字。 */
  modelMismatch?: { requested: string; effective?: string; effectiveName?: string };
}> {
  const warnings: string[] = [];
  let currentOptions = configOptions;
  let modelMismatch:
    | { requested: string; effective?: string; effectiveName?: string }
    | undefined;
  for (const [field, category] of Object.entries(CATEGORY_BY_FIELD)) {
    const wanted = desired[field as keyof DesiredSessionConfig];
    if (!wanted || typeof wanted !== "string") continue;
    const option = currentOptions.find((o) => o.category === category);
    if (!option) {
      if (field === "model" && desired.strictModel) {
        throw new Error(
          `ACP model=${wanted} 未生效：当前会话未提供 model 配置项（strictModel 已启用，本轮已终止）。`,
        );
      }
      warnings.push(`ACP 会话未提供 ${field} 选项，${field}=${wanted} 未生效。`);
      if (field === "model") modelMismatch = { requested: wanted };
      continue;
    }
    const value = matchConfigValue(option, wanted);
    if (!value) {
      if (field === "model" && desired.strictModel) {
        throw new Error(
          `ACP model=${wanted} 不在可选值内（strictModel 已启用，本轮已终止）。`,
        );
      }
      warnings.push(`ACP ${field}=${wanted} 不在可选值内，未生效。`);
      if (field === "model") {
        modelMismatch = {
          requested: wanted,
          ...(typeof option.currentValue === "string"
            ? { effective: option.currentValue }
            : {}),
        };
      }
      continue;
    }
    try {
      const response = await agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: option.id,
        value,
      });
      currentOptions = response.configOptions;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`ACP 设置 ${field}=${value} 失败：${msg}`);
      if (field === "model") {
        modelMismatch = {
          requested: wanted,
          ...(typeof option.currentValue === "string"
            ? { effective: option.currentValue }
            : {}),
        };
      }
    }
  }
  for (const [configId, wanted] of Object.entries(custom)) {
    const option = currentOptions.find((candidate) => candidate.id === configId);
    if (!option) {
      warnings.push(`ACP config=${configId} 未在当前会话能力中找到，未生效。`);
      continue;
    }
    let params:
      | { sessionId: string; configId: string; type: "boolean"; value: boolean }
      | { sessionId: string; configId: string; value: string };
    if (option.type === "boolean") {
      if (typeof wanted !== "boolean") {
        warnings.push(`ACP config=${configId} 需要 boolean 值，未生效。`);
        continue;
      }
      params = { sessionId, configId, type: "boolean", value: wanted };
    } else {
      if (typeof wanted !== "string") {
        warnings.push(`ACP config=${configId} 需要 select 值，未生效。`);
        continue;
      }
      const value = matchConfigValue(option, wanted);
      if (!value) {
        warnings.push(`ACP config=${configId}=${wanted} 不在可选值内，未生效。`);
        continue;
      }
      params = { sessionId, configId, value };
    }
    try {
      const response = (await agent.request(
        methods.agent.session.setConfigOption,
        params,
      )) as { configOptions: SessionConfigOption[] };
      currentOptions = response.configOptions;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`ACP 设置 config=${configId} 失败：${msg}`);
    }
  }
  // 读回本轮 set-config 回合后 model 分类的实际 currentValue：适配器可能规范化了 value，
  // 或（未 strictModel 时）压根没采纳 desired.model，这里给上层一个真相来源而非「想要的值」。
  const modelOption = currentOptions.find((o) => o.category === "model");
  const modelCurrentValue = modelOption?.currentValue;
  const effectiveModel =
    typeof modelCurrentValue === "string" ? modelCurrentValue : undefined;
  if (modelMismatch && effectiveModel !== undefined) {
    modelMismatch = { ...modelMismatch, effective: effectiveModel };
  }
  // 适配器的 value 是机器口径（`opus[1m]`、`grok-4.6[effort=high,fast=true]`），
  // 同一条目自带可读的 name（`Opus 5`、`grok-4.6`）。带上 name，让上层能说人话。
  if (modelMismatch?.effective && modelOption) {
    const name = flattenSelectOptions(modelOption).find(
      (candidate) => candidate.value === modelMismatch!.effective,
    )?.name;
    if (name && name !== modelMismatch.effective) {
      modelMismatch = { ...modelMismatch, effectiveName: name };
    }
  }
  return { warnings, configOptions: currentOptions, effectiveModel, modelMismatch };
}
