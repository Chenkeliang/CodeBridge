import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, BackendProfileSchema } from "../packages/core/src/config-schema.js";
// @ts-expect-error MJS upgrade entry point intentionally has no generated declaration file.
import { adapterFingerprint, checkCodexNetwork } from "./check-codex-network.mjs";

const profile = { type: "codex", acpConfig: { network_access: true } };
const options = async () => [{ id: "network_access", type: "boolean", currentValue: false }];
const receiptFor = (candidate = profile) => ({ schemaVersion: 1, backends: { codex: {
  fingerprint: adapterFingerprint(candidate), scenarios: Object.fromEntries(
    ["new", "pooled-resume", "cold-resume"].map((phase) => [phase, {
      network: "PASS", workspace_write: "PASS", outside_write_blocked: "PASS", permissionRequests: 0,
    }]),
  ),
} } });
const config = (candidate = profile) => ({ ...defaultConfig(), backends: { codex: candidate } });

describe("Codex ACP network upgrade checks", () => {
  it("preserves backend ACP defaults through schema validation", () => {
    expect(BackendProfileSchema.parse(profile).acpConfig).toEqual({ network_access: true });
  });
  it("does not probe backends without an explicit network setting", async () => {
    await expect(checkCodexNetwork({ ...defaultConfig(), backends: { codex: { type: "codex" } } }, undefined,
      () => { throw new Error("must not start adapter"); })).resolves.toEqual([]);
  });
  it("rejects an adapter without the negotiated boolean option", async () => {
    await expect(checkCodexNetwork(config(), receiptFor(), async () => []))
      .rejects.toThrow("does not advertise");
  });
  it("requires an acceptance report", async () => {
    await expect(checkCodexNetwork(config(), undefined, options)).rejects.toThrow("missing or stale");
  });
  it("invalidates acceptance when the pinned adapter version changes", async () => {
    const next = { ...profile, acpCommand: "npx", acpArgs: ["-y", "@agentclientprotocol/codex-acp@99.0.0"] };
    await expect(checkCodexNetwork(config(next), receiptFor(), options)).rejects.toThrow("missing or stale");
  });
  it("invalidates acceptance when a configured adapter script changes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-network-gate-"));
    try {
      const script = path.join(root, "adapter.mjs"); fs.writeFileSync(script, "before");
      const candidate = { ...profile, acpCommand: process.execPath, acpArgs: [script] };
      const receipt = receiptFor(candidate); fs.writeFileSync(script, "after");
      await expect(checkCodexNetwork(config(candidate), receipt, options)).rejects.toThrow("missing or stale");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("requires cold-start resume, filesystem denial and zero escalation", async () => {
    for (const failure of ["missing phase", "filesystem", "permissions"]) {
      const receipt = receiptFor();
      if (failure === "missing phase") delete receipt.backends.codex.scenarios["cold-resume"];
      if (failure === "filesystem") receipt.backends.codex.scenarios.new.outside_write_blocked = "FAIL";
      if (failure === "permissions") receipt.backends.codex.scenarios.new.permissionRequests = 1;
      await expect(checkCodexNetwork(config(), receipt, options)).rejects.toThrow("incomplete");
    }
  });
  it("accepts a complete report bound to the current adapter and configuration", async () => {
    await expect(checkCodexNetwork(config(), receiptFor(), options)).resolves.toEqual(["codex"]);
  });
});
