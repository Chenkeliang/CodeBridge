import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

// Execute the helper shipped in the proposed upstream diff, rather than a second implementation.
const patch = fs.readFileSync(new URL("../docs/upstream/codex-acp-network-access.patch", import.meta.url), "utf8");
const section = patch.split("diff --git a/src/NetworkAccessConfig.ts b/src/NetworkAccessConfig.ts\n")[1]?.split("diff --git ")[0];
if (!section) throw new Error("upstream network helper missing");
const source = section.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const module = { exports: {} as Record<string, (...args: unknown[]) => any> };
const require = createRequire(new URL("../packages/backends/package.json", import.meta.url));
new Function("require", "module", "exports", output.outputText)(require, module, module.exports);
const api = module.exports;

describe("prepared codex-acp upstream network option", () => {
  it("keeps network isolation as the default and rejects string truthiness", () => {
    expect(api.initialNetworkAccess({})).toBe(false);
    expect(api.initialNetworkAccess({ sandbox_workspace_write: { network_access: "true" } })).toBe(false);
    expect(api.initialNetworkAccess({ sandbox_workspace_write: { network_access: true } })).toBe(true);
  });
  it("negotiates boolean support and hides the option in full-access mode", () => {
    const mode = { sandboxPolicy: { type: "workspaceWrite" } };
    expect(api.createNetworkAccessConfigOption(false, mode, false)).toBeUndefined();
    expect(api.createNetworkAccessConfigOption(false, mode, true)).toMatchObject({ id: "network_access", type: "boolean", currentValue: false });
    expect(api.createNetworkAccessConfigOption(false, { sandboxPolicy: { type: "dangerFullAccess" } }, true)).toBeUndefined();
  });
  it("accepts explicit false and rejects requests without the negotiated type", () => {
    expect(api.networkAccessValue({ type: "boolean", value: false }, true)).toBe(false);
    expect(() => api.networkAccessValue({ value: "true" }, true)).toThrow();
    expect(() => api.networkAccessValue({ type: "boolean", value: true }, false)).toThrow();
  });
  it("changes only networkAccess and does not mutate the shared mode policy", () => {
    const policy = { type: "workspaceWrite", writableRoots: ["/work"], networkAccess: false, excludeSlashTmp: true };
    expect(api.sandboxWithNetworkAccess(policy, true)).toEqual({ ...policy, networkAccess: true });
    expect(api.sandboxWithNetworkAccess(policy, false)).toEqual(policy);
    expect(policy.networkAccess).toBe(false);
  });
  it("preserves read-only filesystem policy and full-access mode", () => {
    const readonly = { type: "readOnly", networkAccess: false };
    const full = { type: "dangerFullAccess" };
    expect(api.sandboxWithNetworkAccess(readonly, true)).toEqual({ type: "readOnly", networkAccess: true });
    expect(api.sandboxWithNetworkAccess(full, false)).toBe(full);
  });
});
