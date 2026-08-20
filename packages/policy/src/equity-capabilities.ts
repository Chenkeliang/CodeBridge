import type { CapabilityRegistry } from "./index.js";
import { FunctionCapabilityAdapter, type CapabilityRuntime } from "./capability-runtime.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * 真实领域示例：权益余额查询（只读）。演示「维护一个真实 Flow」需要
 * 一个 registry+runtime 都注册的 adapter；发布门槛（publishIssues）要求
 * 每步 capability 有定义、有可执行 adapter、非 forwardToAgent。
 */
export function registerEquityCapabilities(
  registry: CapabilityRegistry,
  runtime: CapabilityRuntime,
): void {
  const source = { kind: "function" as const, ref: "equity", version: "1" };
  registry.register({
    id: "equity.balance",
    risk: "read_only",
    adapter: "equity.balance",
    side_effects: false,
    description: "查询用户权益余额（只读）",
    source,
  });
  runtime.register(new FunctionCapabilityAdapter("equity.balance", ({ input }) => {
    const userId = String(input.user_id ?? "");
    const prior = asRecord(asRecord(input.step_outputs).lookup);
    const balance = typeof prior.balance === "number" ? prior.balance : 0;
    return {
      output: {
        user_id: userId,
        balance,
        currency: "CNY",
        updated_at: new Date().toISOString(),
      },
    };
  }));
}