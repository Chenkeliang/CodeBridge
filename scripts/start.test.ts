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

function writeStatefulLaunchctl(binDir: string, loadedLabels: string[]): void {
  const stateDir = path.join(binDir, "launchd-state");
  fs.mkdirSync(stateDir, { recursive: true });
  for (const label of loadedLabels) {
    fs.writeFileSync(path.join(stateDir, label), "loaded");
  }
  writeCommand(
    binDir,
    "launchctl",
    [
      `state=${JSON.stringify(stateDir)}`,
      '[ -z "${ORDER_LOG:-}" ] || echo "launchctl $1 $2" >> "$ORDER_LOG"',
      'case "$1" in',
      '  print) label="${2##*/}"; [ -f "$state/$label" ] ;;',
      '  bootout) value="${3:-$2}"; label="${value##*/}"; label="${label%.plist}"; rm -f "$state/$label" ;;',
      '  unload) label="${2##*/}"; label="${label%.plist}"; rm -f "$state/$label" ;;',
      '  bootstrap) label="${3##*/}"; label="${label%.plist}"; touch "$state/$label" ;;',
      '  load) label="${2##*/}"; label="${label%.plist}"; touch "$state/$label" ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join("\n"),
  );
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

  it("recognizes legacy launchd labels during the rename migration", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-legacy-home-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-legacy-bin-"));
    tmpDirs.push(home, binDir);
    writeCommand(
      binDir,
      "launchctl",
      'case "$2" in *com.feishu-code-bridge.runner|*com.feishu-code-bridge.bridge) exit 0;; *) exit 1;; esac',
    );
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

    expect(output).toContain("旧版 launchd 管理中");
    expect(output).toContain("请执行 restart 或 install-launchd");
  });

  it("restart migrates the legacy data directory and launchd jobs", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-migrate-home-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-migrate-bin-"));
    tmpDirs.push(home, binDir);
    const legacyDataDir = path.join(home, ".feishu-code-bridge");
    fs.mkdirSync(path.join(home, ".codebridge"), { recursive: true });
    const agentsDir = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(legacyDataDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDataDir, "config.yaml"),
      [
        "feishu:",
        "  appId: cli_test",
        "  appSecret: secret_test",
        "runner:",
        "  token: runner_test",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(agentsDir, "com.feishu-code-bridge.runner.plist"),
      "legacy runner",
    );
    fs.writeFileSync(
      path.join(agentsDir, "com.feishu-code-bridge.bridge.plist"),
      "legacy bridge",
    );
    writeStatefulLaunchctl(binDir, [
      "com.feishu-code-bridge.runner",
      "com.feishu-code-bridge.bridge",
    ]);
    writeCommand(binDir, "node", `exec ${JSON.stringify(process.execPath)} "$@"`);
    writeCommand(binDir, "pnpm", "exit 0");

    const output = execFileSync("/bin/bash", ["scripts/start.sh", "restart"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });

    const dataDir = path.join(home, ".codebridge");
    expect(output).toContain("已迁移数据目录");
    expect(output).toContain("launchd 服务已迁移并重启");
    expect(fs.existsSync(legacyDataDir)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "config.yaml"))).toBe(true);
    expect(
      fs.readFileSync(path.join(agentsDir, "com.codebridge.runner.plist"), "utf8"),
    ).toContain("com.codebridge.runner");
    expect(
      fs.readFileSync(path.join(agentsDir, "com.codebridge.bridge.plist"), "utf8"),
    ).toContain("com.codebridge.bridge");
  });

  it("stops legacy launchd jobs before moving their data directory", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-order-home-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-order-bin-"));
    tmpDirs.push(home, binDir);
    const legacyDataDir = path.join(home, ".feishu-code-bridge");
    const agentsDir = path.join(home, "Library", "LaunchAgents");
    const orderLog = path.join(home, "order.log");
    fs.mkdirSync(legacyDataDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDataDir, "config.yaml"),
      [
        "feishu:",
        "  appId: cli_test",
        "  appSecret: secret_test",
        "runner:",
        "  token: runner_test",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(agentsDir, "com.feishu-code-bridge.runner.plist"),
      "legacy runner",
    );
    writeStatefulLaunchctl(binDir, ["com.feishu-code-bridge.runner"]);
    writeCommand(binDir, "mv", 'echo "mv" >> "$ORDER_LOG"; exec /bin/mv "$@"');
    writeCommand(binDir, "lsof", "exit 1");
    writeCommand(binDir, "pgrep", "exit 1");
    writeCommand(binDir, "pkill", "exit 0");
    writeCommand(binDir, "node", `exec ${JSON.stringify(process.execPath)} "$@"`);
    writeCommand(binDir, "pnpm", "exit 0");

    execFileSync("/bin/bash", ["scripts/start.sh", "restart"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        ORDER_LOG: orderLog,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });

    const operations = fs.readFileSync(orderLog, "utf8").trim().split("\n");
    const bootoutIndex = operations.findIndex((line) => line.includes("bootout"));
    const moveIndex = operations.indexOf("mv");
    expect(bootoutIndex).toBeGreaterThanOrEqual(0);
    expect(moveIndex).toBeGreaterThan(bootoutIndex);
  });

  it("aborts data migration when a legacy launchd job cannot be stopped", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-bootout-home-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-bootout-bin-"));
    tmpDirs.push(home, binDir);
    const legacyDataDir = path.join(home, ".feishu-code-bridge");
    const agentsDir = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(legacyDataDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDataDir, "config.yaml"), "config");
    fs.writeFileSync(
      path.join(agentsDir, "com.feishu-code-bridge.runner.plist"),
      "legacy runner",
    );
    writeCommand(
      binDir,
      "launchctl",
      'if [ "$1" = "print" ]; then case "$2" in *com.feishu-code-bridge.runner) exit 0;; *) exit 1;; esac; fi; if [ "$1" = "bootout" ] || [ "$1" = "unload" ]; then exit 1; fi; exit 0',
    );
    writeCommand(binDir, "lsof", "exit 1");
    writeCommand(binDir, "pgrep", "exit 1");
    writeCommand(binDir, "pkill", "exit 0");
    writeCommand(binDir, "node", "exit 0");
    writeCommand(binDir, "pnpm", "exit 0");

    expect(() =>
      execFileSync("/bin/bash", ["scripts/start.sh", "restart"], {
        cwd: path.resolve(import.meta.dirname, ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        },
      }),
    ).toThrow();
    expect(fs.existsSync(legacyDataDir)).toBe(true);
    expect(fs.existsSync(path.join(home, ".codebridge"))).toBe(false);
  });

  it("preserves new data while moving non-conflicting legacy entries", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-merge-home-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-merge-bin-"));
    tmpDirs.push(home, binDir);
    const legacyDataDir = path.join(home, ".feishu-code-bridge");
    const dataDir = path.join(home, ".codebridge");
    const agentsDir = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(legacyDataDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDataDir, "config.yaml"), "legacy config");
    fs.writeFileSync(path.join(legacyDataDir, "session.json"), "legacy session");
    fs.writeFileSync(
      path.join(dataDir, "config.yaml"),
      [
        "feishu:",
        "  appId: cli_test",
        "  appSecret: secret_test",
        "runner:",
        "  token: runner_test",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(agentsDir, "com.feishu-code-bridge.runner.plist"),
      "legacy runner",
    );
    writeStatefulLaunchctl(binDir, ["com.feishu-code-bridge.runner"]);
    writeCommand(binDir, "node", `exec ${JSON.stringify(process.execPath)} "$@"`);
    writeCommand(binDir, "pnpm", "exit 0");

    const output = execFileSync("/bin/bash", ["scripts/start.sh", "restart"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });

    expect(output).toContain("保留旧目录中的冲突项: config.yaml");
    expect(fs.readFileSync(path.join(dataDir, "config.yaml"), "utf8")).toContain(
      "cli_test",
    );
    expect(fs.readFileSync(path.join(dataDir, "session.json"), "utf8")).toBe(
      "legacy session",
    );
    expect(fs.readFileSync(path.join(legacyDataDir, "config.yaml"), "utf8")).toBe(
      "legacy config",
    );
  });

  it("restart migrates legacy launchd plists even when they are unloaded", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-plist-home-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-plist-bin-"));
    tmpDirs.push(home, binDir);
    const legacyDataDir = path.join(home, ".feishu-code-bridge");
    const agentsDir = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(legacyDataDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDataDir, "config.yaml"),
      [
        "feishu:",
        "  appId: cli_test",
        "  appSecret: secret_test",
        "runner:",
        "  token: runner_test",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(agentsDir, "com.feishu-code-bridge.runner.plist"),
      "legacy runner",
    );
    fs.writeFileSync(
      path.join(agentsDir, "com.feishu-code-bridge.bridge.plist"),
      "legacy bridge",
    );
    writeCommand(
      binDir,
      "launchctl",
      'if [ "$1" = "print" ]; then exit 1; fi; exit 0',
    );
    writeCommand(binDir, "lsof", "exit 1");
    writeCommand(binDir, "pgrep", "exit 1");
    writeCommand(binDir, "pkill", "exit 0");
    writeCommand(binDir, "node", `exec ${JSON.stringify(process.execPath)} "$@"`);
    writeCommand(binDir, "pnpm", "exit 0");

    const output = execFileSync("/bin/bash", ["scripts/start.sh", "restart"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });

    expect(output).toContain("launchd 服务已迁移并重启");
    expect(
      fs.existsSync(path.join(agentsDir, "com.feishu-code-bridge.runner.plist")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(agentsDir, "com.feishu-code-bridge.bridge.plist")),
    ).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, "com.codebridge.runner.plist"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(agentsDir, "com.codebridge.bridge.plist"))).toBe(
      true,
    );
  });

  it("restart honors unloaded current launchd plists", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-current-home-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-current-bin-"));
    tmpDirs.push(home, binDir);
    const dataDir = path.join(home, ".codebridge");
    const agentsDir = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "config.yaml"),
      [
        "feishu:",
        "  appId: cli_test",
        "  appSecret: secret_test",
        "runner:",
        "  token: runner_test",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(agentsDir, "com.codebridge.runner.plist"),
      "unloaded runner",
    );
    writeCommand(
      binDir,
      "launchctl",
      'if [ "$1" = "print" ]; then exit 1; fi; exit 0',
    );
    writeCommand(binDir, "lsof", "exit 1");
    writeCommand(binDir, "pgrep", "exit 1");
    writeCommand(binDir, "pkill", "exit 0");
    writeCommand(binDir, "curl", "exit 0");
    writeCommand(
      binDir,
      "node",
      `if [ "$1" = "-" ]; then exec ${JSON.stringify(process.execPath)} "$@"; fi; exit 0`,
    );
    writeCommand(binDir, "pnpm", "exit 0");

    const output = execFileSync("/bin/bash", ["scripts/start.sh", "restart"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });

    expect(output).toContain("launchd 服务已迁移并重启");
    expect(
      fs.readFileSync(path.join(agentsDir, "com.codebridge.runner.plist"), "utf8"),
    ).toContain("com.codebridge.runner");
  });

  it("keeps an explicit DATA_DIR while migrating legacy launchd labels", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-explicit-home-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-explicit-bin-"));
    tmpDirs.push(home, binDir);
    const legacyDataDir = path.join(home, ".feishu-code-bridge");
    const explicitDataDir = path.join(home, "custom-data");
    const agentsDir = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(legacyDataDir, { recursive: true });
    fs.mkdirSync(explicitDataDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDataDir, "legacy-session.json"), "keep");
    fs.writeFileSync(
      path.join(explicitDataDir, "config.yaml"),
      [
        "feishu:",
        "  appId: cli_test",
        "  appSecret: secret_test",
        "runner:",
        "  token: runner_test",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(agentsDir, "com.feishu-code-bridge.runner.plist"),
      "legacy runner",
    );
    fs.writeFileSync(
      path.join(agentsDir, "com.feishu-code-bridge.bridge.plist"),
      "legacy bridge",
    );
    writeStatefulLaunchctl(binDir, [
      "com.feishu-code-bridge.runner",
      "com.feishu-code-bridge.bridge",
    ]);
    writeCommand(binDir, "lsof", "exit 1");
    writeCommand(binDir, "pgrep", "exit 1");
    writeCommand(binDir, "pkill", "exit 0");
    writeCommand(binDir, "node", `exec ${JSON.stringify(process.execPath)} "$@"`);
    writeCommand(binDir, "pnpm", "exit 0");

    const output = execFileSync("/bin/bash", ["scripts/start.sh", "restart"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        DATA_DIR: explicitDataDir,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });

    expect(output).toContain("launchd 服务已迁移并重启");
    expect(fs.existsSync(legacyDataDir)).toBe(true);
    expect(fs.existsSync(path.join(legacyDataDir, "legacy-session.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(agentsDir, "com.feishu-code-bridge.runner.plist"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(agentsDir, "com.feishu-code-bridge.bridge.plist"))).toBe(
      false,
    );
    expect(fs.readFileSync(path.join(explicitDataDir, "config.yaml"), "utf8")).toContain(
      "runner_test",
    );
  });

  it("component install migrates other legacy launchd jobs sharing the data dir", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-component-home-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-component-bin-"));
    tmpDirs.push(home, binDir);
    const legacyDataDir = path.join(home, ".feishu-code-bridge");
    const agentsDir = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(legacyDataDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDataDir, "config.yaml"), "config");
    fs.writeFileSync(
      path.join(agentsDir, "com.feishu-code-bridge.runner.plist"),
      "legacy runner",
    );
    fs.writeFileSync(
      path.join(agentsDir, "com.feishu-code-bridge.bridge.plist"),
      "legacy bridge",
    );
    writeStatefulLaunchctl(binDir, [
      "com.feishu-code-bridge.runner",
      "com.feishu-code-bridge.bridge",
    ]);
    writeCommand(binDir, "lsof", "exit 1");
    writeCommand(binDir, "pgrep", "exit 1");
    writeCommand(binDir, "pkill", "exit 0");
    writeCommand(binDir, "node", "exit 0");

    execFileSync("/bin/bash", ["scripts/start.sh", "install-launchd", "runner"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });

    expect(
      fs.existsSync(path.join(agentsDir, "com.feishu-code-bridge.bridge.plist")),
    ).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, "com.codebridge.runner.plist"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(agentsDir, "com.codebridge.bridge.plist"))).toBe(
      true,
    );
  });

  it("install-macos-runner removes the legacy Runner launchd job", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-helper-home-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-helper-bin-"));
    tmpDirs.push(home, binDir);
    const agentsDir = path.join(home, "Library", "LaunchAgents");
    const legacyDataDir = path.join(home, ".feishu-code-bridge");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(legacyDataDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDataDir, "config.yaml"), "config");
    fs.writeFileSync(
      path.join(agentsDir, "com.feishu-code-bridge.runner.plist"),
      "legacy runner",
    );
    fs.writeFileSync(
      path.join(agentsDir, "com.feishu-code-bridge.bridge.plist"),
      "legacy bridge",
    );
    writeStatefulLaunchctl(binDir, [
      "com.feishu-code-bridge.runner",
      "com.feishu-code-bridge.bridge",
    ]);
    writeCommand(binDir, "lsof", "exit 1");
    writeCommand(binDir, "pgrep", "exit 1");
    writeCommand(binDir, "pkill", "exit 0");
    writeCommand(binDir, "node", "exit 0");

    execFileSync("/bin/bash", ["scripts/start.sh", "install-macos-runner"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });

    expect(
      fs.existsSync(path.join(agentsDir, "com.feishu-code-bridge.runner.plist")),
    ).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, "com.codebridge.runner.plist"))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(agentsDir, "com.feishu-code-bridge.bridge.plist")),
    ).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, "com.codebridge.bridge.plist"))).toBe(
      true,
    );
  });

  it("install-macos-runner stops manual Runner state but preserves Bridge", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-helper-manual-home-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fcb-start-helper-manual-bin-"));
    tmpDirs.push(home, binDir);
    const runDir = path.join(home, ".codebridge", "run");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "runner.pid"), "999999");
    fs.writeFileSync(path.join(runDir, "watchdog.pid"), "999999");
    fs.writeFileSync(path.join(runDir, "bridge.pid"), "999999");
    writeCommand(binDir, "launchctl", 'if [ "$1" = "print" ]; then exit 1; fi; exit 0');
    writeCommand(binDir, "lsof", "exit 1");
    writeCommand(binDir, "pgrep", "exit 1");
    writeCommand(binDir, "pkill", "exit 0");
    writeCommand(binDir, "node", "exit 0");

    execFileSync("/bin/bash", ["scripts/start.sh", "install-macos-runner"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });

    expect(fs.existsSync(path.join(runDir, "runner.pid"))).toBe(false);
    expect(fs.existsSync(path.join(runDir, "watchdog.pid"))).toBe(false);
    expect(fs.existsSync(path.join(runDir, "bridge.pid"))).toBe(true);
  });
});
