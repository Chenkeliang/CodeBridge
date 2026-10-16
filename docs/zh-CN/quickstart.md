# 快速开始

正式支持 macOS、Node.js ≥22.19。npm `0.1.0` 与后续源码能力有区别，先看[交付状态](../release-status.md)。本地运行仍会按 Agent 的配置访问模型供应商和工具，不代表离线推理。

## npm 安装：两个前台进程

不需要源码、pnpm 或 curl：

```bash
npm install -g @graychennpm/codebridge@0.1.0
codebridge init
```

向导选择通道、目录与 Agent。Agent CLI 的安装与账号登录需单独完成；首次保存飞书长连接配置时，需要 Bridge 已连接。两个终端分别运行：

```bash
codebridge-runner
```

```bash
codebridge start
```

运行 `codebridge doctor` 检查。npm 包不包含 `scripts/start.sh` 或独立发布控制器；需要下述后台管理方式，请使用源码安装。详细发行步骤见 [npm 说明](npm-release.md)。

## 源码安装：后台运行或 launchd

另需 Git、pnpm 10.34.1 和 curl。在源码根目录运行：

```bash
pnpm install --frozen-lockfile
./scripts/start.sh setup
./scripts/start.sh status
./scripts/start.sh doctor
```

`setup` 检查依赖、构建、调用初始化向导，并提供后台启动选项；没有选择启动时再运行 `./scripts/start.sh start`。初始化不会覆盖已有配置，修改的具体项目以向导确认项为准。

仅选择一种进程管理方式：

| 方式 | 操作 |
| --- | --- |
| 脚本后台与 watchdog | `./scripts/start.sh start`、`status`、`stop`、`restart` |
| macOS 开机启动与 KeepAlive | `./scripts/start.sh install-launchd all`；之后用 `status`、`restart`，退出该方式用 `uninstall-launchd all` |
| 手工前台调试 | 两个终端分别运行 `node packages/runner-host/dist/cli.js` 和 `node apps/bridge/dist/cli.js start` |

不要在 launchd 已管理同一服务时再启动第二份手工进程。更新源码后应重新安装依赖并构建；发布控制器管理的安装改走[安全发布](safe-deployment.md)，不要覆盖冻结的运行目录。

## 密钥与无终端初始化

配置默认位于 `~/.codebridge/config.yaml`，支持 `keychain:` 和 `env:`。npm 0.1.0 的交互向导可询问明文回退，无终端初始化缺少 `RUNNER_TOKEN` 时会保存明文随机 token。本地安全候选已禁止新明文写入：交互流程须使用钥匙串，无终端流程须预先设置 `RUNNER_TOKEN`；安全存储不可用即中止。两者均不覆盖已有文件。

建议事先设置长随机 `RUNNER_TOKEN`，并保证启动 Bridge、Runner 的环境均可读取它。`env:` 不会把变量自动传给 launchd；后台环境或钥匙串读取须单独验证。`codebridge secrets status` 查看主配置密钥来源，`codebridge secrets migrate` 迁移主配置后按提示重启相关服务。控制器与发布者凭据尚不由当前命令统一迁移，见[安全策略](../../SECURITY.md)。

## Web 可独立开启

Web 不要求配置飞书或 Telegram，默认关闭。npm 用 `codebridge start --web`；源码用：

```bash
node apps/bridge/dist/cli.js start --web
```

要持久启用，在配置中增加：

```yaml
web:
  enabled: true
```

默认打开 `http://127.0.0.1:19790/workbench/`，端口以 `bridge.apiPort` 为准。Web 没有独立登录，请保持本机访问。不要为查看 Web 临时扩大 Runner 的监听范围。

## 通道与第一次任务

本地候选还支持“任务”中的Agent定时任务和“待处理”总览；建议先保存为暂停并运行一次。参数、通知、恢复和告警案件入口见[使用说明](agent-tasks.md)。尚未发布的功能不适用于现有npm包。

当前本地候选可从 Web 的“渠道”填写、验证并安全保存飞书或 Telegram 凭据，再单独应用连接；也可继续使用初始化向导。Telegram 首次应用前须设置用户或聊天允许名单。两者可同时启用。完整流程与环境变量限制见[渠道管理](channel-automation-roadmap.md)，飞书平台权限见[应用配置](feishu-app-setup.md)。

先在单聊发送 `/status`，核对目录和 Agent，再发一个不需要外部写操作的任务，例如“解释这个项目的 README”。使用前核对 Agent 权限策略，配置说明见[示例](../../examples/config.full.yaml)。

当前源码的飞书群聊可 @ 机器人发新任务、引用机器人回复续聊，并在回复中 @ 本轮提问者；npm `0.1.0` 尚未包含这组修复。不要用源码说明推断已安装 npm 包的群聊行为。

## Docker / 远程边界

当前完整安装路径是同一台 Mac 的 Bridge + Runner。容器与远程部署的反向出站链路存在限制，见 [Docker 说明](deploy/docker-host-runner.md)，不要据此承诺全部文件发送、通知与安全发布可用。
