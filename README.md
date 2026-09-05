<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brand/agnet-logo-carbon.svg" />
    <img alt="AGNET · CodeBridge" src="apps/web/public/brand/agnet-logo.svg" width="320" />
  </picture>
</p>

# CodeBridge

Self-hosted, multi-channel [Agent Client Protocol (ACP)](https://agentclientprotocol.com) gateway for coding agents.

Control local **Cursor**, **Claude Code**, **Codex**, and optionally **Pi** from Feishu or Telegram while your source code, Git credentials, MCP tools, and agent sessions stay on your own Mac/Linux host.

[简体中文](README.zh-CN.md)

## What it does

```text
Feishu WebSocket ─┐
                  ├─ Bridge ── authenticated HTTP/SSE + token ── Runner ── ACP agents ── local files
Telegram polling ─┘
```

| Component | Responsibility |
|-----------|----------------|
| **Bridge** | Channel connections, access policy, slash commands, session routing, and reply presentation |
| **Runner** | Host-side ACP sessions, agent processes, file/Git access, and permission handling |
| **Agent adapters** | Cursor, Claude Code, and Codex ACP adapters plus the native Pi Node SDK adapter |

The Bridge and Runner are intentionally separate: the Bridge can be remote or containerized, but the Runner stays next to the CLIs and files it needs to access.

## Highlights

- Feishu long connection with streaming cards and optional custom menu
- Telegram Bot API long polling, including a native command menu
- Scoped native mentions on Feishu and Telegram for the requester or participants explicitly mentioned in a task
- One ACP path for `cursor`, `claude`, and `codex`; the legacy direct-CLI transport is gone
- Resume local sessions with `/resume`, `/resume last`, or `/resume all`
- Live adapter capabilities through `/model`, `/effort`, `/permission`, and `/config`
- Named workspaces, additional directories, `/clone`, `/pull`, and file delivery
- macOS TCC-aware `/root add` flow with an immediate “waiting for system permission” status
- launchd KeepAlive on macOS, or the built-in watchdog for manual background mode

## Quick start

### Requirements

- macOS or Linux
- Node.js ≥ 22.19, pnpm, and curl. The WorkItem Event Store uses Node's built-in `node:sqlite`; the optional Pi SDK adapter follows Pi's Node runtime requirement.
- At least one local agent CLI: `cursor-agent`, `claude`, or `codex`
- A Feishu custom app with a bot, or a Telegram bot token

### Install and start

```bash
git clone https://github.com/Chenkeliang/CodeBridge.git
cd CodeBridge

# Installs dependencies, builds, creates config, and checks local CLIs.
./scripts/start.sh setup

# If setup did not start the service, start Runner + Bridge in the background.
./scripts/start.sh start
```

The setup wizard stores configuration at `~/.codebridge/config.yaml`. It can configure Feishu credentials and generate a random Runner token for you.

Verify the installation:

```bash
./scripts/start.sh status
./scripts/start.sh doctor
```

On macOS, use launchd for boot-time startup and KeepAlive. Choose one process manager; do not mix launchd with manual `start.sh` mode:

```bash
./scripts/start.sh install-launchd all
./scripts/start.sh restart
```

When upgrading from the former `feishu-code-bridge` name, `restart` or `install-launchd` migrates the default data directory from `~/.feishu-code-bridge` to `~/.codebridge` and replaces the old launchd jobs. Existing files in `~/.codebridge` are never overwritten, and an explicitly configured `DATA_DIR` is never moved. If you used the former `Feishu Code Runner.app`, run `./scripts/start.sh install-macos-runner` and approve protected folders again: macOS does not transfer TCC grants to the new Bundle ID.

Useful lifecycle commands:

```bash
./scripts/start.sh status
./scripts/start.sh restart
./scripts/start.sh stop
./scripts/start.sh fg       # foreground Bridge debugging
```

### Configure a channel

For Feishu, create an enterprise custom app, enable the bot, and subscribe to the long-connection events described in [Feishu app setup](docs/zh-CN/feishu-app-setup.md).

Telegram is optional. It can run alongside Feishu or in Telegram-only mode:

```yaml
telegram:
  botToken: "123456:replace-with-bot-token"
  allowedUsers: ["123456789"]          # optional allowlist
  allowedChats: ["-1001234567890"]     # optional allowlist
  pollingTimeoutSec: 25
```

See [examples/config.full.yaml](examples/config.full.yaml) for the complete configuration shape.

## Phone-first commands

`/menu` and `/help` intentionally return a short list for small screens. Use `/help full` for the grouped reference.

| Command | Use |
|---------|-----|
| `/status` | Check backend, project directory, model, permission, and active-task state |
| `/resume last` | Continue the most recent local session in the current directory |
| `/new` | Start a clean ACP session |
| `/stop` | Stop the current task and clear queued Feishu prompts |
| `/backend claude` | Switch the current chat to Cursor, Claude, or Codex |
| `/model` | List live models; `/model <name>` switches one |
| `/permission` | List live modes; `/permission <mode>` switches one |
| `/ws list` | Show saved workspaces |

Other useful commands:

```text
/resume [N|last|all]
/effort [list|level|default]
/config [id value|default]
/root add|remove|rm /absolute/path
/send /absolute/path/to/file
/clone <git-url> [directory-name]
/pull
/approve  /deny  /steer <instruction>
```

The exact model, effort, permission, and boolean config values come from the connected ACP adapter, so `/model list`, `/effort list`, `/permission list`, and `/config` are the source of truth.

To request a real channel notification, say “mention me when it finishes” or explicitly mention a participant in the task. The Agent uses `fcb mention` internally; ordinary replies do not create extra notifications.

## Sessions, directories, and permissions

- Session bindings are isolated by channel chat, topic, backend, and working directory; session metadata is persisted under the configured data directory.
- `/cd` changes the current project. `/ws save|use` gives frequently used directories short names.
- `/root add /absolute/path` adds an ACP `additionalDirectories` entry. On macOS, Runner touches the directory first so the normal TCC prompt can appear. The chat reports that it is waiting for system authorization, but the command does not silently grant macOS access.
- `runnerHost.acpPermissionPolicy` controls agent permission requests:

  | Policy | Behavior |
  |--------|----------|
  | `auto_allow` | Runner approves ACP permission requests automatically (default for trusted local use) |
  | `prompt_feishu` | Pause and wait for `/approve` or `/deny` in the chat; timeout rejects |
  | `prompt_deny` | Reject permission requests automatically |

- On macOS, `./scripts/start.sh install-macos-runner` creates the optional fixed-identity helper. Ad-hoc signing is free and local; TCC still requires the user’s approval.

Read [SECURITY.md](SECURITY.md) before exposing anything beyond localhost.

## Concurrency and known boundaries

- Different chats can run in parallel up to `runnerHost.maxConcurrentRuns` (default `4`).
- A Feishu `chatId + topic` has one active task. Later messages queue up to five; `/stop` cancels the task and clears that queue.
- A group shares one backend, directory, model, and session binding. Use separate chats for independent projects or agents.
- Agent notifications are limited to the current sender and participants explicitly mentioned in the current task. CodeBridge does not search the organization directory, mention everyone, or accept arbitrary user IDs from the Agent.
- `/transport` remains only as a compatibility response; ACP is the only transport.

## ACP backends

| Backend | ACP command |
|---------|-------------|
| Cursor | `cursor-agent acp` |
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp@0.64.2` |
| Codex | `npx -y @agentclientprotocol/codex-acp@1.10.0` |

Resume semantics depend on the adapter: Claude/Codex use `session/resume`; Cursor uses `session/load`.

Probe adapters without starting the Bridge:

```bash
node scripts/acp-probe.mjs
node scripts/acp-probe.mjs --backend codex
RUNNER_TOKEN=... node scripts/test-acp-live.mjs --backend cursor
```

## Documentation

| Topic | Link |
|-------|------|
| Feishu app and permissions | [docs/zh-CN/feishu-app-setup.md](docs/zh-CN/feishu-app-setup.md) |
| Feishu custom menu | [docs/zh-CN/feishu-bot-menu.md](docs/zh-CN/feishu-bot-menu.md) |
| Manual / Docker quick start | [docs/zh-CN/quickstart.md](docs/zh-CN/quickstart.md) |
| Model, effort, and permission | [docs/zh-CN/model-effort.md](docs/zh-CN/model-effort.md) |
| Docker Bridge + host Runner | [docs/zh-CN/deploy/docker-host-runner.md](docs/zh-CN/deploy/docker-host-runner.md) |
| Multi-project Agent workbench baseline | [docs/orchestration/README.md](docs/orchestration/README.md) |
| Full config example | [examples/config.full.yaml](examples/config.full.yaml) |
| Security policy | [SECURITY.md](SECURITY.md) |

## Development

```bash
pnpm install
pnpm run lint
pnpm run build
pnpm test
```

The monorepo contains `core`, `backends`, `work-items`, `workflow-engine`, `policy`, `run-executor`, `project-catalog`, `runner-host`, `runner-client`, `router`, `channel-feishu`, `channel-telegram`, and `apps/bridge`.

## License

[MIT](LICENSE)
