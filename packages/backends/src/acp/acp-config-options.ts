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
} from "@feishu-code-bridge/core";

type Agent = ClientConnection["agent"];

export interface DesiredSessionConfig {
  model?: string;
  effort?: string;
  permissionMode?: string;
}

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
 * 由 RunContext + 全局 permission 策略解析本轮想要的三项配置，镜像 CLI 路径
 * （`backends/src/index.ts` 的 `ctx.X ?? profile.X`）：
 * - model/effort：有则设、无则不设（尊重适配器默认）；
 * - permission-mode：仅 claude 后端。显式（`/permission` 或配置）优先；否则按全局 acpPermissionPolicy
 *   给默认——`auto_allow` 对齐 CLI 的 `bypassPermissions`，`prompt_deny` 退回会提示的 `default`，
 *   让客户端 requestPermission 处理器仍能拒，避免与全局策略冲突。
 */
export function resolveDesiredConfig(
  ctx: RunContext,
  permissionPolicy: AcpPermissionPolicy,
): DesiredSessionConfig {
  const bc = ctx.backendConfig;
  const desired: DesiredSessionConfig = {
    model: ctx.model ?? bc.model,
    effort: ctx.effort ?? bc.effort,
  };
  if (bc.type === "claude-code") {
    desired.permissionMode =
      ctx.claudePermissionMode ??
      bc.claudePermissionMode ??
      (permissionPolicy === "prompt_deny" ? "default" : "bypassPermissions");
  }
  return desired;
}

/**
 * 把 SDK 的 configOptions（含分组 select）映射为跨包共享的精简形态，供 /model 等
 * 动态列表展示。仅保留 select 型选项；boolean 型（实验性）对列表场景无意义，跳过。
 */
export function mapSessionConfigOptions(
  options: SessionConfigOption[],
): BackendConfigOption[] {
  const out: BackendConfigOption[] = [];
  for (const option of options) {
    if (option.type !== "select") continue;
    out.push({
      id: option.id,
      name: option.name,
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
 * ——非 claude 后端没有 thought_level/mode 就自然跳过。
 */
export async function applySessionConfigOptions(
  agent: Agent,
  sessionId: string,
  configOptions: SessionConfigOption[],
  desired: DesiredSessionConfig,
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  for (const [field, category] of Object.entries(CATEGORY_BY_FIELD)) {
    const wanted = desired[field as keyof DesiredSessionConfig];
    if (!wanted) continue;
    const option = configOptions.find((o) => o.category === category);
    if (!option) {
      warnings.push(`ACP 会话未提供 ${field} 选项，${field}=${wanted} 未生效。`);
      continue;
    }
    const value = matchConfigValue(option, wanted);
    if (!value) {
      warnings.push(`ACP ${field}=${wanted} 不在可选值内，未生效。`);
      continue;
    }
    try {
      await agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: option.id,
        value,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`ACP 设置 ${field}=${value} 失败：${msg}`);
    }
  }
  return { warnings };
}
