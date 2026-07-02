# 快速开始

## 1. 引导安装（推荐）

```bash
./scripts/start.sh setup
```

交互式流程：检查 node/pnpm → 构建 → 生成配置 → 可选填写飞书凭据 → 检查 Cursor/Claude/Codex CLI → 可选后台启动。

## 2. 一键启动

```bash
./scripts/start.sh          # 检查依赖 → 停旧进程 → Runner+Bridge 后台启动
./scripts/start.sh fg       # Bridge 前台（调试用）
./scripts/start.sh docker   # 宿主机 Runner + Docker Bridge
./scripts/start.sh status   # 状态
./scripts/start.sh stop     # 停止
./scripts/start.sh doctor   # 诊断
```

## 手动启动

```bash
pnpm install && pnpm build
feishu-code-bridge init
```

### Runner（宿主机）

```bash
feishu-code-runner
# 或: pnpm runner
```

### Bridge

```bash
feishu-code-bridge start
```

## 飞书后台

见 [feishu-app-setup.md](./feishu-app-setup.md)。

## 3. 使用

在飞书私聊或群聊 @ 机器人发送任务，例如：

> 给当前项目 README 加一段安装说明

命令：`/help`、`/status`、`/backend codex`、`/clone https://github.com/...`
