import type { CapabilityRegistry } from "./index.js";
import { FunctionCapabilityAdapter, type CapabilityRuntime } from "./capability-runtime.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function registerDemoCapabilities(
  registry: CapabilityRegistry,
  runtime: CapabilityRuntime,
): void {
  const source = { kind: "function" as const, ref: "demo", version: "1" };
  registry.register({
    id: "demo.echo",
    risk: "read_only",
    adapter: "demo.echo",
    side_effects: false,
    description: "Echo input.text",
    source,
  });
  registry.register({
    id: "demo.concat",
    risk: "read_only",
    adapter: "demo.concat",
    side_effects: false,
    description: "Concat resolved text with prior echo output",
    source,
  });
  runtime.register(new FunctionCapabilityAdapter("demo.echo", ({ input }) => {
    const text = String(input.text ?? "");
    return { output: { text } };
  }));
  runtime.register(new FunctionCapabilityAdapter("demo.concat", ({ input }) => {
    const echo = asRecord(asRecord(input.step_outputs).echo);
    const text = String(echo.text ?? input.text ?? "");
    const prefix = String(input.prefix ?? "");
    return { output: { result: `${prefix}${text}` } };
  }));
}
