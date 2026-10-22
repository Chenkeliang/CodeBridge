#!/usr/bin/env bash
# 安装 macOS launchd 自启（仅 Runner，Bridge 走 Docker 的部署形态用这个）
# 推荐直接运行仓库根目录：
#   ./scripts/start.sh install-launchd runner
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec "$ROOT/scripts/start.sh" install-launchd runner
