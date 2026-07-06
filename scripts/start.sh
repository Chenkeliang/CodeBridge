#!/usr/bin/env bash
# 飞书码桥 — 引导安装 / 一键启动
# 用法:
#   ./scripts/start.sh setup       # 交互式首次安装
#   ./scripts/start.sh             # 检查依赖 → 停旧进程 → 后台启动
#   ./scripts/start.sh fg          # 前台启动 Bridge（调试用）
#   ./scripts/start.sh docker      # 宿主机 Runner + Docker Bridge
#   ./scripts/start.sh stop        # 停止服务
#   ./scripts/start.sh restart     # 重启服务
#   ./scripts/start.sh install-launchd [runner|bridge|all]   # macOS 开机自启（launchd，默认 all）
#   ./scripts/start.sh uninstall-launchd [runner|bridge|all] # 卸载 launchd（改用手动 start.sh）
#   ./scripts/start.sh status      # 查看状态
#   ./scripts/start.sh doctor      # 诊断
#   ./scripts/start.sh help        # 帮助
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$HOME/.feishu-code-bridge}"
CONFIG="$DATA_DIR/config.yaml"
PID_DIR="$DATA_DIR/run"
RUNNER_PID="$PID_DIR/runner.pid"
BRIDGE_PID="$PID_DIR/bridge.pid"
RUNNER_LOG="$DATA_DIR/runner.log"
BRIDGE_LOG="$DATA_DIR/bridge.log"
RUNNER_PORT="${RUNNER_PORT:-19789}"
LAUNCHD_RUNNER_LABEL="com.feishu-code-bridge.runner"
LAUNCHD_BRIDGE_LABEL="com.feishu-code-bridge.bridge"
LAUNCHD_RUNNER_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_RUNNER_LABEL}.plist"
LAUNCHD_BRIDGE_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_BRIDGE_LABEL}.plist"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info() { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}!!>${NC} $*"; }
err() { echo -e "${RED}xx>${NC} $*" >&2; }
title() { echo -e "\n${BOLD}${CYAN}$*${NC}\n"; }

ask_yes() {
  local prompt="$1"
  local default="${2:-y}"
  local hint="Y/n"
  [[ "$default" == "n" ]] && hint="y/N"
  read -r -p "$(echo -e "${prompt} [${hint}]: ")" ans
  ans="${ans:-$default}"
  [[ "$ans" =~ ^[Yy] ]]
}

has_cmd() { command -v "$1" >/dev/null 2>&1; }

need_cmd() {
  if ! has_cmd "$1"; then
    err "缺少命令: $1"
    return 1
  fi
  return 0
}

