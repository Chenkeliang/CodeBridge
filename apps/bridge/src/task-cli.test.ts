import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { defaultConfig } from "@codebridge/core";
import { stringify } from "yaml";
const exec = promisify(execFile), roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
it("shows actual installed task help offline without creating runtime data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cli-help-")); roots.push(root);
  const dataDir = path.join(root, "not-created");
  const response = await exec(process.execPath, [cli, "tasks", "help", "--data-dir", dataDir], { env: { PATH: process.env.PATH, HOME: root } });
  expect(response.stdout).toContain("tasks create"); expect(fs.existsSync(dataDir)).toBe(false);
});
it("routes actual CLI arguments and operation keys to the local management API", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cli-tasks-")); roots.push(root);
  const config = defaultConfig(); config.runner.token = "env:UNIT_CLI_TOKEN"; fs.writeFileSync(path.join(root, "config.yaml"), stringify(config));
  const requests: Array<{ path: string; method: string; body: unknown; version?: string; key?: string }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []; request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push({ path: request.url!, method: request.method!, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, version: request.headers["if-match"] as string | undefined, key: request.headers["idempotency-key"] as string | undefined });
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(request.method === "GET"
        ? request.url === "/v1/management/agent-tasks" ? { revision: "fixture-revision", tasks: [] } : { task: { id: "task_fixture", version: 7 } }
        : { attempt: { id: "taskrun_fixture" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
  try {
    const response = await exec(process.execPath, [cli, "tasks", "run", "task_fixture", "--key", "fixture-cli-intent", "--data-dir", root], { env: { PATH: process.env.PATH, HOME: root, UNIT_CLI_TOKEN: "fixture-cli-token", FCB_API: `http://127.0.0.1:${address.port}` } });
    expect(response.stdout).toContain("taskrun_fixture"); expect(requests).toHaveLength(3);
    expect(requests[2]).toMatchObject({ path: "/v1/management/agent-tasks/task_fixture/run", method: "POST", body: { version: 7, acknowledgeUnknown: false }, version: "fixture-revision", key: "fixture-cli-intent" });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
