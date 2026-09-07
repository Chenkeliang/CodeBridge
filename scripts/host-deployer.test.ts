import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("passes the independent supervisor's failure and crash recovery suite", async () => {
  const run = promisify(execFile);
  const result = await run("python3", ["-B", "scripts/host-deployer.test.py"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    timeout: 30_000,
  });
  expect(result.stderr).toContain("OK");
}, 35_000);