read_yaml_scalar() {
  local key="$1"
  node - "$CONFIG" "$key" <<'NODE'
const fs = require("fs");
const [file, key] = process.argv.slice(2);
if (!fs.existsSync(file)) process.exit(2);
const text = fs.readFileSync(file, "utf8");
const lines = text.split("\n");
let section = "";
for (const line of lines) {
  const sec = line.match(/^([a-zA-Z0-9_]+):\s*$/);
  if (sec) {
    section = sec[1];
    continue;
  }
  const m = line.match(/^\s+([a-zA-Z0-9_]+):\s*(.+?)\s*$/);
  if (!m) continue;
  const full = section ? `${section}.${m[1]}` : m[1];
  if (full === key) {
    let v = m[2].replace(/^["']|["']$/g, "");
    console.log(v);
    process.exit(0);
  }
}
process.exit(1);
NODE
}

ensure_built() {
  if [[ ! -f "$ROOT/apps/bridge/dist/cli.js" ]] || [[ ! -f "$ROOT/packages/runner-host/dist/cli.js" ]]; then
    info "正在构建…"
    (cd "$ROOT" && pnpm build)
  fi
}

print_banner() {
  echo -e "${BOLD}"
  echo "  飞书码桥 feishu-code-bridge"
  echo "  飞书远程驱动本机 Cursor / Claude Code / Codex"
  echo -e "${NC}"
}

print_usage_guide() {
  title "飞书里怎么用"
  cat <<'EOF'
  常用斜杠命令：
    /help          全部命令
    /status        当前 backend / 目录 / model
    /resume        列出本机 CLI session 并续聊
    /backend claude  切换 Agent
    /cd <path>     切换项目目录
    /ws save go    保存工作区

  群聊默认需 @机器人；单聊可直接发消息。
  可在飞书开放平台配置机器人「自定义菜单」固定常用命令：
    docs/zh-CN/feishu-bot-menu.md
EOF
  echo ""
  title "本机管理命令"
  cat <<EOF
    $0 status     查看运行状态
    $0 stop       停止服务
    $0 doctor     诊断 Runner / CLI
    $0 fg         前台启动 Bridge（看实时日志）
    tail -f $RUNNER_LOG
    tail -f $BRIDGE_LOG
EOF
  echo ""
}

check_core_deps() {
  local ok=1
  title "检查基础依赖"
  for cmd in node pnpm curl; do
    if has_cmd "$cmd"; then
      local ver
      ver="$($cmd --version 2>&1 | head -1)"
      echo -e "  ${GREEN}✓${NC} $cmd — $ver"
    else
      echo -e "  ${RED}✗${NC} $cmd — 未安装"
      ok=0
    fi
  done
  if [[ "$ok" -eq 0 ]]; then
    echo ""
    warn "请先安装："
    echo "  brew install node pnpm    # 或 https://nodejs.org"
    return 1
  fi
  return 0
}

# 检查单个 CLI backend；stdout 打印 ✓/✗ 行，返回 0/1
check_one_cli() {
  local label="$1"
  shift
  local cmds=("$@")
  local found=""
  for c in "${cmds[@]}"; do
    if has_cmd "$c"; then
      found="$c"
      break
    fi
  done
  if [[ -n "$found" ]]; then
    local ver
    ver="$("$found" --version 2>&1 | head -1 || echo "已安装")"
    echo -e "  ${GREEN}✓${NC} ${label} (${found}) — ${ver}"
    return 0
  fi
  echo -e "  ${RED}✗${NC} ${label} — 未找到（尝试过: ${cmds[*]}）"
  return 1
}

print_cli_install_hints() {
  echo ""
  warn "至少安装一个 Agent CLI 才能写代码。安装参考："
  echo ""
  echo "  Cursor Agent:"
  echo "    https://cursor.com/docs/cli"
  echo "    安装后命令多为 cursor-agent 或 agent"
  echo ""
  echo "  Claude Code:"
  echo "    npm install -g @anthropic-ai/claude-code"
  echo "    或 brew install --cask claude-code"
  echo ""
  echo "  Codex:"
  echo "    npm install -g @openai/codex"
  echo ""
}

check_agent_clis() {
  title "检查 Agent CLI"
  local any=0
  check_one_cli "Cursor" cursor-agent agent && any=1 || true
  check_one_cli "Claude Code" claude && any=1 || true
  check_one_cli "Codex" codex && any=1 || true
  if [[ "$any" -eq 0 ]]; then
    print_cli_install_hints
    if ask_yes "是否继续启动（仅验证飞书连接，尚不能写代码）" "n"; then
      return 0
    fi
    return 1
  fi
  if ! check_one_cli "Cursor" cursor-agent agent; then
    echo "    可选安装 Cursor CLI，config 默认 backend 为 cursor"
  fi
  if ! check_one_cli "Claude Code" claude; then
    echo "    可选安装 Claude Code"
  fi
  if ! check_one_cli "Codex" codex; then
    echo "    可选安装 Codex"
  fi
  return 0
}

offer_cli_install() {
  title "安装 Agent CLI（可选）"
  echo "选择要尝试自动安装的组件（需本机已有 npm / brew）："
  echo ""
  if ! has_cmd cursor-agent && ! has_cmd agent; then
    if ask_yes "尝试用 npm 安装 Cursor CLI (@cursor-ai/cli)？" "n"; then
      npm install -g @cursor-ai/cli 2>/dev/null || warn "Cursor CLI 请手动安装"
    fi
  fi
  if ! has_cmd claude; then
    if ask_yes "尝试 npm 全局安装 Claude Code？" "n"; then
      npm install -g @anthropic-ai/claude-code 2>/dev/null || warn "Claude Code 请手动安装"
    fi
  fi
  if ! has_cmd codex; then
    if ask_yes "尝试 npm 全局安装 Codex？" "n"; then
      npm install -g @openai/codex 2>/dev/null || warn "Codex 请手动安装"
    fi
  fi
}

print_feishu_checklist() {
  title "飞书应用配置"
  echo "  配置文件: $CONFIG"
  echo ""
  echo "  1. 飞书开放平台 → 企业自建应用 → 开启机器人"
  echo "  2. 填写 appId / appSecret 到 config.yaml"
  echo "  3. 权限: im:message、im:message:send_as_bot"
  echo "  4. 事件订阅（长连接）:"
  echo "     - im.message.receive_v1"
  echo "     - im.chat.access_event.bot_p2p_chat_entered_v1  （欢迎语）"
  echo "     - application.bot.menu_v6                        （自定义菜单，可选）"
  echo "  5. 先启动本服务，再在控制台保存长连接配置"
  echo ""
  echo "  详见: $ROOT/docs/zh-CN/feishu-app-setup.md"
  echo "  菜单: $ROOT/docs/zh-CN/feishu-bot-menu.md"
  echo ""
}

prompt_feishu_credentials() {
  if [[ ! -f "$CONFIG" ]]; then return; fi
  local app_id app_secret
  app_id="$(read_yaml_scalar feishu.appId 2>/dev/null || true)"
  app_secret="$(read_yaml_scalar feishu.appSecret 2>/dev/null || true)"
  if [[ "$app_id" == "cli_placeholder" || -z "$app_id" ]]; then
    echo ""
    warn "feishu.appId 尚未配置"
    read -r -p "  输入飞书 App ID（回车跳过）: " input_id
    if [[ -n "$input_id" ]]; then
      sed -i.bak -E "s/(^[[:space:]]*appId:[[:space:]]*).*/\\1${input_id}/" "$CONFIG"
      rm -f "$CONFIG.bak"
    fi
  fi
  if [[ "$app_secret" == "secret_placeholder" || -z "$app_secret" ]]; then
    warn "feishu.appSecret 尚未配置"
    read -r -p "  输入飞书 App Secret（回车跳过）: " input_secret
    if [[ -n "$input_secret" ]]; then
      sed -i.bak -E "s/(^[[:space:]]*appSecret:[[:space:]]*).*/\\1${input_secret}/" "$CONFIG"
      rm -f "$CONFIG.bak"
    fi
  fi
}

print_checklist() {
  print_feishu_checklist
  print_usage_guide
}

cmd_setup() {
  print_banner
  title "引导安装"
  check_core_deps || exit 1
  mkdir -p "$DATA_DIR" "$PID_DIR"

  info "安装 npm 依赖…"
  (cd "$ROOT" && pnpm install)

  info "构建项目…"
  (cd "$ROOT" && pnpm build)

  if [[ ! -f "$CONFIG" ]]; then
    info "生成默认配置 $CONFIG"
    DATA_DIR="$DATA_DIR" node "$ROOT/apps/bridge/dist/cli.js" init
  fi

  local token
  token="$(read_yaml_scalar runner.token 2>/dev/null || true)"
  if [[ -z "$token" || "$token" == change-me* ]]; then
    local new_token
    new_token="$(openssl rand -hex 24 2>/dev/null || node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
    info "生成 Runner token"
    if grep -q 'token:' "$CONFIG"; then
      sed -i.bak -E "s/(^[[:space:]]*token:[[:space:]]*).*/\\1${new_token}/" "$CONFIG"
      rm -f "$CONFIG.bak"
    fi
  fi

  if ask_yes "是否现在填写飞书 App 凭据？" "y"; then
    prompt_feishu_credentials
  fi

  if ask_yes "是否尝试安装缺失的 Agent CLI？" "y"; then
    offer_cli_install
  fi

  check_agent_clis || true

  info "引导完成"
  print_checklist

  if ask_yes "是否立即后台启动服务？" "y"; then
    cmd_start bg
  fi
}

check_config_ready() {
  if [[ ! -f "$CONFIG" ]]; then
    err "未找到配置: $CONFIG"
    echo "请先运行: $0 setup"
    exit 1
  fi

  local app_id app_secret token
  app_id="$(read_yaml_scalar feishu.appId 2>/dev/null || true)"
  app_secret="$(read_yaml_scalar feishu.appSecret 2>/dev/null || true)"
  token="$(read_yaml_scalar runner.token 2>/dev/null || true)"

  local ok=1
  if [[ -z "$app_id" || "$app_id" == "cli_placeholder" ]]; then
    err "请在 $CONFIG 中设置 feishu.appId"
    ok=0
  fi
  if [[ -z "$app_secret" || "$app_secret" == "secret_placeholder" ]]; then
    err "请在 $CONFIG 中设置 feishu.appSecret"
    ok=0
  fi
  if [[ -z "$token" || "$token" == change-me* ]]; then
    err "请设置 runner.token（运行 $0 setup 可自动生成）"
    ok=0
  fi
  if [[ "$ok" -eq 0 ]]; then
    print_checklist
    exit 1
  fi
}

wait_runner() {
  local token="$1"
  local i
  for i in {1..40}; do
    if curl -sf -H "Authorization: Bearer $token" "http://127.0.0.1:${RUNNER_PORT}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

is_running() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(cat "$pid_file")"
  kill -0 "$pid" 2>/dev/null
}

stop_pid_file() {
  local name="$1"
  local file="$2"
  if is_running "$file"; then
    local pid
    pid="$(cat "$file")"
    kill "$pid" 2>/dev/null || true
    sleep 0.5
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    info "已停止 $name (pid $pid)"
    return 0
  fi
  rm -f "$file"
  return 1
}

stop_port_listener() {
  local port="$1"
  if ! has_cmd lsof; then
    return
  fi
  local pids
  pids="$(lsof -ti:"$port" 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return
  fi
  warn "释放端口 ${port} 上的旧进程: $pids"
  kill $pids 2>/dev/null || true
  sleep 0.5
  pids="$(lsof -ti:"$port" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill -9 $pids 2>/dev/null || true
    sleep 0.2
  fi
}

stop_orphan_processes() {
  pkill -f "packages/runner-host/dist/cli.js" 2>/dev/null || true
  pkill -f "apps/bridge/dist/cli.js start" 2>/dev/null || true
  sleep 0.3
  pkill -9 -f "packages/runner-host/dist/cli.js" 2>/dev/null || true
  pkill -9 -f "apps/bridge/dist/cli.js start" 2>/dev/null || true
}

cmd_stop() {
  local stopped=0
  stop_pid_file "Runner" "$RUNNER_PID" && stopped=1 || true
  stop_pid_file "Bridge" "$BRIDGE_PID" && stopped=1 || true
  stop_port_listener "$RUNNER_PORT"
  stop_orphan_processes
  rm -f "$RUNNER_PID" "$BRIDGE_PID"
  if [[ "$stopped" -eq 0 ]] && has_cmd lsof && lsof -ti:"$RUNNER_PORT" >/dev/null 2>&1; then
    warn "已清理端口 ${RUNNER_PORT} 上的残留进程"
    stopped=1
  fi
  if [[ "$stopped" -eq 0 ]]; then
    warn "没有由本脚本管理的运行中进程"
  fi
}

bridge_orphan_pids() {
  pgrep -f "apps/bridge/dist/cli.js start" 2>/dev/null || true
}

launchd_domain() {
  echo "gui/$(id -u)"
}

launchd_loaded() {
  local label="$1"
  launchctl print "$(launchd_domain)/$label" &>/dev/null
}

launchd_path_for_agents() {
  local path="${PATH:-}"
  path="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${path}"
  printf '%s' "$path"
}

launchd_bootout() {
  local label="$1"
  local plist="$2"
  [[ -f "$plist" ]] || return 0
  if launchd_loaded "$label"; then
    launchctl bootout "$(launchd_domain)" "$plist" 2>/dev/null \
      || launchctl unload "$plist" 2>/dev/null \
      || true
  fi
}

launchd_bootstrap() {
  local plist="$1"
  launchctl bootstrap "$(launchd_domain)" "$plist" 2>/dev/null \
    || launchctl load "$plist"
}

warn_launchd_conflict() {
  local runner=0 bridge=0
  launchd_loaded "$LAUNCHD_RUNNER_LABEL" && runner=1
  launchd_loaded "$LAUNCHD_BRIDGE_LABEL" && bridge=1
  if [[ "$runner" -eq 0 && "$bridge" -eq 0 ]]; then
    return 1
  fi
  err "检测到 macOS launchd 自启服务（KeepAlive），会与 start.sh 抢端口、抢进程。"
  err "常见症状：Runner 僵尸进程、/runs 空响应、飞书报 terminated。"
  err "launchd 默认 PATH 不含 nvm，还会导致 cursor-agent ENOENT。"
  [[ "$runner" -eq 1 ]] && err "  · 已加载: $LAUNCHD_RUNNER_LABEL"
  [[ "$bridge" -eq 1 ]] && err "  · 已加载: $LAUNCHD_BRIDGE_LABEL"
  err "请二选一："
  err "  $0 uninstall-launchd && $0 restart    # 改用手动 start.sh（开发推荐）"
  err "  $0 install-launchd                  # 只用 launchd 开机自启"
  return 0
}

ensure_no_launchd_conflict() {
  if warn_launchd_conflict; then
    exit 1
  fi
}

write_launchd_plist() {
  local label="$1"
  local plist="$2"
  local stdout_log="$3"
  local stderr_log="$4"
  shift 4
  local -a args=("$@")
  local node path
  node="$(command -v node)"
  path="$(launchd_path_for_agents)"
  mkdir -p "$(dirname "$plist")"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
$(for a in "${args[@]}"; do printf '    <string>%s</string>\n' "$a"; done)
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${stdout_log}</string>
  <key>StandardErrorPath</key>
  <string>${stderr_log}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DATA_DIR</key>
    <string>${DATA_DIR}</string>
    <key>PATH</key>
    <string>${path}</string>
  </dict>
</dict>
</plist>
EOF
}

check_launchd_component() {
  local component="$1"
  case "$component" in
    runner|bridge|all) ;;
    *)
      err "未知组件: $component（可选 runner|bridge|all）"
      exit 1
      ;;
  esac
}

