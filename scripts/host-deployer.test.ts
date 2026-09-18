import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("passes the independent supervisor's failure and crash recovery suite", async () => {
  const run = promisify(execFile);
  let stderr = "";
  try {
    ({ stderr } = await run("python3", ["-B", "-u", "scripts/host-deployer.test.py", "-v"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      timeout: 120_000,
    }));
  } catch (error) {
    // 把 Python 侧的输出带进断言信息，否则超时/失败时只剩 "Command failed"。
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`${failed.message}\n--- stdout ---\n${failed.stdout ?? ""}\n--- stderr ---\n${failed.stderr ?? ""}`);
  }
  expect(stderr).toContain("OK");
}, 130_000);
