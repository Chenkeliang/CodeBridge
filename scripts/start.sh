#!/usr/bin/env bash
# CodeBridge — 引导安装 / 一键启动
# 用法:
#   ./scripts/start.sh setup       # 交互式首次安装
#   ./scripts/start.sh             # 检查依赖 → 停旧进程 → 后台启动（含守护，挂掉自动拉起）
#   ./scripts/start.sh fg          # 前台启动 Bridge（调试用）
#   ./scripts/start.sh docker      # 宿主机 Runner + Docker Bridge
#   ./scripts/start.sh stop        # 停止服务
#   ./scripts/start.sh restart     # 重启服务
#   ./scripts/start.sh install-launchd [runner|bridge|all]   # macOS 开机自启（launchd，默认 all）
#   ./scripts/start.sh install-macos-runner [codesign-id]    # 固定 Bundle ID/signature 的 Runner helper
#   ./scripts/start.sh uninstall-launchd [runner|bridge|all] # 卸载 launchd（改用手动 start.sh）
#   ./scripts/start.sh status      # 查看状态
#   ./scripts/start.sh doctor      # 诊断
#   ./scripts/start.sh help        # 帮助
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_DATA_DIR="$HOME/.codebridge"
# 旧名称仅用于一次性迁移；删除会导致老用户的配置与 Session 无法升级。
LEGACY_DATA_DIR="$HOME/.feishu-code-bridge"
REQUESTED_CMD="${1:-start}"
EXPLICIT_DATA_DIR=0
if [[ -n "${DATA_DIR:-}" ]]; then
  EXPLICIT_DATA_DIR=1
  DATA_DIR="$DATA_DIR"
elif [[ "$REQUESTED_CMD" == "restart" || "$REQUESTED_CMD" == "install-launchd" || "$REQUESTED_CMD" == "install-macos-runner" ]]; then
  DATA_DIR="$DEFAULT_DATA_DIR"
elif [[ -d "$DEFAULT_DATA_DIR" || ! -d "$LEGACY_DATA_DIR" ]]; then
  DATA_DIR="$DEFAULT_DATA_DIR"
else
  # 只读状态和旧版手动启动继续识别原目录；restart/install-launchd 会完成迁移。
  DATA_DIR="$LEGACY_DATA_DIR"
fi
CONFIG="$DATA_DIR/config.yaml"
PID_DIR="$DATA_DIR/run"
RUNNER_PID="$PID_DIR/runner.pid"
BRIDGE_PID="$PID_DIR/bridge.pid"
RUNNER_LOG="$DATA_DIR/runner.log"
BRIDGE_LOG="$DATA_DIR/bridge.log"
WATCHDOG_PID="$PID_DIR/watchdog.pid"
WATCHDOG_LOG="$DATA_DIR/watchdog.log"
MANUAL_LOCK="$PID_DIR/manual.lock"
RESTART_LOCK="$HOME/.codebridge-restart.lock"
RESTART_STAMP="$HOME/.codebridge-restart.stamp"
RESTART_COOLDOWN_SEC="${CODEBRIDGE_RESTART_COOLDOWN_SEC:-60}"
RUNNER_PORT="${RUNNER_PORT:-19789}"
LAUNCHD_RUNNER_LABEL="com.codebridge.runner"
LAUNCHD_BRIDGE_LABEL="com.codebridge.bridge"
# 同上：只识别并卸载旧 launchd 任务，不作为当前 CodeBridge 身份使用。
LEGACY_LAUNCHD_RUNNER_LABEL="com.feishu-code-bridge.runner"
LEGACY_LAUNCHD_BRIDGE_LABEL="com.feishu-code-bridge.bridge"
LAUNCHD_RUNNER_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_RUNNER_LABEL}.plist"
LAUNCHD_BRIDGE_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_BRIDGE_LABEL}.plist"
LEGACY_LAUNCHD_RUNNER_PLIST="$HOME/Library/LaunchAgents/${LEGACY_LAUNCHD_RUNNER_LABEL}.plist"
LEGACY_LAUNCHD_BRIDGE_PLIST="$HOME/Library/LaunchAgents/${LEGACY_LAUNCHD_BRIDGE_LABEL}.plist"
MACOS_RUNNER_EXECUTABLE="$HOME/Applications/CodeBridge Runner.app/Contents/MacOS/CodeBridgeRunner"
LEGACY_MACOS_RUNNER_EXECUTABLE="$HOME/Applications/Feishu Code Runner.app/Contents/MacOS/FeishuCodeRunner"

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
  if [[ ! -f "$ROOT/apps/bridge/dist/cli.js" ]] || [[ ! -f "$ROOT/packages/runner-host/dist/cli.js" ]] || [[ ! -f "$ROOT/apps/web/dist/index.html" ]]; then
    info "正在构建…"
    (cd "$ROOT" && pnpm build)
  fi
}

