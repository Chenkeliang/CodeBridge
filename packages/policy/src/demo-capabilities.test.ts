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
});
