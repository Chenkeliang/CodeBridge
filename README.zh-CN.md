# 飞书码桥 (feishu-code-bridge)

在飞书 @ 机器人，远程让本机 **Cursor / Claude Code / Codex** 改代码。

[English README](README.md)

## 特性

- 飞书 WebSocket 长连接，流式 Markdown 回复
- 多 CLI backend：`cursor` / `claude` / `codex`
- 会话路由：`/new`、`/resume`、`/stop`、`/backend`、`/cd`、`/ws`、`/model`、`/effort`
- **恢复本机 CLI session**：`/resume` 列出终端已有 session，绑定后继续 `--resume`
- **飞书常置命令**：开放平台配置机器人「自定义菜单」，详见 [feishu-bot-menu.md](docs/zh-CN/feishu-bot-menu.md)
- **引导式启动**：`./scripts/start.sh setup` 检查依赖、CLI、生成配置
- Git 快捷：`/clone`、`/pull`（复用本机 git/SSH 凭据）
- 群聊默认需 @；支持 `policy.scenarios` 信任群免 @
- Bridge 可 Docker；**Runner 必须在宿主机**（CLI 所在机器）

## 架构

```
飞书 → Bridge (Channel SDK) → HTTP/SSE → Runner (宿主机) → cursor-agent / claude / codex
```

## 快速开始

### 环境

- Node.js ≥ 20、pnpm、curl
- [飞书企业自建应用](docs/zh-CN/feishu-app-setup.md)（开启机器人）
- 本机至少装一个 CLI：`cursor-agent`、`claude` 或 `codex`

### 安装与启动

```bash
git clone https://github.com/Chenkeliang/feishu-code-bridge.git
cd feishu-code-bridge

# 交互式引导：依赖 → 构建 → 配置 → CLI 检查
./scripts/start.sh setup

# 编辑 ~/.feishu-code-bridge/config.yaml，填入 feishu.appId / appSecret

# 后台启动（自动停旧进程）
./scripts/start.sh
```

常用：

```bash
./scripts/start.sh status   # 进程与 CLI 状态
./scripts/start.sh fg       # Bridge 前台（调试）
./scripts/start.sh stop     # 停止
./scripts/start.sh doctor   # 诊断
```

## 飞书命令

| 命令 | 说明 |
|------|------|
| `/help` `/menu` | 全部命令 |
| `/status` | 当前 backend / cwd / model |
| `/stop` | 停止正在执行的 Agent 任务 |
| `/new` | 新建 CLI session |
| `/resume` | 列出本机 session（按 cwd 含子目录） |
| `/resume 2` | 绑定第 2 条 |
| `/resume last` | 绑定最近一条 |
| `/resume all` | 跨目录列出全部 |
| `/backend cursor\|claude\|codex` | 切换 Agent |
| `/cd <path>` | 切换项目目录 |
| `/ws list\|save\|use` | 命名工作区 |
| `/model` `/effort` `/permission` | 模型 / Claude effort / 权限模式 |
| `/clone` `/pull` | 本机 git 操作 |

各 backend 的 session 目录：

| Backend | 存储位置 |
|---------|----------|
| **cursor** | `~/.cursor/projects/<项目>/agent-transcripts/<id>/<id>.jsonl` |
| **claude** | `~/.claude/projects/<encoded-cwd>/<id>.jsonl` |
| **codex** | `~/.codex/sessions/**/rollout-<id>.jsonl` |

绑定后，下一条普通消息会自动带 `--resume <id>` 发给对应 CLI。

## 文档

- [飞书应用配置](docs/zh-CN/feishu-app-setup.md)
- [机器人自定义菜单](docs/zh-CN/feishu-bot-menu.md)
- [快速开始（手动 / Docker）](docs/zh-CN/quickstart.md)
- [Model / Effort](docs/zh-CN/model-effort.md)
- [Docker + 宿主机 Runner](docs/zh-CN/deploy/docker-host-runner.md)
- [完整配置示例](examples/config.full.yaml)

## 开发

```bash
pnpm install && pnpm build && pnpm test
```

## License

[MIT](LICENSE)