print_banner() {
  echo -e "${BOLD}"
  echo "  CodeBridge"
  echo "  从飞书或 Telegram 远程驱动本机 Cursor / Claude Code / Codex"
  echo -e "${NC}"
}

print_usage_guide() {
  title "飞书里怎么用"
  cat <<'EOF'
  常用斜杠命令：
    /help          手机快捷菜单（/help full 查看全部）
    /status        当前 backend / 目录 / model
    /resume        列出本机 ACP session 并续聊
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

  local app_id app_secret telegram_token token
  app_id="$(read_yaml_scalar feishu.appId 2>/dev/null || true)"
  app_secret="$(read_yaml_scalar feishu.appSecret 2>/dev/null || true)"
  telegram_token="$(read_yaml_scalar telegram.botToken 2>/dev/null || true)"
  token="$(read_yaml_scalar runner.token 2>/dev/null || true)"

  local ok=1
  local feishu_ready=1
  if [[ -z "$app_id" || "$app_id" == "cli_placeholder" || -z "$app_secret" || "$app_secret" == "secret_placeholder" ]]; then
    feishu_ready=0
  fi
  if [[ "$feishu_ready" -eq 0 && -z "$telegram_token" ]]; then
    err "请至少配置飞书 App 凭据或 telegram.botToken"
    ok=0
  fi
  if [[ "$feishu_ready" -eq 0 && -n "$telegram_token" ]]; then
    info "未配置飞书凭据，使用 Telegram-only 模式"
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

# ---- 常驻守护：服务进程消失时 10s 内自动拉起 ----

acquire_manual_lock() {
  mkdir -p "$PID_DIR"
  echo $$ >"$MANUAL_LOCK"
  trap 'rm -f "$MANUAL_LOCK" "$RESTART_LOCK"' EXIT
}

try_acquire_restart_lock() {
  (set -o noclobber; echo $$ >"$RESTART_LOCK") 2>/dev/null
}

acquire_restart_guard() {
  if ! try_acquire_restart_lock; then
    local owner
    owner="$(cat "$RESTART_LOCK" 2>/dev/null || true)"
    if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then
      warn "已有重启操作正在执行 (pid ${owner})，本次跳过"
      return 1
    fi
    rm -f "$RESTART_LOCK"
    if ! try_acquire_restart_lock; then
      warn "无法取得重启锁，本次跳过"
      return 1
    fi
  fi

  local now last elapsed
  now="$(date +%s)"
  last="$(cat "$RESTART_STAMP" 2>/dev/null || true)"
  if [[ "${CODEBRIDGE_FORCE_RESTART:-0}" != "1" && "$last" =~ ^[0-9]+$ ]]; then
    elapsed=$((now - last))
    if [[ "$elapsed" -lt "$RESTART_COOLDOWN_SEC" ]]; then
      warn "${RESTART_COOLDOWN_SEC} 秒内已执行过重启，本次健康检查不再重复重启"
      rm -f "$RESTART_LOCK"
      return 1
    fi
  fi
  trap 'rm -f "$MANUAL_LOCK" "$RESTART_LOCK"' EXIT
  return 0
}

mark_restart_attempt() {
  date +%s >"$RESTART_STAMP"
}

manual_lock_active() {
  local lock pid
  for lock in "$MANUAL_LOCK" "$RESTART_LOCK"; do
    [[ -f "$lock" ]] || continue
    pid="$(cat "$lock" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

start_watchdog_bg() {
  if is_running "$WATCHDOG_PID"; then
    info "守护已在运行 (pid $(cat "$WATCHDOG_PID"))"
    return 0
  fi
  mkdir -p "$PID_DIR"
  export DATA_DIR
  nohup "$ROOT/scripts/start.sh" __watchdog >>"$WATCHDOG_LOG" 2>&1 &
  echo $! >"$WATCHDOG_PID"
  disown -h 2>/dev/null || true
  info "守护已启动 (pid $(cat "$WATCHDOG_PID"))：服务挂掉 10s 内自动拉起，日志 $WATCHDOG_LOG"
}

stop_watchdog() {
  if is_running "$WATCHDOG_PID"; then
    kill "$(cat "$WATCHDOG_PID")" 2>/dev/null || true
    info "已停止守护（服务挂掉不再自动拉起）"
  fi
  rm -f "$WATCHDOG_PID"
}

cmd_watchdog() {
  echo "[watchdog] $(date '+%F %T') 守护启动 (pid $$)"
  while true; do
    sleep 10
    # pid 文件被移除（stop）或被新守护替换 → 本进程退出
    [[ "$(cat "$WATCHDOG_PID" 2>/dev/null || true)" == "$$" ]] || exit 0
    # start.sh 正在人工操作（start/stop/restart）时暂停巡检，避免抢跑
    if manual_lock_active; then continue; fi
    if ! is_running "$RUNNER_PID"; then
      echo "[watchdog] $(date '+%F %T') Runner 不在运行，自动拉起"
      (start_runner_bg) || echo "[watchdog] Runner 拉起失败，下轮重试"
    fi
    if ! is_running "$BRIDGE_PID"; then
      echo "[watchdog] $(date '+%F %T') Bridge 不在运行，自动拉起"
      (start_bridge_bg) || echo "[watchdog] Bridge 拉起失败，下轮重试"
    fi
  done
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

stop_runner_orphans() {
  pkill -f "packages/runner-host/dist/cli.js" 2>/dev/null || true
  sleep 0.3
  pkill -9 -f "packages/runner-host/dist/cli.js" 2>/dev/null || true
}

stop_orphan_processes() {
  stop_runner_orphans
  pkill -f "apps/bridge/dist/cli.js start" 2>/dev/null || true
  pkill -9 -f "apps/bridge/dist/cli.js start" 2>/dev/null || true
}

cmd_stop() {
  local stopped=0
  acquire_manual_lock
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
  if launchd_loaded "$label"; then
    launchctl bootout "$(launchd_domain)/$label" 2>/dev/null \
      || launchctl bootout "$(launchd_domain)" "$plist" 2>/dev/null \
      || launchctl unload "$plist" 2>/dev/null \
      || true
  fi
}

launchd_bootout_strict() {
  local label="$1"
  local plist="$2"
  launchd_loaded "$label" || return 0
  if ! launchctl bootout "$(launchd_domain)/$label" 2>/dev/null \
    && ! launchctl bootout "$(launchd_domain)" "$plist" 2>/dev/null \
    && ! launchctl unload "$plist" 2>/dev/null; then
    err "无法停止 launchd 服务: ${label}；已中止数据迁移。"
    return 1
  fi
  local attempt
  for attempt in {1..20}; do
    if ! launchd_loaded "$label"; then
      return 0
    fi
    sleep 0.1
  done
  err "launchd 服务停止后仍处于加载状态: ${label}；已中止数据迁移。"
  return 1
}

remove_legacy_launchd() {
  local component="${1:-all}"
  if [[ "$component" == "runner" || "$component" == "all" ]]; then
    launchd_bootout "$LEGACY_LAUNCHD_RUNNER_LABEL" "$LEGACY_LAUNCHD_RUNNER_PLIST"
    rm -f "$LEGACY_LAUNCHD_RUNNER_PLIST"
  fi
  if [[ "$component" == "bridge" || "$component" == "all" ]]; then
    launchd_bootout "$LEGACY_LAUNCHD_BRIDGE_LABEL" "$LEGACY_LAUNCHD_BRIDGE_PLIST"
    rm -f "$LEGACY_LAUNCHD_BRIDGE_PLIST"
  fi
}

MIGRATION_NEW_RUNNER=0
MIGRATION_NEW_BRIDGE=0
MIGRATION_LEGACY_RUNNER=0
MIGRATION_LEGACY_BRIDGE=0
MIGRATION_REINSTALL_RUNNER=0
MIGRATION_REINSTALL_BRIDGE=0

launchd_present() {
  local label="$1"
  local plist="$2"
  launchd_loaded "$label" || [[ -f "$plist" ]]
}

migrate_legacy_entries() {
  local source="$1"
  local destination="$2"
  local prefix="${3:-}"
  local entry name target display
  while IFS= read -r -d '' entry; do
    name="${entry##*/}"
    target="$destination/$name"
    display="${prefix:+$prefix/}$name"
    if [[ -d "$entry" && ! -L "$entry" && -d "$target" && ! -L "$target" ]]; then
      migrate_legacy_entries "$entry" "$target" "$display"
      rmdir "$entry" 2>/dev/null || true
    elif [[ -e "$target" || -L "$target" ]]; then
      warn "保留旧目录中的冲突项: $display"
      ((MIGRATION_CONFLICTS += 1))
    else
      mv "$entry" "$target"
      ((MIGRATION_MOVED += 1))
    fi
  done < <(find "$source" -mindepth 1 -maxdepth 1 -print0)
}

migrate_default_data_dir() {
  [[ -d "$LEGACY_DATA_DIR" ]] || return 0
  if [[ ! -e "$DEFAULT_DATA_DIR" && ! -L "$DEFAULT_DATA_DIR" ]]; then
    mv "$LEGACY_DATA_DIR" "$DEFAULT_DATA_DIR"
    info "已迁移数据目录: $LEGACY_DATA_DIR → $DEFAULT_DATA_DIR"
    return 0
  fi
  if [[ ! -d "$DEFAULT_DATA_DIR" ]]; then
    err "新数据目录路径已存在且不是目录: $DEFAULT_DATA_DIR"
    return 1
  fi

  MIGRATION_MOVED=0
  MIGRATION_CONFLICTS=0
  migrate_legacy_entries "$LEGACY_DATA_DIR" "$DEFAULT_DATA_DIR"
  rmdir "$LEGACY_DATA_DIR" 2>/dev/null || true
  if [[ "$MIGRATION_MOVED" -gt 0 ]]; then
    info "已迁移数据目录: $LEGACY_DATA_DIR → $DEFAULT_DATA_DIR"
  fi
  if [[ "$MIGRATION_CONFLICTS" -gt 0 ]]; then
    warn "旧目录仍保留冲突内容，请确认后手动处理: $LEGACY_DATA_DIR"
  fi
}

prepare_default_data_migration() {
  MIGRATION_NEW_RUNNER=0
  MIGRATION_NEW_BRIDGE=0
  MIGRATION_LEGACY_RUNNER=0
  MIGRATION_LEGACY_BRIDGE=0
  MIGRATION_REINSTALL_RUNNER=0
  MIGRATION_REINSTALL_BRIDGE=0

  launchd_present "$LAUNCHD_RUNNER_LABEL" "$LAUNCHD_RUNNER_PLIST" && MIGRATION_NEW_RUNNER=1
  launchd_present "$LAUNCHD_BRIDGE_LABEL" "$LAUNCHD_BRIDGE_PLIST" && MIGRATION_NEW_BRIDGE=1
  launchd_present "$LEGACY_LAUNCHD_RUNNER_LABEL" "$LEGACY_LAUNCHD_RUNNER_PLIST" && MIGRATION_LEGACY_RUNNER=1
  launchd_present "$LEGACY_LAUNCHD_BRIDGE_LABEL" "$LEGACY_LAUNCHD_BRIDGE_PLIST" && MIGRATION_LEGACY_BRIDGE=1

  if [[ "$EXPLICIT_DATA_DIR" -eq 1 ]]; then
    MIGRATION_REINSTALL_RUNNER="$MIGRATION_LEGACY_RUNNER"
    MIGRATION_REINSTALL_BRIDGE="$MIGRATION_LEGACY_BRIDGE"
    [[ "$MIGRATION_LEGACY_RUNNER" -eq 1 ]] && launchd_bootout_strict "$LEGACY_LAUNCHD_RUNNER_LABEL" "$LEGACY_LAUNCHD_RUNNER_PLIST"
    [[ "$MIGRATION_LEGACY_BRIDGE" -eq 1 ]] && launchd_bootout_strict "$LEGACY_LAUNCHD_BRIDGE_LABEL" "$LEGACY_LAUNCHD_BRIDGE_PLIST"
    rm -f "$LEGACY_LAUNCHD_RUNNER_PLIST" "$LEGACY_LAUNCHD_BRIDGE_PLIST"
    return 0
  fi

  if [[ -d "$LEGACY_DATA_DIR" ]]; then
    MIGRATION_REINSTALL_RUNNER=$((MIGRATION_NEW_RUNNER || MIGRATION_LEGACY_RUNNER))
    MIGRATION_REINSTALL_BRIDGE=$((MIGRATION_NEW_BRIDGE || MIGRATION_LEGACY_BRIDGE))

    [[ "$MIGRATION_NEW_RUNNER" -eq 1 ]] && launchd_bootout_strict "$LAUNCHD_RUNNER_LABEL" "$LAUNCHD_RUNNER_PLIST"
    [[ "$MIGRATION_NEW_BRIDGE" -eq 1 ]] && launchd_bootout_strict "$LAUNCHD_BRIDGE_LABEL" "$LAUNCHD_BRIDGE_PLIST"
    [[ "$MIGRATION_LEGACY_RUNNER" -eq 1 ]] && launchd_bootout_strict "$LEGACY_LAUNCHD_RUNNER_LABEL" "$LEGACY_LAUNCHD_RUNNER_PLIST"
    [[ "$MIGRATION_LEGACY_BRIDGE" -eq 1 ]] && launchd_bootout_strict "$LEGACY_LAUNCHD_BRIDGE_LABEL" "$LEGACY_LAUNCHD_BRIDGE_PLIST"
    rm -f "$LEGACY_LAUNCHD_RUNNER_PLIST" "$LEGACY_LAUNCHD_BRIDGE_PLIST"

    stop_watchdog
    stop_pid_file "Runner" "$RUNNER_PID" || true
    stop_pid_file "Bridge" "$BRIDGE_PID" || true
    stop_pid_file "旧版守护" "$LEGACY_DATA_DIR/run/watchdog.pid" || true
    stop_pid_file "旧版 Runner" "$LEGACY_DATA_DIR/run/runner.pid" || true
    stop_pid_file "旧版 Bridge" "$LEGACY_DATA_DIR/run/bridge.pid" || true
    stop_port_listener "$RUNNER_PORT"
    stop_orphan_processes
    migrate_default_data_dir
    return 0
  fi

  MIGRATION_REINSTALL_RUNNER="$MIGRATION_LEGACY_RUNNER"
  MIGRATION_REINSTALL_BRIDGE="$MIGRATION_LEGACY_BRIDGE"
  [[ "$MIGRATION_LEGACY_RUNNER" -eq 1 ]] && launchd_bootout_strict "$LEGACY_LAUNCHD_RUNNER_LABEL" "$LEGACY_LAUNCHD_RUNNER_PLIST"
  [[ "$MIGRATION_LEGACY_BRIDGE" -eq 1 ]] && launchd_bootout_strict "$LEGACY_LAUNCHD_BRIDGE_LABEL" "$LEGACY_LAUNCHD_BRIDGE_PLIST"
  rm -f "$LEGACY_LAUNCHD_RUNNER_PLIST" "$LEGACY_LAUNCHD_BRIDGE_PLIST"
}

launchd_bootstrap() {
  local plist="$1"
  launchctl bootstrap "$(launchd_domain)" "$plist" 2>/dev/null \
    || launchctl load "$plist"
}

restart_launchd_component() {
  local label="$1"
  local installer="$2"
  if launchd_loaded "$label"; then
    if launchctl kickstart -k "$(launchd_domain)/$label"; then
      return 0
    fi
    warn "launchctl kickstart ${label} 失败，改为重新加载"
  fi
  "$installer"
}

warn_launchd_conflict() {
  local runner=0 bridge=0 legacy_runner=0 legacy_bridge=0
  launchd_loaded "$LAUNCHD_RUNNER_LABEL" && runner=1
  launchd_loaded "$LAUNCHD_BRIDGE_LABEL" && bridge=1
  launchd_loaded "$LEGACY_LAUNCHD_RUNNER_LABEL" && legacy_runner=1
  launchd_loaded "$LEGACY_LAUNCHD_BRIDGE_LABEL" && legacy_bridge=1
  if [[ "$runner" -eq 0 && "$bridge" -eq 0 && "$legacy_runner" -eq 0 && "$legacy_bridge" -eq 0 ]]; then
    return 1
  fi
  err "检测到 macOS launchd 自启服务（KeepAlive），会与 start.sh 抢端口、抢进程。"
  err "常见症状：Runner 僵尸进程、/runs 空响应、飞书报 terminated。"
  err "launchd 默认 PATH 不含 nvm，还会导致 cursor-agent ENOENT。"
  [[ "$runner" -eq 1 ]] && err "  · 已加载: $LAUNCHD_RUNNER_LABEL"
  [[ "$bridge" -eq 1 ]] && err "  · 已加载: $LAUNCHD_BRIDGE_LABEL"
  [[ "$legacy_runner" -eq 1 ]] && err "  · 已加载旧版: $LEGACY_LAUNCHD_RUNNER_LABEL"
  [[ "$legacy_bridge" -eq 1 ]] && err "  · 已加载旧版: $LEGACY_LAUNCHD_BRIDGE_LABEL"
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
  local program="$5"
  shift 5
  local -a args=("$@")
  local path
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
    <string>${program}</string>
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
  local program
  if [[ -x "$LEGACY_MACOS_RUNNER_EXECUTABLE" && ! -x "$MACOS_RUNNER_EXECUTABLE" ]]; then
    warn "检测到旧版 Feishu Code Runner.app；Bundle ID 变更后 macOS 授权不会自动迁移。"
    warn "当前 Runner 将使用 node 启动。需要固定身份时，请执行 $0 install-macos-runner 并重新授权受保护目录。"
  fi
  program="$(if [[ -x "$MACOS_RUNNER_EXECUTABLE" ]]; then printf '%s' "$MACOS_RUNNER_EXECUTABLE"; else command -v node; fi)"
  launchd_bootout "$LAUNCHD_RUNNER_LABEL" "$LAUNCHD_RUNNER_PLIST"
  write_launchd_plist "$LAUNCHD_RUNNER_LABEL" "$LAUNCHD_RUNNER_PLIST" \
    "$RUNNER_LOG" "$DATA_DIR/runner.err.log" \
    "$program" \
    "$ROOT/packages/runner-host/dist/cli.js"
  launchd_bootstrap "$LAUNCHD_RUNNER_PLIST"
}

install_launchd_bridge() {
  local program
  program="$(command -v node)"
  launchd_bootout "$LAUNCHD_BRIDGE_LABEL" "$LAUNCHD_BRIDGE_PLIST"
  write_launchd_plist "$LAUNCHD_BRIDGE_LABEL" "$LAUNCHD_BRIDGE_PLIST" \
    "$BRIDGE_LOG" "$DATA_DIR/bridge.err.log" \
    "$program" \
    "$ROOT/apps/bridge/dist/cli.js" "start"
  launchd_bootstrap "$LAUNCHD_BRIDGE_PLIST"
}

cmd_install_launchd() {
  local component="${1:-all}"
  local install_runner=0 install_bridge=0
  check_launchd_component "$component"
  need_cmd node || exit 1
  ensure_built
  prepare_default_data_migration
  info "安装 launchd 自启（${component}）…"
  stop_watchdog
  remove_legacy_launchd "$component"
  cmd_stop 2>/dev/null || true
  [[ "$component" == "runner" || "$component" == "all" ]] && install_runner=1
  [[ "$component" == "bridge" || "$component" == "all" ]] && install_bridge=1
  [[ "$MIGRATION_REINSTALL_RUNNER" -eq 1 ]] && install_runner=1
  [[ "$MIGRATION_REINSTALL_BRIDGE" -eq 1 ]] && install_bridge=1
  [[ "$install_runner" -eq 1 ]] && install_launchd_runner
  [[ "$install_bridge" -eq 1 ]] && install_launchd_bridge
  info "launchd 已加载。查看: launchctl list | grep codebridge"
  case "$component" in
    runner) info "日志: $RUNNER_LOG" ;;
    bridge) info "日志: $BRIDGE_LOG" ;;
    all) info "日志: $RUNNER_LOG / $BRIDGE_LOG" ;;
  esac
  warn "之后请用 launchctl 或 $0 uninstall-launchd 管理，不要与 $0 start 混用。"
}

