import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTaskCommand } from "./task-cli-client.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe("shared task CLI", () => {
  it.each(["follow", "observe"])("binds %s to the injected Run without accepting a forged run-id flag", async (action) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-follow-cli-")); roots.push(root);
    const file = path.join(root, "request.json"), input = action === "follow" ? { name: "Example", prompt: "query only", timeoutMinutes: 30 } : { status: "completed", summary: "ready" };
    fs.writeFileSync(file, JSON.stringify(input));
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ revision: "fixture-revision" }))).mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true })));
    await runTaskCommand([action, "--file", file, "--run-id", "run_forged"], { api: "http://127.0.0.1:8888", token: "fixture-token", runId: "run_native", fetch });
    expect(fetch.mock.calls[1]![1]).toMatchObject({ headers: { "if-match": "fixture-revision", "x-codebridge-run-id": "run_native" } });
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ runId: "run_native", [action === "follow" ? "request" : "observation"]: input });
  });
  it("shows help and rejects unknown commands and nonlocal endpoints before sending credentials", async () => {
    const fetch = vi.fn(); const context = { api: "http://127.0.0.1:8888", token: "fixture-token", fetch };
    expect(await runTaskCommand(["help"], context)).toMatchObject({ help: expect.stringContaining("仅登记当前") });
    await expect(runTaskCommand(["unknown"], context)).rejects.toThrow("未知任务命令");
    await expect(runTaskCommand(["list"], { ...context, api: "https://unrelated.example" })).rejects.toThrow("本机");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("creates a paused task from a file with revision and a caller-stable intent key", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-task-cli-")); roots.push(root); const file = path.join(root, "task.json");
    fs.writeFileSync(file, JSON.stringify({ name: "Fixture report", prompt: "Read fixture", agentId: "codex", cwd: root, schedule: "每天09:00", timezone: "Asia/Shanghai" }));
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ revision: "fixture-revision", tasks: [] }))).mockResolvedValueOnce(new Response(JSON.stringify({ task: { id: "task_fixture" } })));
    await runTaskCommand(["create", "--file", file, "--key", "fixture-create"], { api: "http://127.0.0.1:8888", token: "fixture-token", fetch });
    const [url, input] = fetch.mock.calls[1]!;
    expect(url).toBe("http://127.0.0.1:8888/v1/management/agent-tasks");
    expect(input).toMatchObject({ method: "POST", redirect: "error", headers: { "if-match": "fixture-revision", "idempotency-key": "fixture-create" } });
    expect(JSON.parse(input.body)).not.toHaveProperty("enabled", true);
  });
  it("registers only the current Run output and forwards original identity instead of a guessed destination", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ revision: "fixture-revision" }))).mockResolvedValueOnce(new Response(JSON.stringify({ file: { id: "taskfile_fixture" } })));
    await runTaskCommand(["output", "/private/tmp/fixture.md"], { api: "http://127.0.0.1:8888", token: "fixture-token", runId: "run-current", fetch });
    expect(fetch.mock.calls[1]![1]).toMatchObject({ body: JSON.stringify({ runId: "run-current", path: "/private/tmp/fixture.md" }), headers: { "x-codebridge-run-id": "run-current" } });
  });
});