install_launchd_runner() {
  launchd_bootout "$LAUNCHD_RUNNER_LABEL" "$LAUNCHD_RUNNER_PLIST"
  write_launchd_plist "$LAUNCHD_RUNNER_LABEL" "$LAUNCHD_RUNNER_PLIST" \
    "$RUNNER_LOG" "$DATA_DIR/runner.err.log" \
    "$ROOT/packages/runner-host/dist/cli.js"
  launchd_bootstrap "$LAUNCHD_RUNNER_PLIST"
}

install_launchd_bridge() {
  launchd_bootout "$LAUNCHD_BRIDGE_LABEL" "$LAUNCHD_BRIDGE_PLIST"
  write_launchd_plist "$LAUNCHD_BRIDGE_LABEL" "$LAUNCHD_BRIDGE_PLIST" \
    "$BRIDGE_LOG" "$DATA_DIR/bridge.err.log" \
    "$ROOT/apps/bridge/dist/cli.js" "start"
  launchd_bootstrap "$LAUNCHD_BRIDGE_PLIST"
}

cmd_install_launchd() {
  local component="${1:-all}"
  check_launchd_component "$component"
  ensure_built
  need_cmd node || exit 1
  info "安装 launchd 自启（$component）…"
  cmd_stop 2>/dev/null || true
  [[ "$component" == "runner" || "$component" == "all" ]] && install_launchd_runner
  [[ "$component" == "bridge" || "$component" == "all" ]] && install_launchd_bridge
  info "launchd 已加载。查看: launchctl list | grep feishu-code-bridge"
  case "$component" in
    runner) info "日志: $RUNNER_LOG" ;;
    bridge) info "日志: $BRIDGE_LOG" ;;
    all) info "日志: $RUNNER_LOG / $BRIDGE_LOG" ;;
  esac
  warn "之后请用 launchctl 或 $0 uninstall-launchd 管理，不要与 $0 start 混用。"
}