cmd_install_macos_runner() {
  [[ "$(uname -s)" == "Darwin" ]] || {
    err "固定 Bundle ID 的 Runner helper 仅支持 macOS"
    exit 1
  }
  need_cmd node || exit 1
  ensure_built
  prepare_default_data_migration
  stop_watchdog
  stop_pid_file "Runner" "$RUNNER_PID" || true
  stop_port_listener "$RUNNER_PORT"
  stop_runner_orphans
  rm -f "$RUNNER_PID"
  node "$ROOT/scripts/install-macos-runner-app.mjs" "${1:-${CODEBRIDGE_CODESIGN_IDENTITY:-${FCB_CODESIGN_IDENTITY:--}}}"
  remove_legacy_launchd runner
  install_launchd_runner
  if [[ "$MIGRATION_REINSTALL_BRIDGE" -eq 1 ]]; then
    install_launchd_bridge
    info "旧版 Bridge launchd 任务已一并迁移。"
  fi
  info "Runner helper 已接入 launchd。"
}

cmd_uninstall_launchd() {
  local component="${1:-all}"
  check_launchd_component "$component"
  info "卸载 launchd 自启（${component}）…"
  if [[ "$component" == "runner" || "$component" == "all" ]]; then
    launchd_bootout "$LAUNCHD_RUNNER_LABEL" "$LAUNCHD_RUNNER_PLIST"
    rm -f "$LAUNCHD_RUNNER_PLIST"
  fi
  if [[ "$component" == "bridge" || "$component" == "all" ]]; then
    launchd_bootout "$LAUNCHD_BRIDGE_LABEL" "$LAUNCHD_BRIDGE_PLIST"
    rm -f "$LAUNCHD_BRIDGE_PLIST"
  fi
  remove_legacy_launchd "$component"
  stop_port_listener "$RUNNER_PORT"
  stop_orphan_processes
  info "launchd 已卸载。可执行: $0 start"
}

