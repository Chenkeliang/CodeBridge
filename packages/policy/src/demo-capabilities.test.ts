import { describe, expect, it } from "vitest";
import { CapabilityRegistry, CapabilityRuntime } from "./index.js";
import { registerDemoCapabilities } from "./demo-capabilities.js";

describe("demo capabilities", () => {
  it("echoes text and concats with the echo output", async () => {
    const registry = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    registerDemoCapabilities(registry, runtime);
    expect(registry.get("demo.echo")).toMatchObject({
      risk: "read_only", adapter: "demo.echo", side_effects: false, source: { version: "1" },
    });
    const echoed = await runtime.execute("demo.echo", {
      input: { text: "hi" },
      context: { dry_run: true },
    });
    expect(echoed.output).toEqual({ text: "hi" });
    const concated = await runtime.execute("demo.concat", {
      input: { text: "hi", step_outputs: { echo: { text: "hi" } } },
      context: {},
    });
    expect(concated.output).toEqual({ result: "hi" });
    registry.close();
  });

  it("generalizes one catalog change simulation across different inputs without writes", async () => {
    const registry = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    registerDemoCapabilities(registry, runtime);

    const runScenario = async (input: Record<string, unknown>) => {
      const inspect = await runtime.execute("demo.catalog.inspect", {
        input,
        context: { dry_run: true },
      });
      const plan = await runtime.execute("demo.catalog.plan_change", {
        input: { ...input, step_outputs: { inspect: inspect.output } },
        context: { dry_run: true },
      });
      const simulated = await runtime.execute("demo.catalog.simulate_apply", {
        input: { ...input, step_outputs: { inspect: inspect.output, plan: plan.output } },
        context: { dry_run: true },
      });
      const verified = await runtime.execute("demo.catalog.verify", {
        input: {
          ...input,
          step_outputs: {
            inspect: inspect.output,
            plan: plan.output,
            simulate: simulated.output,
          },
        },
        context: { dry_run: true },
      });
      return { inspect, plan, simulated, verified };
    };

    const first = await runScenario({
      product_ids: "P-1001,P-1002",
      product_type: 66,
      target_price: 12,
      target_status: "enabled",
      environment: "simulation",
    });
    const second = await runScenario({
      product_ids: "P-2001",
      product_type: 88,
      target_price: 20,
      target_status: "disabled",
      environment: "simulation",
    });

    expect(first.verified.output).toMatchObject({
      verified: true,
      product_ids: ["P-1001", "P-1002"],
      target: { price: 12, status: "enabled" },
      simulation: true,
    });
    expect(second.verified.output).toMatchObject({
      verified: true,
      product_ids: ["P-2001"],
      target: { price: 20, status: "disabled" },
      simulation: true,
    });
    expect(first.simulated.output).not.toEqual(second.simulated.output);
    for (const id of [
      "demo.catalog.inspect",
      "demo.catalog.plan_change",
      "demo.catalog.simulate_apply",
      "demo.catalog.verify",
    ]) {
      expect(registry.get(id)).toMatchObject({ risk: "read_only", side_effects: false });
    }
    registry.close();
  });
});