cmd_uninstall_launchd() {
  local component="${1:-all}"
  check_launchd_component "$component"
  info "卸载 launchd 自启（$component）…"
  if [[ "$component" == "runner" || "$component" == "all" ]]; then
    launchd_bootout "$LAUNCHD_RUNNER_LABEL" "$LAUNCHD_RUNNER_PLIST"
    rm -f "$LAUNCHD_RUNNER_PLIST"
  fi
  if [[ "$component" == "bridge" || "$component" == "all" ]]; then
    launchd_bootout "$LAUNCHD_BRIDGE_LABEL" "$LAUNCHD_BRIDGE_PLIST"
    rm -f "$LAUNCHD_BRIDGE_PLIST"
  fi
  stop_port_listener "$RUNNER_PORT"
  stop_orphan_processes
  info "launchd 已卸载。可执行: $0 start"
}

cmd_status() {
  echo "配置: $CONFIG"
  echo "数据: $DATA_DIR"
  if is_running "$RUNNER_PID"; then
    echo "Runner: 运行中 (pid $(cat "$RUNNER_PID"), log $RUNNER_LOG)"
  elif has_cmd lsof && lsof -ti:"$RUNNER_PORT" >/dev/null 2>&1; then
    echo "Runner: 端口 ${RUNNER_PORT} 被占用但无 pid 文件（僵尸进程，请 $0 stop)"
  else
    echo "Runner: 未运行"
  fi
  if is_running "$BRIDGE_PID"; then
    echo "Bridge: 运行中 (pid $(cat "$BRIDGE_PID"), log $BRIDGE_LOG)"
  elif [[ -n "$(bridge_orphan_pids)" ]]; then
    echo "Bridge: 进程在运行但无 pid 文件（pid $(bridge_orphan_pids | tr '\n' ' ')，请 $0 stop)"
  else
    echo "Bridge: 未运行"
  fi
  echo ""
  if launchd_loaded "$LAUNCHD_RUNNER_LABEL" || launchd_loaded "$LAUNCHD_BRIDGE_LABEL"; then
    warn "launchd 自启: 已加载（与 start.sh 手动模式冲突时请 $0 uninstall-launchd）"
    launchd_loaded "$LAUNCHD_RUNNER_LABEL" && echo "  · $LAUNCHD_RUNNER_LABEL"
    launchd_loaded "$LAUNCHD_BRIDGE_LABEL" && echo "  · $LAUNCHD_BRIDGE_LABEL"
    echo ""
  fi
  check_one_cli "Cursor" cursor-agent agent || true
  check_one_cli "Claude Code" claude || true
  check_one_cli "Codex" codex || true
}

