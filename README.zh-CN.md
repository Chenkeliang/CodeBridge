# CodeBridge（码桥）

一个自托管的多通道 [Agent Client Protocol（ACP）](https://agentclientprotocol.com) 网关。

通过飞书或 Telegram 远程驱动本机 **Cursor、Claude Code、Codex**，代码、Git 凭据、MCP 工具和 Agent session 都留在自己的 Mac/Linux 上。

[English README](README.md)

## 它解决什么问题

你不需要把项目复制到云端，也不需要重新配置本机的 Git、SSH、MCP 和开发环境；在手机聊天里发任务，码桥让本机 Agent 执行并把结果带回聊天。

```text
飞书 WebSocket ─┐
                ├─ Bridge ── 带 token 的 HTTP/SSE ── Runner ── ACP Agent ── 本地文件
Telegram 长轮询 ─┘
```

| 组件 | 职责 |
|------|------|
| **Bridge** | 连接聊天通道、访问策略、斜杠命令、session 路由和消息展示 |
| **Runner** | 在宿主机启动 ACP session/Agent，访问本地文件和 Git，并处理权限请求 |
| **ACP adapter** | Cursor、Claude Code、Codex 的协议适配 |

Bridge 与 Runner 分开设计：Bridge 可以放在 Docker 或远程机器，Runner 必须靠近 CLI、代码和凭据所在的宿主机。

## 主要能力

- 飞书长连接流式卡片，可配置机器人自定义菜单
- Telegram Bot API 长轮询，并自动注册原生命令菜单
- 飞书和 Telegram 原生 @ 通知，可提醒当前发送者或任务中明确 @ 的参与者
- 统一 ACP 通道：`cursor`、`claude`、`codex`；旧版直接 CLI transport 已移除
- `/resume`、`/resume last`、`/resume all` 恢复本机会话
- `/model`、`/effort`、`/permission`、`/config` 实时读取当前 adapter 能力
- 命名工作区、ACP 附加目录、`/clone`、`/pull`、文件发送
- `/root add` 感知 macOS TCC 授权，并即时提示“正在等待系统权限”
- macOS launchd KeepAlive，或手动后台模式 watchdog

## 快速开始

### 环境要求

- macOS 或 Linux
- Node.js ≥ 22.5、pnpm、curl。WorkItem Event Store 使用 Node 内置的 `node:sqlite`。
- 本机至少安装一个 CLI：`cursor-agent`、`claude` 或 `codex`
- 一个已开启机器人的飞书企业自建应用，或一个 Telegram Bot token

### 安装与启动

```bash
git clone https://github.com/Chenkeliang/CodeBridge.git
cd CodeBridge

# 安装依赖、构建、生成配置、检查本机 CLI
./scripts/start.sh setup

# 如果引导时没有启动服务，再手动启动
./scripts/start.sh start
```

引导配置保存在 `~/.codebridge/config.yaml`，可交互填写飞书凭据，并自动生成 Runner token。

检查状态：

```bash
./scripts/start.sh status
./scripts/start.sh doctor
```

macOS 开机自启推荐使用 launchd。手动后台模式和 launchd 二选一，不要混用：

```bash
./scripts/start.sh install-launchd all
./scripts/start.sh restart
```

从旧名称 `feishu-code-bridge` 升级时，执行 `restart` 或 `install-launchd` 会把默认数据目录从 `~/.feishu-code-bridge` 迁移到 `~/.codebridge`，并替换旧 launchd 任务；已存在于 `~/.codebridge` 的文件不会被覆盖，显式设置的 `DATA_DIR` 也不会被移动。如果以前安装过 `Feishu Code Runner.app`，请执行 `./scripts/start.sh install-macos-runner` 并重新授权受保护目录；macOS 不会把 TCC 权限迁移到新的 Bundle ID。

常用生命周期命令：

```bash
./scripts/start.sh status
./scripts/start.sh restart
./scripts/start.sh stop
./scripts/start.sh fg       # 前台调试 Bridge
```

### 配置通道

飞书需要创建企业自建应用、开启机器人，并按[飞书应用配置指南](docs/zh-CN/feishu-app-setup.md)订阅长连接事件。

Telegram 可与飞书同时启用，也可以只配置 Telegram：

```yaml
telegram:
  botToken: "123456:replace-with-bot-token"
  allowedUsers: ["123456789"]          # 可选白名单
  allowedChats: ["-1001234567890"]     # 可选白名单
  pollingTimeoutSec: 25
```

完整配置见 [examples/config.full.yaml](examples/config.full.yaml)。

## 手机优先的命令

`/menu` 和 `/help` 默认只返回短菜单，适合手机；发送 `/help full` 查看分组完整帮助。

| 命令 | 用途 |
|------|------|
| `/status` | 查看 backend、目录、模型、权限和任务状态 |
| `/resume last` | 继续当前目录最近一次本机会话 |
| `/new` | 新建 ACP session |
| `/stop` | 停止当前任务，并清空飞书排队消息 |
| `/backend claude` | 在 Cursor、Claude、Codex 之间切换 |
| `/model` | 拉取实时模型；`/model <名称>` 切换 |
| `/permission` | 拉取实时权限模式；`/permission <模式>` 切换 |
| `/ws list` | 查看已保存工作区 |

其他常用命令：

```text
/resume [N|last|all]
/effort [list|级别|default]
/config [id value|default]
/root add|remove|rm /absolute/path
/send /absolute/path/to/file
/clone <git-url> [目录名]
/pull
/approve  /deny  /steer <指令>
```

模型、effort、permission 和 boolean config 的准确选项以当前 ACP adapter 为准；可用 `/model list`、`/effort list`、`/permission list`、`/config` 查看。

需要真实通知时，可以在任务里说“完成后 @ 我”，或者直接 @ 需要通知的参与者。Agent 会在确有必要时调用内部的 `fcb mention`；普通回复不会额外提醒。

## Session、目录与权限

- session 绑定按聊天、话题、backend 和工作目录隔离，元数据持久化在数据目录。
- `/cd` 切换项目；`/ws save|use` 给常用目录起短名称。
- `/root add /absolute/path` 添加 ACP `additionalDirectories`。macOS 上 Runner 会先实际访问目录，触发正常 TCC 弹窗；聊天会即时提示正在等待系统授权，但不会静默获得系统权限。
- `runnerHost.acpPermissionPolicy`：

  | 策略 | 行为 |
  |------|------|
  | `auto_allow` | 自动批准 ACP 权限请求（默认，适合可信本机） |
  | `prompt_feishu` | 在聊天等待 `/approve` 或 `/deny`，超时自动拒绝 |
  | `prompt_deny` | 自动拒绝权限请求 |

- macOS 可执行 `./scripts/start.sh install-macos-runner` 安装固定身份 helper。默认 ad-hoc 签名免费且只适合本机；TCC 仍需用户确认。

安全边界详见 [SECURITY.md](SECURITY.md)。

## 并发与限制

- 不同聊天可并行运行，默认上限为 `runnerHost.maxConcurrentRuns: 4`。
- 飞书同一 `chatId + topic` 同时只有一个任务；后续消息最多排队 5 条，`/stop` 会取消任务并清空队列。
- 同一个群共享 backend、目录、模型和 session 绑定；要并行处理不同项目，请使用不同聊天。
- Agent 只能通知本轮发送者和本轮任务中明确 @ 的参与者；不会扫描组织通讯录、@ 所有人，也不能自行构造任意用户 ID。
- `/transport` 仅保留兼容回复，实际只支持 ACP。

## ACP 后端

| Backend | ACP 启动命令 |
|---------|--------------|
| Cursor | `cursor-agent acp` |
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp@0.64.2` |
| Codex | `npx -y @agentclientprotocol/codex-acp@1.1.9` |

续聊语义取决于 adapter：Claude/Codex 使用 `session/resume`，Cursor 使用 `session/load`。

```bash
node scripts/acp-probe.mjs
node scripts/acp-probe.mjs --backend codex
RUNNER_TOKEN=... node scripts/test-acp-live.mjs --backend cursor
```

## 文档

| 主题 | 文档 |
|------|------|
| 飞书应用与权限 | [docs/zh-CN/feishu-app-setup.md](docs/zh-CN/feishu-app-setup.md) |
| 飞书机器人自定义菜单 | [docs/zh-CN/feishu-bot-menu.md](docs/zh-CN/feishu-bot-menu.md) |
| 手动 / Docker 快速开始 | [docs/zh-CN/quickstart.md](docs/zh-CN/quickstart.md) |
| Model、Effort、Permission | [docs/zh-CN/model-effort.md](docs/zh-CN/model-effort.md) |
| Docker Bridge + 宿主机 Runner | [docs/zh-CN/deploy/docker-host-runner.md](docs/zh-CN/deploy/docker-host-runner.md) |
| 多项目 Agent 工作台设计基线 | [docs/orchestration/README.md](docs/orchestration/README.md) |
| 完整配置 | [examples/config.full.yaml](examples/config.full.yaml) |
| 安全策略 | [SECURITY.md](SECURITY.md) |

## 开发

```bash
pnpm install
pnpm run lint
pnpm run build
pnpm test
```

这是一个 pnpm monorepo，包含 `core`、`backends`、`runner-host`、`runner-client`、`router`、`channel-feishu`、`channel-telegram` 和 `apps/bridge`。

## License

[MIT](LICENSE)