cmd_status() {
  local runner_launchd=0 bridge_launchd=0 legacy_runner=0 legacy_bridge=0
  launchd_loaded "$LAUNCHD_RUNNER_LABEL" && runner_launchd=1
  launchd_loaded "$LAUNCHD_BRIDGE_LABEL" && bridge_launchd=1
  if [[ "$runner_launchd" -eq 0 ]] && launchd_loaded "$LEGACY_LAUNCHD_RUNNER_LABEL"; then
    runner_launchd=1
    legacy_runner=1
  fi
  if [[ "$bridge_launchd" -eq 0 ]] && launchd_loaded "$LEGACY_LAUNCHD_BRIDGE_LABEL"; then
    bridge_launchd=1
    legacy_bridge=1
  fi
  echo "配置: $CONFIG"
  echo "数据: $DATA_DIR"
  if [[ "$runner_launchd" -eq 1 ]]; then
    if [[ "$legacy_runner" -eq 1 ]]; then
      echo "Runner: 旧版 launchd 管理中 (KeepAlive, log $RUNNER_LOG)"
    else
      echo "Runner: launchd 管理中 (KeepAlive, log $RUNNER_LOG)"
    fi
  elif is_running "$RUNNER_PID"; then
    echo "Runner: 运行中 (pid $(cat "$RUNNER_PID"), log $RUNNER_LOG)"
  elif has_cmd lsof && lsof -ti:"$RUNNER_PORT" >/dev/null 2>&1; then
    echo "Runner: 端口 ${RUNNER_PORT} 被占用但无 pid 文件（僵尸进程，请 $0 stop)"
  else
    echo "Runner: 未运行"
  fi
  if [[ "$bridge_launchd" -eq 1 ]]; then
    if [[ "$legacy_bridge" -eq 1 ]]; then
      echo "Bridge: 旧版 launchd 管理中 (KeepAlive, log $BRIDGE_LOG)"
    else
      echo "Bridge: launchd 管理中 (KeepAlive, log $BRIDGE_LOG)"
    fi
  elif is_running "$BRIDGE_PID"; then
    echo "Bridge: 运行中 (pid $(cat "$BRIDGE_PID"), log $BRIDGE_LOG)"
  elif [[ -n "$(bridge_orphan_pids)" ]]; then
    echo "Bridge: 进程在运行但无 pid 文件（pid $(bridge_orphan_pids | tr '\n' ' ')，请 $0 stop)"
  else
    echo "Bridge: 未运行"
  fi
  if [[ "$runner_launchd" -eq 1 || "$bridge_launchd" -eq 1 ]]; then
    echo "守护:   launchd KeepAlive（服务退出自动拉起）"
  elif is_running "$WATCHDOG_PID"; then
    echo "守护:   运行中 (pid $(cat "$WATCHDOG_PID")，服务挂掉 10s 内自动拉起)"
  else
    echo "守护:   未运行（服务挂掉不会自动拉起，$0 start 会一并启动）"
  fi
  echo ""
  if [[ "$runner_launchd" -eq 1 || "$bridge_launchd" -eq 1 ]]; then
    info "launchd 自启: 已加载（电脑重启后自动启动）"
    if [[ "$runner_launchd" -eq 1 ]]; then
      [[ "$legacy_runner" -eq 1 ]] && echo "  · $LEGACY_LAUNCHD_RUNNER_LABEL" || echo "  · $LAUNCHD_RUNNER_LABEL"
    fi
    if [[ "$bridge_launchd" -eq 1 ]]; then
      [[ "$legacy_bridge" -eq 1 ]] && echo "  · $LEGACY_LAUNCHD_BRIDGE_LABEL" || echo "  · $LAUNCHD_BRIDGE_LABEL"
    fi
    if [[ "$legacy_runner" -eq 1 || "$legacy_bridge" -eq 1 ]]; then
      warn "检测到旧版 launchd 标识，请执行 restart 或 install-launchd 完成 CodeBridge 迁移。"
    fi
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
  stop_runner_orphans
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
  acquire_manual_lock
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
    stop_watchdog
    start_bridge_fg
  else
    start_bridge_bg
    start_watchdog_bg
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

cmd_restart() {
  acquire_restart_guard || return 0
  # launchd owns services installed with install-launchd; reload those jobs in
  # place so restart never creates a second Runner on the same port.
  local runner_launchd=0 bridge_launchd=0
  need_cmd node || exit 1
  need_cmd pnpm || exit 1
  ensure_built
  prepare_default_data_migration
  acquire_manual_lock
  check_config_ready
  runner_launchd=$((MIGRATION_NEW_RUNNER || MIGRATION_LEGACY_RUNNER))
  bridge_launchd=$((MIGRATION_NEW_BRIDGE || MIGRATION_LEGACY_BRIDGE))
  mark_restart_attempt
  if [[ "$runner_launchd" -eq 1 || "$bridge_launchd" -eq 1 ]]; then
    # Bridge 先恢复接收消息，Runner 最后重启；即使当前 Runner 正承载本次操作，
    # 也不会在 Bridge 尚未拉起时先把重启命令自身杀掉。
    [[ "$bridge_launchd" -eq 1 ]] && restart_launchd_component "$LAUNCHD_BRIDGE_LABEL" install_launchd_bridge
    [[ "$runner_launchd" -eq 1 ]] && restart_launchd_component "$LAUNCHD_RUNNER_LABEL" install_launchd_runner
    info "launchd 服务已迁移并重启（电脑重启后仍会自动启动）"
    return 0
  fi

  cmd_stop
  cmd_start "${1:-bg}"
}

cmd_docker() {
  need_cmd docker || exit 1
  need_cmd curl || exit 1
  mkdir -p "$DATA_DIR" "$PID_DIR"
  ensure_built
  check_config_ready
  run_preflight

  stop_watchdog
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
    stop) stop_watchdog; cmd_stop ;;
    restart) cmd_restart "${arg:-bg}" ;;
    __watchdog) cmd_watchdog ;;
    install-launchd) cmd_install_launchd "${arg:-all}" ;;
    install-macos-runner) cmd_install_macos_runner "$arg" ;;
    uninstall-launchd) cmd_uninstall_launchd "${arg:-all}" ;;
    status) cmd_status ;;
    doctor) cmd_doctor ;;
    help|-h|--help) cmd_help ;;
    *)
      err "未知命令: $cmd"
      echo "用法: $0 {setup|start|fg|docker|stop|restart|install-launchd [runner|bridge|all]|install-macos-runner [codesign-identity]|uninstall-launchd [runner|bridge|all]|status|doctor|help}"
      exit 1
      ;;
  esac
}

main "$@"
