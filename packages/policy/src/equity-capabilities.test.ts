import { describe, expect, it } from "vitest";
import { CapabilityRegistry, CapabilityRuntime } from "./index.js";
import { registerEquityCapabilities } from "./equity-capabilities.js";

describe("equity capabilities", () => {
  it("looks up a user balance through the adapter", async () => {
    const registry = new CapabilityRegistry();
    const runtime = new CapabilityRuntime();
    registerEquityCapabilities(registry, runtime);

    const result = await runtime.execute("equity.balance", {
      input: { user_id: "user_42" },
      context: { dry_run: false },
    });

    expect(result).toMatchObject({
      output: {
        user_id: "user_42",
        balance: expect.any(Number),
        currency: "CNY",
      },
    });
  });
});