cmd_doctor() {
  ensure_built
  DATA_DIR="$DATA_DIR" node "$ROOT/apps/bridge/dist/cli.js" doctor
}

start_runner_bg() {
  mkdir -p "$PID_DIR" "$(dirname "$RUNNER_LOG")"
  stop_orphan_processes
  stop_port_listener "$RUNNER_PORT"
  info "启动 Runner → $RUNNER_LOG"
  cd "$ROOT"
  export DATA_DIR
  nohup node packages/runner-host/dist/cli.js >>"$RUNNER_LOG" 2>&1 &
  echo $! >"$RUNNER_PID"
  disown -h 2>/dev/null || true
  local token
  token="$(read_yaml_scalar runner.token)"
  if wait_runner "$token"; then
    info "Runner 就绪: http://127.0.0.1:${RUNNER_PORT}/health"
  else
    err "Runner 启动超时，查看日志: $RUNNER_LOG"
    exit 1
  fi
}

stop_bridge_orphans() {
  pkill -f "apps/bridge/dist/cli.js start" 2>/dev/null || true
  sleep 0.2
  pkill -9 -f "apps/bridge/dist/cli.js start" 2>/dev/null || true
}

start_bridge_bg() {
  stop_bridge_orphans
  info "启动 Bridge → $BRIDGE_LOG"
  cd "$ROOT"
  export DATA_DIR
  nohup node apps/bridge/dist/cli.js start >>"$BRIDGE_LOG" 2>&1 &
  echo $! >"$BRIDGE_PID"
  disown -h 2>/dev/null || true
  sleep 1
  if is_running "$BRIDGE_PID"; then
    info "Bridge 运行中 (pid $(cat "$BRIDGE_PID"))"
  else
    err "Bridge 启动失败，查看: $BRIDGE_LOG"
    exit 1
  fi
}

