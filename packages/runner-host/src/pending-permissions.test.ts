import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@codebridge/core";
import { createRunnerApp, RunnerHost } from "./server.js";

describe("pending permission source of truth", () => {
  it("requires authentication, exposes only request metadata and rejects a stale request without granting the next one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-task-permission-"));
    const host = new RunnerHost({ token: "fixture-token", config: defaultConfig(), dataDir: root });
    const first = vi.fn(), second = vi.fn();
    const queue = [{ requestId: "first", title: "Read fixture", resolve: first }, { requestId: "second", title: "Write fixture", resolve: second }];
    (host as unknown as { pendingPermissions: Map<string, typeof queue> }).pendingPermissions.set("run-fixture", queue);
    const app = createRunnerApp(host, "fixture-token"), headers = { authorization: "Bearer fixture-token", "content-type": "application/json" };
    try {
      expect((await app.request("/permissions")).status).toBe(401);
      expect(await (await app.request("/permissions", { headers })).json()).toEqual({ permissions: [
        { runId: "run-fixture", requestId: "first", title: "Read fixture" }, { runId: "run-fixture", requestId: "second", title: "Write fixture" },
      ] });
      expect(JSON.stringify(host.listPendingPermissions())).not.toContain("resolve");
      const stale = await app.request("/runs/run-fixture/permission", { method: "POST", headers, body: JSON.stringify({ approve: true, request_id: "not-current" }) });
      expect(await stale.json()).toEqual({ resolved: false }); expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
      const response = await app.request("/runs/run-fixture/permission", { method: "POST", headers, body: JSON.stringify({ approve: false, request_id: "first" }) });
      expect(await response.json()).toEqual({ resolved: true }); expect(first).toHaveBeenCalledWith(false); expect(second).not.toHaveBeenCalled();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
