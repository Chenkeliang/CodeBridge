# 快速开始

## 1. 引导安装（推荐）

```bash
./scripts/start.sh setup
```

交互式流程：检查 node/pnpm → 构建 → 生成配置 → 可选配置入口 → 检查 Agent → 可选后台启动。

## 2. 一键启动

```bash
./scripts/start.sh          # 检查依赖 → 停旧进程 → Runner+Bridge 后台启动
./scripts/start.sh fg       # Bridge 前台（调试用）
./scripts/start.sh docker   # 宿主机 Runner + Docker Bridge
./scripts/start.sh status   # 状态
./scripts/start.sh stop     # 停止
./scripts/start.sh doctor   # 诊断
```

Web 是独立的可选入口，不要求配置飞书或 Telegram。默认不启动：

```bash
node apps/bridge/dist/cli.js start --web  # 本次启动 Web，不写入配置
```

也可以在 `config.yaml` 中持久启用：

```yaml
web:
  enabled: true
```

启动后打开 `http://127.0.0.1:19790/workbench/`。Web 使用 `apps/web` 的 React/Vite 构建产物；Bridge 只负责 API、SSE 和静态文件托管。

## 手动启动

```bash
pnpm install && pnpm build
node apps/bridge/dist/cli.js init
```

### Runner（宿主机）

```bash
node packages/runner-host/dist/cli.js
# 或: pnpm runner
```

### Bridge

```bash
node apps/bridge/dist/cli.js start
# 或: pnpm start
```

## 飞书后台

见 [feishu-app-setup.md](./feishu-app-setup.md)。

## 3. 使用

在飞书私聊或群聊 @ 机器人发送任务，例如：

> 给当前项目 README 加一段安装说明

命令：`/help`、`/status`、`/backend codex`、`/clone https://github.com/...`