start_bridge_fg() {
  info "前台启动 Bridge（Ctrl+C 停止 Bridge；Runner 需另用 stop 关闭）"
  export DATA_DIR
  cd "$ROOT"
  trap 'cmd_stop; exit 0' INT TERM
  exec node apps/bridge/dist/cli.js start
}

run_preflight() {
  print_banner
  if [[ ! -f "$CONFIG" ]]; then
    warn "首次使用，进入引导安装…"
    cmd_setup
    return $?
  fi
  check_core_deps || exit 1
  check_agent_clis || true
}

cmd_start() {
  local mode="${1:-bg}"
  ensure_no_launchd_conflict
  need_cmd node || exit 1
  need_cmd pnpm || exit 1
  need_cmd curl || exit 1
  mkdir -p "$DATA_DIR" "$PID_DIR"
  ensure_built
  check_config_ready

  run_preflight

  info "停止旧进程…"
  cmd_stop

  start_runner_bg

  if [[ "$mode" == "fg" ]]; then
    start_bridge_fg
  else
    start_bridge_bg
    echo ""
    info "服务已在后台运行"
    echo "  Runner  log: $RUNNER_LOG"
    echo "  Bridge  log: $BRIDGE_LOG"
    echo "  查看状态: $0 status"
    echo "  停止服务: $0 stop"
    echo ""
    print_usage_guide
  fi
}

