<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brand/agent-logo-carbon.svg" />
    <img alt="AGENT · CodeBridge" src="apps/web/public/brand/agent-logo.svg" width="320" />
  </picture>
</p>

# CodeBridge（码桥）

一个自托管的多通道 [Agent Client Protocol（ACP）](https://agentclientprotocol.com) 网关。

通过飞书或 Telegram 远程驱动本机 **Cursor、Claude Code、Codex**，Runner 在自己的 Mac 上访问代码、Git 凭据、MCP 工具和 Agent session。Agent 仍会按其模型供应商和 MCP 配置发送请求；自托管不等于模型离线运行。

[English README](README.md)

## 版本与交付状态

截至 2026-10-15，npm 最新正式包为 **`@graychennpm/codebridge@0.1.0`**（2026-10-10 发布）。本 README 同时说明当前源码；主分支在该包之后已有更新，源码包版本号仍为 `0.1.0`，不能仅凭 `--version` 判断是否包含修复。

- **npm 已发布**：初始化向导、主配置密钥引用、Web 可选入口、会话自动轮换，以及每个 Session 默认最多100条排队消息。
- **源码已有，尚未发布到 npm**：飞书普通群消息独立会话、引用机器人回复续聊及 @ 当前提问者；群聊回复保留闲置会话、Codex 归档恢复、启动超时和回复投递等后续修复。
- **本地候选，尚未发布或部署**：工作台新增“渠道”“任务”两个入口，管理渠道访问、Agent定时任务、已有本地计划、推送目标和飞书告警规则，并提供任务详情与恢复、待处理和案件查看。实际支持范围与后续工作见[渠道自动化规划](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/channel-automation-roadmap.md)。

逐项状态及本地安全、管理候选见[交付状态](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/release-status.md)。正式支持的宿主机为 macOS；Linux 服务管理不在当前支持范围。

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

Bridge 处理通道和 API，Runner 启动本机 Agent。推荐两者运行在同一台 Mac；Docker / 远程 Bridge 的反向文件发送、通知及安全发布存在网络限制，见部署文档，不作为默认完整安装路径。

## npm 安装

需要 Node.js 22.19 或更高版本。运行 `npm install -g @graychennpm/codebridge@0.1.0` 安装，然后运行 `codebridge init` 完成初始化。在两个终端分别运行 `codebridge-runner` 和 `codebridge start`。安装包包含 Bridge、宿主机 Runner 和 Web 静态资源，无需构建源码、pnpm 或 curl。该路径以前台运行两个进程，不包含源码脚本的后台服务管理器或独立发布控制器。

也可以使用 `npx @graychennpm/codebridge@0.1.0 init`。源码仓库仍支持 `pnpm package:release` 生成本地 tarball，安装、隔离验收和维护步骤见 [npm 交付说明](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/npm-release.md)。

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

### 环境要求（源码安装）

- macOS
- Node.js ≥ 22.19、pnpm 10.34.1、Git、curl。WorkItem Event Store 使用 Node 内置的 `node:sqlite`。
- 本机至少安装一个 CLI：`cursor-agent`、`claude` 或 `codex`
- 使用聊天渠道时，准备已开启机器人的飞书企业自建应用或 Telegram Bot token；仅用本地 Web 时可不配置渠道。

### 从源码安装与启动

```bash
git clone https://github.com/Chenkeliang/CodeBridge.git
cd CodeBridge

# 安装依赖、构建、生成配置、检查本机 CLI
./scripts/start.sh setup

# 如果引导时没有启动服务，再手动启动
./scripts/start.sh start
```

引导配置保存在 `~/.codebridge/config.yaml`。初始化向导（也可单独运行 `codebridge init`）会当场校验飞书 / Telegram 凭据、生成 Runner token、选择项目目录和默认 Agent；优先将密钥存入系统钥匙串，在配置里写 `keychain:` 引用；npm 0.1.0 在钥匙串不可用时可确认明文回退；本地安全候选已禁止明文回退，安全存储失败即中止。已有设置和注释保留，只修改向导中确认的项目；YAML 排版可能调整。Telegram 必须有用户或聊天白名单，自动识别用户时需私聊机器人发送一次性验证码。

`codebridge init --defaults` 或无终端运行时，仅新建不存在的配置；先设置长随机 `RUNNER_TOKEN` 以保存 `env:RUNNER_TOKEN` 引用；npm 0.1.0 未设置时会明文保存随机 token，本地安全候选则要求环境变量，缺失即中止。此路径不访问钥匙串、不校验通道凭据。之后可运行 `codebridge secrets migrate` 迁入钥匙串。

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

飞书需要创建企业自建应用、开启机器人，并按[飞书应用配置指南](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/feishu-app-setup.md)订阅长连接事件。

Telegram 可与飞书同时启用，也可以只配置 Telegram：

```yaml
telegram:
  botToken: env:TELEGRAM_BOT_TOKEN
  allowedUsers: ["123456789"]          # 换成允许访问的用户 ID
  # allowedChats: ["-1001234567890"]   # 如配置，与用户限制共同生效
  pollingTimeoutSec: 25
```

主要配置项及可选片段见 [examples/config.full.yaml](https://github.com/Chenkeliang/CodeBridge/blob/main/examples/config.full.yaml)。示例 ID、路径与密钥引用需要替换，不能直接作为有效凭据使用。

### Web Workbench

Web 默认关闭。npm 安装用 `codebridge start --web`，源码安装用 `node apps/bridge/dist/cli.js start --web` 临时开启；或在配置里保存 `web.enabled: true` 后按原方式启动。默认地址为 `http://127.0.0.1:19790/workbench/`，修改 `bridge.apiPort` 后使用对应端口。它和飞书、Telegram 共用 WorkItem、Run 和事件流：像普通 Agent 工作台一样直接输入目标，输入框周边的 Agent、模式和工作空间用于配置当前会话，任务由选定 Agent 处理。页面连接本地 Bridge；Agent 和工具的网络请求仍按各自配置执行。Web 没有独立用户登录，不能直接开放到公网。

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

需要真实通知时，可以在任务里说“完成后 @ 我”，或者直接 @ 需要通知的参与者。Agent 会在确有必要时调用内部的 `fcb mention`；当前源码的飞书群聊任务回复会原生 @ 本轮提问者，无需另发通知；这项群聊行为尚未包含在 npm `0.1.0`。

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

安全边界详见 [SECURITY.md](https://github.com/Chenkeliang/CodeBridge/blob/main/SECURITY.md)。

## 并发与限制

- 不同聊天可并行运行，默认上限为 `runnerHost.maxConcurrentRuns: 4`。
- 同一 Session 同时只有一个活动任务；默认最多排队100条，可通过 `orchestration.session.maxQueuedTurns` 调整。`/stop` 取消当前任务并清空该会话队列。
- **当前源码，未发 npm**：飞书群聊每条新的普通任务建立独立会话；默认需 @ 机器人。直接引用机器人回复可不再 @，沿原会话续聊；普通回复留在群消息流，已有原生话题沿用话题，不强制创建新话题。不同成员引用同一回复会共享该会话上下文。
- **npm `0.1.0`** 使用旧群聊路由，未包含上述普通消息隔离和引用续聊修复。设置目录、Agent、模型或恢复会话时，请在目标会话内操作；无引用的斜杠命令使用群级上下文。
- 当前源码中，配置允许访问的飞书群成员可提问和续聊；修改配置类群命令需要 `access.admins` 或 `access.allowedUsers` 中的身份。告警话题的操作审批仍由该群 `approverOpenIds` 决定。管理员不等于所有流程的审批人。
- 通道会话默认空闲12小时后，下一条消息可自动开启新会话。上下文用量不再触发换新会话，历史压缩由后端原生处理；运行中或有排队时不轮换。当前源码的飞书群回复跳过闲置轮换；告警会话单独保留。可在 `orchestration.session.autoRotate` 调整闲置规则，旧字段 `maxContextRatio` 不再参与判断。
- Agent 只能通知本轮发送者和本轮任务中明确 @ 的参与者；不会扫描组织通讯录、@ 所有人，也不能自行构造任意用户 ID。
- `/transport` 仅保留兼容回复，实际只支持 ACP。

## 后端与适配器

Pi 通过 `pi-sdk` 接入，OpenCode 通过 `opencode acp` 接入；须单独安装、配置并完成相应认证。下表是内建 ACP 启动默认值；显式配置 `acpCommand` / `acpArgs` 会覆盖它们。联网开关不是原版 Codex 适配器的默认能力，详见 [Codex 联网说明](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/codex-acp-network.md)。

| Backend | ACP 启动命令 |
|---------|--------------|
| Cursor | `cursor-agent acp` |
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp@0.81.1` |
| Codex | `npx -y @agentclientprotocol/codex-acp@1.13.1` |

续聊语义取决于 adapter：Claude/Codex 使用 `session/resume`，Cursor 使用 `session/load`。

```bash
node scripts/acp-probe.mjs
node scripts/acp-probe.mjs --backend codex
RUNNER_TOKEN=... node scripts/test-acp-live.mjs --backend cursor
```

## 文档

| 主题 | 文档 |
|------|------|
| 飞书应用与权限 | [docs/zh-CN/feishu-app-setup.md](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/feishu-app-setup.md) |
| 飞书机器人自定义菜单 | [docs/zh-CN/feishu-bot-menu.md](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/feishu-bot-menu.md) |
| 手动 / Docker 快速开始 | [docs/zh-CN/quickstart.md](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/quickstart.md) |
| Model、Effort、Permission | [docs/zh-CN/model-effort.md](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/model-effort.md) |
| Docker Bridge + 宿主机 Runner | [docs/zh-CN/deploy/docker-host-runner.md](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/deploy/docker-host-runner.md) |
| 多项目 Agent 工作台设计基线 | [docs/orchestration/README.md](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/orchestration/README.md) |
| 完整配置 | [examples/config.full.yaml](https://github.com/Chenkeliang/CodeBridge/blob/main/examples/config.full.yaml) |
| 安全策略 | [SECURITY.md](https://github.com/Chenkeliang/CodeBridge/blob/main/SECURITY.md) |

## 开发

```bash
pnpm install
pnpm run lint
pnpm run build
pnpm test
```

这是一个 pnpm monorepo，包含 `core`、`backends`、`work-items`、`policy`、`run-executor`、`project-catalog`、`runner-host`、`runner-client`、`router`、`channel-feishu`、`channel-telegram` 和 `apps/bridge`。

## License

[MIT](LICENSE)
