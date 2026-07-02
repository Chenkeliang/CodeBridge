# feishu-code-bridge

**飞书码桥** — Control local **Cursor**, **Claude Code**, and **Codex** from Feishu (Lark).

Message your Feishu bot to run coding agents on your Mac/Linux host: stream replies, resume terminal sessions, switch backends, and change project directories — without leaving chat.

[中文文档](README.zh-CN.md)

## Features

- **Feishu WebSocket** long connection with streaming markdown replies
- **Multi-backend**: `cursor` / `claude` / `codex` (local CLIs on the host)
- **Session routing**: `/new`, `/resume`, `/backend`, `/cd`, `/ws`, `/model`, `/effort`, `/permission`, `/stop`
- **Resume local CLI sessions**: pick an existing Cursor / Claude / Codex session from disk and continue with `--resume`
- **Pinned bot menu**: configure Feishu custom menu items for one-tap commands ([guide](docs/zh-CN/feishu-bot-menu.md))
- **Git shortcuts**: `/clone`, `/pull` (uses host git + SSH credentials)
- **Group chat policy**: @mention required by default; trusted groups can opt out
- **Split deploy**: Bridge in Docker optional; **Runner must run on the host** (where CLIs live)

## Architecture

```
Feishu  →  Bridge (Channel SDK)  →  HTTP/SSE  →  Runner (host)  →  cursor-agent / claude / codex
```

| Component | Role |
|-----------|------|
| **Bridge** | Feishu bot, slash commands, streaming UI |
| **Runner** | Spawns CLI processes, parses JSON streams, exposes `/runs` API |

## Quick start

### Prerequisites

- Node.js ≥ 20, pnpm, curl
- A [Feishu custom app](docs/zh-CN/feishu-app-setup.md) with bot enabled
- At least one local CLI: `cursor-agent`, `claude`, or `codex`

### Install & run

```bash
git clone https://github.com/Chenkeliang/feishu-code-bridge.git
cd feishu-code-bridge

# Interactive setup: deps, build, config, CLI checks
./scripts/start.sh setup

# Edit ~/.feishu-code-bridge/config.yaml — set feishu.appId / feishu.appSecret

# Start Runner + Bridge in background (auto-stops stale processes)
./scripts/start.sh
```

Other commands:

```bash
./scripts/start.sh status   # process + CLI status
./scripts/start.sh fg       # foreground Bridge (debug)
./scripts/start.sh stop     # stop services
./scripts/start.sh doctor   # diagnose Runner + backends
```

### Feishu slash commands

| Command | Description |
|---------|-------------|
| `/help` `/menu` | List all commands |
| `/status` | Current backend, cwd, model |
| `/stop` | Cancel the running agent task |
| `/new` | Start a fresh CLI session |
| `/resume` | List local CLI sessions (scoped by cwd) |
| `/resume 2` | Bind session #2 to this chat |
| `/resume last` | Bind the most recent session |
| `/resume all` | List sessions across all projects |
| `/backend cursor\|claude\|codex` | Switch agent |
| `/cd <path>` | Change project directory |
| `/ws list\|save\|use` | Named workspaces |
| `/model` `/effort` `/permission` | Model / Claude effort / permission mode |
| `/clone <url>` `/pull` | Git on the host |

Session storage paths:

| Backend | On-disk location |
|---------|------------------|
| **cursor** | `~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl` |
| **claude** | `~/.claude/projects/<encoded-cwd>/<id>.jsonl` |
| **codex** | `~/.codex/sessions/**/rollout-<id>.jsonl` |

## Documentation

| Topic | Link |
|-------|------|
| Feishu app setup | [docs/zh-CN/feishu-app-setup.md](docs/zh-CN/feishu-app-setup.md) |
| Bot custom menu | [docs/zh-CN/feishu-bot-menu.md](docs/zh-CN/feishu-bot-menu.md) |
| Quick start (manual / Docker) | [docs/zh-CN/quickstart.md](docs/zh-CN/quickstart.md) |
| Model & effort | [docs/zh-CN/model-effort.md](docs/zh-CN/model-effort.md) |
| Docker + host Runner | [docs/zh-CN/deploy/docker-host-runner.md](docs/zh-CN/deploy/docker-host-runner.md) |
| Full config example | [examples/config.full.yaml](examples/config.full.yaml) |

## Development

```bash
pnpm install
pnpm build
pnpm test
```

Monorepo packages: `core`, `backends`, `runner-host`, `runner-client`, `router`, `channel-feishu`, `apps/bridge`.

## Security

- Runner listens on `127.0.0.1` by default; protect `runner.token`
- Codex `allowBypassApprovals` is **off** by default — see [SECURITY.md](SECURITY.md)
- Do not commit real `appSecret` or tokens

## License

[MIT](LICENSE)