cmd_docker() {
  need_cmd docker || exit 1
  need_cmd curl || exit 1
  mkdir -p "$DATA_DIR" "$PID_DIR"
  ensure_built
  check_config_ready
  run_preflight

  cmd_stop

  local token app_id app_secret
  token="$(read_yaml_scalar runner.token)"
  app_id="$(read_yaml_scalar feishu.appId)"
  app_secret="$(read_yaml_scalar feishu.appSecret)"

  local env_file="$ROOT/deploy/.env"
  cat >"$env_file" <<EOF
FEISHU_APP_ID=$app_id
FEISHU_APP_SECRET=$app_secret
FEISHU_DOMAIN=https://open.feishu.cn
RUNNER_URL=http://host.docker.internal:19789
RUNNER_TOKEN=$token
DEFAULT_BACKEND=${DEFAULT_BACKEND:-cursor}
EOF
  info "已写入 $env_file"

  start_runner_bg
  info "启动 Docker Bridge…"
  docker compose -f "$ROOT/deploy/docker-compose.yml" up -d --build
  info "Bridge 容器已启动"
  echo "  日志: docker compose -f $ROOT/deploy/docker-compose.yml logs -f bridge"
  echo "  停止: $0 stop && docker compose -f $ROOT/deploy/docker-compose.yml down"
}

cmd_help() {
  print_banner
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  echo ""
  print_usage_guide
}

main() {
  local cmd="${1:-start}"
  local arg="${2:-}"
  case "$cmd" in
    setup) cmd_setup ;;
    start|"") cmd_start "${arg:-bg}" ;;
    fg|foreground) cmd_start fg ;;
    docker) cmd_docker ;;
    stop) cmd_stop ;;
    restart) cmd_stop; cmd_start "${arg:-bg}" ;;
    install-launchd) cmd_install_launchd "${arg:-all}" ;;
    uninstall-launchd) cmd_uninstall_launchd "${arg:-all}" ;;
    status) cmd_status ;;
    doctor) cmd_doctor ;;
    help|-h|--help) cmd_help ;;
    *)
      err "未知命令: $cmd"
      echo "用法: $0 {setup|start|fg|docker|stop|restart|install-launchd [runner|bridge|all]|uninstall-launchd [runner|bridge|all]|status|doctor|help}"
      exit 1
      ;;
  esac
}

main "$@"
