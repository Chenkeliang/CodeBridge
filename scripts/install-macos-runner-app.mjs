#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const RUNNER_BUNDLE_ID = "com.codebridge.runner";
export const RUNNER_APP_NAME = "CodeBridge Runner.app";

export function runnerAppInfo(home = os.homedir()) {
  const appPath = path.join(home, "Applications", RUNNER_APP_NAME);
  return {
    bundleId: RUNNER_BUNDLE_ID,
    appPath,
    executablePath: path.join(appPath, "Contents", "MacOS", "CodeBridgeRunner"),
  };
}

export function runnerInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>CodeBridgeRunner</string>
  <key>CFBundleIdentifier</key><string>${RUNNER_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>CodeBridge Runner</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
  <key>NSDesktopFolderUsageDescription</key><string>Allow the Runner to access project files selected through the bridge.</string>
  <key>NSDocumentsFolderUsageDescription</key><string>Allow the Runner to access project files selected through the bridge.</string>
  <key>NSDownloadsFolderUsageDescription</key><string>Allow the Runner to access project files selected through the bridge.</string>
  <key>NSNetworkVolumesUsageDescription</key><string>Allow the Runner to access selected projects on network volumes.</string>
  <key>NSRemovableVolumesUsageDescription</key><string>Allow the Runner to access selected projects on removable volumes.</string>
</dict></plist>
`;
}

export function installRunnerApp({
  home = os.homedir(),
  nodePath = process.execPath,
  identity = process.env.CODEBRIDGE_CODESIGN_IDENTITY ?? process.env.FCB_CODESIGN_IDENTITY ?? "-",
} = {}) {
  if (process.platform !== "darwin") {
    throw new Error("固定 Bundle ID 的 Runner helper 仅支持 macOS");
  }
  const info = runnerAppInfo(home);
  const contentsPath = path.join(info.appPath, "Contents");
  fs.mkdirSync(path.join(contentsPath, "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(contentsPath, "Resources"), { recursive: true });
  fs.copyFileSync(nodePath, info.executablePath);
  fs.chmodSync(info.executablePath, 0o755);
  fs.writeFileSync(
    path.join(contentsPath, "Info.plist"),
    runnerInfoPlist(),
    "utf8",
  );
  const result = spawnSync(
    "codesign",
    ["--force", "--deep", "--sign", identity, "--identifier", info.bundleId, info.appPath],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "codesign 失败");
  }
  return info;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const identity = process.argv[2] ?? process.env.CODEBRIDGE_CODESIGN_IDENTITY ?? process.env.FCB_CODESIGN_IDENTITY ?? "-";
    const info = installRunnerApp({ identity });
    console.log(`Runner helper 已安装：${info.appPath}`);
    console.log(`Bundle ID：${info.bundleId}`);
    console.log(`签名：${identity === "-" ? "ad-hoc（免费，仅本机稳定）" : identity}`);
    console.log("下一步执行：./scripts/start.sh install-launchd runner");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
