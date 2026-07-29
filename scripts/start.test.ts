import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeCommand(binDir: string, name: string, body: string): void {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

describe("start.sh status", () => {
  it("recognizes launchd-owned services instead of reporting zombies", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-home-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-bin-"));
    tmpDirs.push(home, binDir);
    writeCommand(binDir, "launchctl", '[ "$1" = "print" ]');
    writeCommand(binDir, "lsof", "echo 4321");
    writeCommand(binDir, "pgrep", "echo 5678");

    const output = execFileSync("/bin/bash", ["scripts/start.sh", "status"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });

    expect(output).toContain("Runner: launchd 管理中");
    expect(output).toContain("Bridge: launchd 管理中");
    expect(output).toContain("守护:   launchd KeepAlive");
    expect(output).not.toContain("僵尸进程");
    expect(output).not.toContain("进程在运行但无 pid 文件");
  });
});
