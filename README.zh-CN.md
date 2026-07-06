# 飞书码桥 (feishu-code-bridge)

在飞书 @ 机器人，远程让本机 **Cursor / Claude Code / Codex** 改代码。

[English README](README.md)

## 特性

- 飞书 WebSocket 长连接，流式 Markdown 回复
- 多 CLI backend：`cursor` / `claude` / `codex`
- 会话路由：`/new`、`/resume`、`/stop`、`/backend`、`/cd`、`/ws`、`/model`、`/effort`、`/transport`
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
| `/transport acp\|cli\|default` | 切换 ACP / CLI 传输（会话级覆盖） |
| `/clone` `/pull` | 本机 git 操作 |

各 backend 的 session 目录：

| Backend | 存储位置 |
|---------|----------|
| **cursor** | `~/.cursor/projects/<项目>/agent-transcripts/<id>/<id>.jsonl` |
| **claude** | `~/.claude/projects/<encoded-cwd>/<id>.jsonl` |
| **codex** | `~/.codex/sessions/**/rollout-<id>.jsonl` |

绑定后，下一条普通消息会自动带 `--resume <id>` 发给对应 CLI。

## 并发与限制

码桥分两层：**Runner（宿主机）** 负责起 CLI 进程；**Bridge / Orchestrator（飞书侧）** 负责把消息路由到 Runner。两层限制不同，不要混为一谈。

| 场景 | 是否支持 | 限制来自哪一层 |
|------|----------|----------------|
| **不同飞书会话**同时跑任务（如私聊 + 群聊、两个群、两个话题） | ✅ | Runner 默认最多 **4** 个并发 CLI（`runnerHost.maxConcurrentRuns`） |
| **不同 backend 并行**（如 A 会话跑 cursor、B 会话跑 claude） | ✅ | Runner 层；各会话独立 `chatId` |
| **多个 CLI session 并存**（各自 `/resume` 绑定） | ✅ | 按 `chatId \| topicId \| backend \| cwd` 分别持久化到 `sessions.json` |
| **同一会话**（同一 `chatId`，同一话题）发第二条消息 | ⚠️ 会取消上一条 | **飞书侧**：新消息触发 `/stop` 同类逻辑，同时只保留 1 个任务 |
| **同一个群**里两人同时 @ 跑两个 Agent | ❌ | 群对应同一个 `chatId`，共享 binding（backend / cwd / model），且同时只能跑 1 个任务 |
| **同一个群**里 cursor 和 claude **同时**跑 | ❌ | 一个群同一时刻只绑定一个 backend；可 `/backend` **切换**，不能并行 |
| `/cd`、`/ws use` 换项目 | ✅ 两步操作 | 先 slash 切目录，**再** @ 发任务；`@` 本身不会猜 repo |

**举例**

- 私聊跑 cursor、群里跑 claude → 可以并行（两个 `chatId`）。
- 群里你先 @ 让它改 A 项目，同事再 @ 改 B 项目 → 不行：cwd 和任务都会互相覆盖/取消。
- 想并行改两个 repo → 开两个飞书会话（两个群或私聊 + 群），各自 `/cd` 或 `/ws use`。

本地可跑并发冒烟测试：`node scripts/test-concurrency-live.mjs`（向本机 Runner 并行发 cursor + claude）。

## ACP 模式（默认）

Runner 通过 [Agent Client Protocol](https://agentclientprotocol.com) 与子进程 Agent 通信（stdio JSON-RPC），与 Zed External Agents 同一套机制。

| 后端 | ACP 启动命令 |
|------|-------------|
| cursor | `cursor-agent acp` |
| claude | `npx -y @agentclientprotocol/claude-agent-acp@0.55.0` |
| codex | `npx -y @agentclientprotocol/codex-acp@1.1.0` |

`backends.<id>.transport`：`acp`（默认）或 `cli`（旧版 stream-json spawn 回退）。`runnerHost.acpPermissionPolicy` 控制无头权限（默认 `auto_allow`）。

续聊：Claude/Codex 用 `session/resume`；Cursor 用 `session/load`（不支持 resume）。

```bash
node scripts/acp-probe.mjs
RUNNER_TOKEN=... node scripts/test-acp-live.mjs --backend cursor
```

## 文档

- [飞书应用配置](docs/zh-CN/feishu-app-setup.md)
- [机器人自定义菜单](docs/zh-CN/feishu-bot-menu.md)
- [快速开始（手动 / Docker）](docs/zh-CN/quickstart.md)
- [Model / Effort](docs/zh-CN/model-effort.md)
- [并发与限制说明](README.zh-CN.md#并发与限制)（README）
- [V2EX 宣传稿](docs/zh-CN/v2ex-post.md)
- [Docker + 宿主机 Runner](docs/zh-CN/deploy/docker-host-runner.md)
- [完整配置示例](examples/config.full.yaml)

## 开发

```bash
pnpm install && pnpm build && pnpm test
```

## License

[MIT](LICENSE)
