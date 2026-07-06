#!/usr/bin/env bash
# 安装 macOS launchd 自启（Runner + Bridge）
# 推荐直接运行仓库根目录：
#   ./scripts/start.sh install-launchd
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec "$ROOT/scripts/start.sh" install-launchd
