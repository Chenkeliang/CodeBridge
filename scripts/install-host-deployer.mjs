#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "../packages/core/dist/index.js";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${name}`);
  return args[index + 1];
};
const sourceRepo = fs.realpathSync(option("--source", path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")));
const dataDir = fs.realpathSync(option("--data-dir", path.join(os.homedir(), ".codebridge")));
const rootDir = path.join(dataDir, "deployer");
const configPath = path.join(rootDir, "config.json");
const previous = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
const ownerOpenId = option("--owner", previous.ownerOpenId);
if (!/^ou_[a-zA-Z0-9]+$/.test(ownerOpenId ?? "")) throw new Error("Supply the verified Feishu owner open_id using --owner");
if (process.platform !== "darwin") throw new Error("The deployer must be installed on the macOS host");
const nodePath = fs.realpathSync(option("--node", process.execPath));
const pythonPath = option("--python", execFileSync("/usr/bin/which", ["python3"], {encoding: "utf8"}).trim());
const gitPath = option("--git", execFileSync("/usr/bin/which", ["git"], {encoding: "utf8"}).trim());
execFileSync(gitPath, ["--version"], {stdio: "pipe"});
const pnpmPath = option("--pnpm", execFileSync("/usr/bin/which", ["pnpm"], {encoding: "utf8"}).trim());
for (const executable of [nodePath, pythonPath, pnpmPath, gitPath]) fs.accessSync(executable, fs.constants.X_OK);
execFileSync(pythonPath, ["-c", "import sys; assert sys.version_info >= (3, 9)"]);
const bridgePlist = path.join(os.homedir(), "Library/LaunchAgents/com.codebridge.bridge.plist");
const runnerPlist = path.join(os.homedir(), "Library/LaunchAgents/com.codebridge.runner.plist");
for (const file of [bridgePlist, runnerPlist]) fs.accessSync(file, fs.constants.R_OK);
const config = new ConfigStore({dataDir}).get();
const installedScript = path.join(rootDir, "host-deployer.py");
const controllerSource = path.join(sourceRepo, "scripts/host-deployer.py");
fs.accessSync(controllerSource, fs.constants.R_OK);
const settings = {
  ...previous, rootDir, dataDir, sourceRepo, ownerOpenId, nodePath, pythonPath, pnpmPath, gitPath,
  token: previous.token || randomBytes(32).toString("hex"),
  bridgePlist, runnerPlist, bridgeLabel: "com.codebridge.bridge", runnerLabel: "com.codebridge.runner",
  apiPort: config.bridge?.apiPort ?? 19790,
  runnerToken: config.runner.token, runnerUrl: config.runner.url,
  feishu: {appId: config.feishu.appId, appSecret: config.feishu.appSecret, domain: config.feishu.domain},
  readinessTimeoutSec: 90, drainTimeoutSec: 300, stabilitySec: 10, ackGraceSec: 3,
};
if (!args.includes("--install")) {
  console.log(JSON.stringify({mode: "preview", sourceRepo, dataDir, rootDir, ownerOpenId, nodePath, pythonPath, pnpmPath, gitPath,
    message: "Use --install to install the independent host service; no files changed."}, null, 2));
  process.exit(0);
}
const label = "com.codebridge.deployer";
const domain = `gui/${process.getuid()}`;
const exists = () => spawnSync("/bin/launchctl", ["print", `${domain}/${label}`], {stdio: "ignore"}).status === 0;
if (exists()) {
  // Updating the rescue controller is deliberately separate from ordinary releases.
  const response = await fetch("http://127.0.0.1:19791/health", {
    headers: {authorization: `Bearer ${previous.token}`}, signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error("Existing deployer is unhealthy; inspect it before replacing the rescue controller");
  const health = await response.json();
  if (health.active) throw new Error("A deployment is active; do not replace its controller");
  execFileSync("/bin/launchctl", ["bootout", `${domain}/${label}`]);
  const deadline = Date.now() + 15000;
  while (exists()) {
    if (Date.now() >= deadline) throw new Error("Deployer bootout did not complete");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
fs.mkdirSync(rootDir, {recursive: true, mode: 0o700});
fs.chmodSync(rootDir, 0o700);
if (fs.existsSync(installedScript)) fs.copyFileSync(installedScript, `${installedScript}.previous`);
fs.copyFileSync(controllerSource, installedScript);
fs.chmodSync(installedScript, 0o700);
fs.writeFileSync(`${configPath}.tmp`, JSON.stringify(settings, null, 2), {mode: 0o600});
fs.renameSync(`${configPath}.tmp`, configPath);
fs.chmodSync(configPath, 0o600);
const escape = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const hostPath = [...new Set([path.dirname(nodePath), path.dirname(pnpmPath), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escape(pythonPath)}</string><string>${escape(installedScript)}</string><string>--config</string><string>${escape(configPath)}</string></array>
<key>WorkingDirectory</key><string>${escape(rootDir)}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${escape(os.homedir())}</string><key>PATH</key><string>${escape(hostPath)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${escape(path.join(rootDir, "service.log"))}</string>
<key>StandardErrorPath</key><string>${escape(path.join(rootDir, "service.err.log"))}</string>
</dict></plist>`;
const plistPath = path.join(os.homedir(), `Library/LaunchAgents/${label}.plist`);
fs.writeFileSync(plistPath, plist, {mode: 0o600});
execFileSync("/usr/bin/plutil", ["-lint", plistPath], {stdio: "pipe"});
execFileSync("/bin/launchctl", ["bootstrap", domain, plistPath]);
let ready = false;
for (let i = 0; i < 30; i++) {
  try {
    const r = await fetch("http://127.0.0.1:19791/health", {
      headers: {authorization: `Bearer ${settings.token}`}, signal: AbortSignal.timeout(1000),
    });
    if (r.ok && (await r.json()).ok) { ready = true; break; }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!ready) throw new Error(`Deployer did not become healthy; inspect ${rootDir}/service.err.log`);
console.log(JSON.stringify({installed: true, healthy: true, sourceRepo, rootDir, label, message: "Host deployer ready; Bridge/Runner not restarted."}));
