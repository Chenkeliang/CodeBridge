import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CapabilityRuntime,
  CliCapabilityAdapter,
  FunctionCapabilityAdapter,
  McpCapabilityAdapter,
  SkillCapabilityAdapter,
  discoverSkillDocuments,
} from "./capability-runtime.js";

describe("capability runtime", () => {
  it("dispatches an explicitly registered function adapter", async () => {
    const runtime = new CapabilityRuntime([
      new FunctionCapabilityAdapter("test.function", ({ input }) => ({ output: input.value })),
    ]);
    await expect(runtime.execute("test.function", { input: { value: 42 }, context: {} })).resolves.toMatchObject({ output: 42 });
  });

  it("passes a capability call to an MCP transport", async () => {
    const calls: unknown[] = [];
    const runtime = new CapabilityRuntime([
      new McpCapabilityAdapter("mcp.lookup", "lookup", async (tool, input) => {
        calls.push([tool, input]);
        return { found: true };
      }),
    ]);
    await expect(runtime.execute("mcp.lookup", { input: { id: "x" }, context: {} })).resolves.toMatchObject({ output: { found: true } });
    expect(calls).toEqual([["lookup", { id: "x" }]]);
  });

  it("discovers standard SKILL.md and exposes it as agent context", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-skills-"));
    const skillDir = path.join(root, "investigate");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Investigate\nRead only.");
    const documents = discoverSkillDocuments([root]);
    expect(documents).toHaveLength(1);
    const runtime = new CapabilityRuntime([new SkillCapabilityAdapter("skill.investigate", documents[0]!) ]);
    await expect(runtime.execute("skill.investigate", { input: {}, context: {} })).resolves.toMatchObject({
      forwardToAgent: true,
      output: { instructions: "# Investigate\nRead only." },
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("executes a CLI with JSON on stdin without a shell", async () => {
    const runtime = new CapabilityRuntime([
      new CliCapabilityAdapter("cli.node", {
        command: process.execPath,
        args: ["-e", "process.stdin.on('data', d => process.stdout.write(d))"],
      }),
    ]);
    await expect(runtime.execute("cli.node", { input: { ok: true }, context: {} })).resolves.toMatchObject({ output: { ok: true } });
  });

  it("passes dry_run to adapters and surfaces dry_run_report", async () => {
    let sawDryRun: boolean | undefined;
    const adapter = new FunctionCapabilityAdapter("a", async (inv) => {
      sawDryRun = inv.context.dry_run;
      if (inv.context.dry_run) {
        return {
          dry_run_report: { would_do: "write X", checks: [{ name: "idempotency", passed: true }] },
        };
      }
      return { output: { done: true } };
    });
    const runtime = new CapabilityRuntime([adapter]);
    const result = await runtime.execute("a", { input: {}, context: { dry_run: true } });
    expect(sawDryRun).toBe(true);
    expect(result.dry_run_report?.would_do).toBe("write X");
  });
});
