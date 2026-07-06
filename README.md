# feishu-code-bridge

**飞书码桥** — Control local **Cursor**, **Claude Code**, and **Codex** from Feishu (Lark).

Message your Feishu bot to run coding agents on your Mac/Linux host: stream replies, resume terminal sessions, switch backends, and change project directories — without leaving chat.

[中文文档](README.zh-CN.md)

## Features

- **Feishu WebSocket** long connection with streaming markdown replies
- **Multi-backend**: `cursor` / `claude` / `codex` via **ACP** (default) or CLI spawn fallback
- **Session routing**: `/new`, `/resume`, `/backend`, `/cd`, `/ws`, `/model`, `/effort`, `/permission`, `/transport`, `/stop`
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
| **Runner** | Spawns ACP agents or CLI processes, streams events, exposes `/runs` API |

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
| `/transport acp\|cli\|default` | Switch ACP / CLI transport (per-chat override) |
| `/clone <url>` `/pull` | Git on the host |

Session storage paths:

| Backend | On-disk location |
|---------|------------------|
| **cursor** | `~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl` |
| **claude** | `~/.claude/projects/<encoded-cwd>/<id>.jsonl` |
| **codex** | `~/.codex/sessions/**/rollout-<id>.jsonl` |

## Concurrency & limits

Two layers matter: **Runner (host)** spawns CLI processes; **Bridge / Orchestrator (Feishu)** routes chat messages to Runner. Limits differ.

| Scenario | Supported? | Layer |
|----------|------------|-------|
| **Different Feishu chats** running tasks at once (DM + group, two groups, two topics) | ✅ | Runner default **4** concurrent CLIs (`runnerHost.maxConcurrentRuns`) |
| **Different backends in parallel** (chat A → cursor, chat B → claude) | ✅ | Runner; separate `chatId` per chat |
| **Multiple CLI sessions** (each chat binds its own `/resume` target) | ✅ | Persisted per `chatId \| topicId \| backend \| cwd` in `sessions.json` |
| **Second message in the same chat** (same `chatId` + topic) | ⚠️ Cancels the first | **Feishu side**: one active run per chat; new message aborts the previous |
| **Two people @ the bot in one group** at the same time | ❌ | One `chatId` → shared binding (backend / cwd / model) and only one active run |
| **cursor + claude in parallel in one group** | ❌ | One backend bound per chat at a time; use `/backend` to **switch**, not run both |
| `/cd`, `/ws use` to change project | ✅ Two steps | Slash command first, then @ with your task; @ alone does not pick a repo |

**Examples**

- DM runs cursor + a group runs claude → parallel OK (different `chatId`s).
- Two people in the same group @ the bot for different repos → not OK: shared binding and task cancellation.
- Two repos in parallel → use two Feishu chats (two groups or DM + group), each with its own `/cd` or `/ws use`.

Smoke test: `node scripts/test-concurrency-live.mjs` (parallel cursor + claude against local Runner).

## ACP mode (default)

Runner talks to agents over the [Agent Client Protocol](https://agentclientprotocol.com) (stdio JSON-RPC), same model as Zed External Agents.

| Backend | ACP spawn command |
|---------|-------------------|
| **cursor** | `cursor-agent acp` |
| **claude** | `npx -y @agentclientprotocol/claude-agent-acp@0.55.0` |
| **codex** | `npx -y @agentclientprotocol/codex-acp@1.1.0` |

Config (`backends.<id>.transport`):

- `acp` — default; use Registry-style agents above
- `cli` — legacy `stream-json` spawn (`cursor-agent -p`, `claude -p`, `codex exec`)

`runnerHost.acpPermissionPolicy`: `auto_allow` (headless Feishu) or `prompt_deny`.

**Resume**: Claude/Codex use `session/resume`; Cursor uses `session/load` (no `session/resume`).

**Doctor** reports `acp-initialize` and `cli-version` separately — a broken native CLI does not block ACP.

```bash
node scripts/acp-probe.mjs                    # direct JSON-RPC probe (no Runner)
node scripts/acp-probe.mjs --backend codex
RUNNER_TOKEN=... node scripts/test-acp-live.mjs --backend cursor
```

See [examples/config.full.yaml](examples/config.full.yaml).

## Documentation

| Topic | Link |
|-------|------|
| Feishu app setup | [docs/zh-CN/feishu-app-setup.md](docs/zh-CN/feishu-app-setup.md) |
| Bot custom menu | [docs/zh-CN/feishu-bot-menu.md](docs/zh-CN/feishu-bot-menu.md) |
| Quick start (manual / Docker) | [docs/zh-CN/quickstart.md](docs/zh-CN/quickstart.md) |
| Model & effort | [docs/zh-CN/model-effort.md](docs/zh-CN/model-effort.md) |
| Concurrency & limits | [README.md#concurrency--limits](README.md#concurrency--limits) |
| V2EX post (ZH) | [docs/zh-CN/v2ex-post.md](docs/zh-CN/v2ex-post.md) |
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
