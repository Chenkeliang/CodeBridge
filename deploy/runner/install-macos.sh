#!/usr/bin/env bash
# Install feishu-code-runner as a macOS launchd user agent
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.feishu-code-bridge.runner.plist"
NODE="$(command -v node)"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.feishu-code-bridge.runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${ROOT}/packages/runner-host/dist/cli.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${HOME}/.feishu-code-bridge/runner.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/.feishu-code-bridge/runner.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DATA_DIR</key>
    <string>${HOME}/.feishu-code-bridge</string>
  </dict>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Installed runner launch agent: $PLIST"
