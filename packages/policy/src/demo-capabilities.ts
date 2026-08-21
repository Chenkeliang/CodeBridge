import type { CapabilityRegistry } from "./index.js";
import { FunctionCapabilityAdapter, type CapabilityRuntime } from "./capability-runtime.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function productIds(input: Record<string, unknown>): string[] {
  return String(input.product_ids ?? "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function target(input: Record<string, unknown>): { price: number; status: string } {
  return {
    price: Number(input.target_price),
    status: String(input.target_status ?? ""),
  };
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

  for (const definition of [
    { id: "demo.catalog.inspect", description: "Inspect synthetic catalog records in memory" },
    { id: "demo.catalog.plan_change", description: "Build a synthetic catalog change plan" },
    { id: "demo.catalog.simulate_apply", description: "Simulate applying a catalog change without writes" },
    { id: "demo.catalog.verify", description: "Verify the simulated catalog outcome" },
  ]) {
    registry.register({
      ...definition,
      risk: "read_only",
      adapter: definition.id,
      side_effects: false,
      source,
    });
  }

  runtime.register(new FunctionCapabilityAdapter("demo.catalog.inspect", ({ input }) => {
    const ids = productIds(input);
    return {
      output: {
        product_ids: ids,
        product_type: Number(input.product_type),
        current: ids.map((id) => ({ id, price: 0, status: "unknown" })),
        simulation: true,
      },
    };
  }));
  runtime.register(new FunctionCapabilityAdapter("demo.catalog.plan_change", ({ input }) => {
    const inspected = asRecord(asRecord(input.step_outputs).inspect);
    const ids = Array.isArray(inspected.product_ids)
      ? inspected.product_ids.map(String)
      : productIds(input);
    return {
      output: {
        product_ids: ids,
        change_count: ids.length,
        target: target(input),
        simulation: true,
      },
    };
  }));
  runtime.register(new FunctionCapabilityAdapter("demo.catalog.simulate_apply", ({ input }) => {
    const plan = asRecord(asRecord(input.step_outputs).plan);
    const ids = Array.isArray(plan.product_ids)
      ? plan.product_ids.map(String)
      : productIds(input);
    const plannedTarget = asRecord(plan.target);
    return {
      output: {
        product_ids: ids,
        applied_count: ids.length,
        target: {
          price: Number(plannedTarget.price ?? input.target_price),
          status: String(plannedTarget.status ?? input.target_status ?? ""),
        },
        simulation: true,
      },
    };
  }));
  runtime.register(new FunctionCapabilityAdapter("demo.catalog.verify", ({ input }) => {
    const simulated = asRecord(asRecord(input.step_outputs).simulate);
    const ids = Array.isArray(simulated.product_ids)
      ? simulated.product_ids.map(String)
      : productIds(input);
    const simulatedTarget = asRecord(simulated.target);
    const expected = target(input);
    const actual = {
      price: Number(simulatedTarget.price),
      status: String(simulatedTarget.status ?? ""),
    };
    const verified = ids.length > 0
      && actual.price === expected.price
      && actual.status === expected.status
      && simulated.simulation === true;
    return {
      output: {
        verified,
        product_ids: ids,
        target: actual,
        simulation: true,
      },
      verification: {
        validator: "demo.catalog.verify",
        status: verified ? "passed" : "failed",
        summary: verified ? "Synthetic catalog state matches the requested target" : "Synthetic catalog state mismatch",
      },
    };
  }));
}
