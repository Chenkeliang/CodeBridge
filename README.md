<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brand/agent-logo-carbon.svg" />
    <img alt="AGENT · CodeBridge" src="apps/web/public/brand/agent-logo.svg" width="320" />
  </picture>
</p>

# CodeBridge

Self-hosted, multi-channel [Agent Client Protocol (ACP)](https://agentclientprotocol.com) gateway for coding agents.

Control local **Cursor**, **Claude Code**, **Codex**, and optionally **Pi** from Feishu or Telegram with the Runner accessing files, Git credentials, MCP tools, and sessions on your own Mac. Agents still send requests according to their model-provider and MCP configuration; self-hosting does not make model inference offline.

[简体中文](README.zh-CN.md)

## Release status

As of 2026-10-15, the latest npm release is **`@graychennpm/codebridge@0.1.0`**, published on 2026-10-10. This README also describes current source. Source changes after that release still carry version `0.1.0`; `--version` alone cannot identify their presence.

- **Released on npm:** initialization wizard, main-config secret references, opt-in Web, automatic session rotation, and a default queue limit of 100 turns per Session.
- **In source, not yet on npm:** independent Feishu group requests, quoted replies continuing the original conversation and native mentions of the current requester; preserved idle group replies, Codex archive restoration, and later startup/delivery fixes.
- **Local candidate, not published or deployed:** two Workbench entries, Channels and Tasks, manage channel access, Agent schedules, existing local schedules, publisher destinations and Feishu alert rules, with run recovery, pending work and incident inspection. The supported scope and remaining work are described in the [channel automation roadmap](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/channel-automation-roadmap.md) (Chinese).

See [release availability](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/release-status.md), including the local security and management candidates. macOS is the supported host setup; Linux service management is outside the current support scope.

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

Bridge handles channels and APIs; Runner launches local agents. Run both on the same Mac for the supported complete setup. Docker/remote Bridge deployments have limitations for reverse file delivery, notifications, and self-deployment; see the deployment guide.

## Install with npm

Requires Node.js 22.19 or newer. Install with `npm install -g @graychennpm/codebridge@0.1.0`, then run `codebridge init`. Start `codebridge-runner` and `codebridge start` in separate terminals. The package includes the Bridge, host Runner and Workbench assets; no source build, pnpm, or curl is needed. This runs two foreground processes; the npm package does not include the source checkout’s background-service scripts or independent host deployer.

You can also run `npx @graychennpm/codebridge@0.1.0 init`. For local distribution, `pnpm package:release` produces a tarball in `dist/`; `pnpm test:package` verifies a clean installation. See the [release guide](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/npm-release.md).

## Highlights

- Feishu long connection with streaming cards and optional custom menu
- Telegram Bot API long polling, including a native command menu
- Scoped native mentions on Feishu and Telegram for the requester or participants explicitly mentioned in a task
- One ACP path for `cursor`, `claude`, and `codex`; the legacy direct-CLI transport is gone
- Resume local sessions with `/resume`, `/resume last`, or `/resume all`
- Live adapter capabilities through `/model`, `/effort`, `/permission`, and `/config`
- Per-session command discovery and native actions in the [command reference](#commands)
- Named workspaces, additional directories, `/clone`, `/pull`, and file delivery
- macOS TCC-aware `/root add` flow with an immediate “waiting for system permission” status
- launchd KeepAlive on macOS, or the built-in watchdog for manual background mode

## Quick start

### Requirements for source installation

- macOS
- Node.js ≥ 22.19, pnpm 10.34.1, Git, and curl. The WorkItem Event Store uses Node's built-in `node:sqlite`; the optional Pi SDK adapter follows Pi's Node runtime requirement.
- At least one local agent CLI: `cursor-agent`, `claude`, or `codex`
- For chat access: a Feishu custom app with a bot, or a Telegram bot token. Local Web-only use can leave channels unconfigured.

### Install and start from source

```bash
git clone https://github.com/Chenkeliang/CodeBridge.git
cd CodeBridge

# Installs dependencies, builds, creates config, and checks local CLIs.
./scripts/start.sh setup

# If setup did not start the service, start Runner + Bridge in the background.
./scripts/start.sh start
```

The setup wizard (also available as `codebridge init`) writes `~/.codebridge/config.yaml`. It verifies Feishu / Telegram credentials on the spot, generates a Runner token, and picks the project root and default agent. The wizard prefers OS-keychain storage and writes `keychain:` references. The npm 0.1.0 wizard can offer an explicit plaintext fallback; the local security candidate rejects it and aborts when secure storage is unavailable. Existing settings and comments are preserved unless explicitly changed in the wizard; YAML formatting may change. Telegram requires a user or chat allowlist. Automatic user detection uses a one-time code sent to the bot in a private chat.

With `codebridge init --defaults` or no TTY, only a missing config is created. Set a long random `RUNNER_TOKEN` first to store an `env:RUNNER_TOKEN` reference. npm 0.1.0 otherwise generates a plaintext random token; the local security candidate requires the environment variable and fails without it. This path does not access the keychain or verify channel credentials. Run `codebridge secrets migrate` afterward to move plaintext secrets to the keychain.

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

For Feishu, create an enterprise custom app, enable the bot, and subscribe to the long-connection events described in [Feishu app setup](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/feishu-app-setup.md).

Telegram is optional. It can run alongside Feishu or in Telegram-only mode:

```yaml
telegram:
  botToken: env:TELEGRAM_BOT_TOKEN
  allowedUsers: ["123456789"]          # replace with authorized user IDs
  # allowedChats: ["-1001234567890"]   # if set, also restricts chats
  pollingTimeoutSec: 25
```

See [examples/config.full.yaml](https://github.com/Chenkeliang/CodeBridge/blob/main/examples/config.full.yaml) for the main fields and optional sections. Replace example identities, paths, and secret references before use.

### Web Workbench

Web is disabled by default. Use `codebridge start --web` for npm, or `node apps/bridge/dist/cli.js start --web` from source, to enable it for this launch. To persist the choice, set `web.enabled: true` in the configuration. Open `http://127.0.0.1:19790/workbench/`, or the port configured by `bridge.apiPort`.

Web shares Sessions, Runs, and events with channels. It has no separate user login and is intended for local access; do not expose it directly to the internet. Agent and tool network requests still follow their own configuration.

## Commands

This reference describes the current source checkout. Installed builds provide the commands included in their release.

### Feishu and Telegram

Use `/h full` for all aliases or `/cmd <keyword>` to search the current command catalog. Short forms use the same arguments as full names, such as `/st <instruction>` or `/rvb <branch>`.

Send `/commands` (`/cmd`) to see the catalog for the current chat or topic. Add a keyword to filter it. `/menu` (`/mn`) and `/help` (`/h`) show shortcuts for mobile, and `/help full` opens the grouped reference.

| Command | Use |
| --- | --- |
| `/status` (`/s`) | Show the backend, workspace, session settings, and active task. |
| `/new` (`/n`, `/reset`) | Start a new session with the next message. |
| `/resume` (`/r`), `/resume <N>`, `/resume last`, `/resume all` | List local sessions in the current directory, bind a numbered entry, bind the latest entry, or list sessions across directories. |
| `/session close <session-id>` (`/sess`), `/session delete <session-id>` | Close or delete a session through the selected backend. |
| `/stop` (`/cancel`, `/x`), `/continue` (`/c`) | Stop the active task or resume a paused queue. |
| `/command-status` (`/cs`), `/command-cancel` (`/cc`) | Reply to your original native-command message to check its receipt or request cancellation. Mention the bot when the Feishu group requires it. |
| `/steer <instruction>` (`/st`) | Send an instruction to the running turn when the adapter supports steering. |
| `/approve` (`/a`), `/deny` (`/d`) | Approve or reject the pending Agent permission request. |
| `/backend [name]` (`/b`), `/backend default` | Switch to a configured backend or select the default, such as `/backend codex` or `/backend pi`. |
| `/model [list]` (`/m`), `/model <name>`, `/model default` | List models, choose one, or clear the session override. |
| `/effort [list]` (`/e`), `/effort <level>`, `/effort default` | List reasoning levels, choose one, or clear the session override. |
| `/permission [list]` (`/perm`), `/permission <mode>`, `/permission default` | List permission modes, choose one, or clear the session override. |
| `/config` (`/cfg`), `/config <id> <value>`, `/config <id> default` | Show adapter settings, set a value, or clear the override for one setting. |
| `/thinking` (`/think`), `/thinking on`, `/thinking off` | Check or change whether thinking and tool progress are displayed. |
| `/cd <absolute-path>` (`/j`) | Change the current project directory. |
| `/roots` (`/rs`), `/root add <absolute-path>` (`/rt`), `/root remove <absolute-path>` (`rm`) | List, add, or remove additional directories. |
| `/ws list` (`/w`), `/ws save <name>`, `/ws use <name>`, `/ws remove <name>` | List, save, open, or remove named workspaces. |
| `/send <path>` (`/sf`), `/clone <git-url> [directory-name]` (`/cl`), `/pull` (`/pl`) | Send a file from the Bridge host, clone and switch to a repository, or run a fast-forward-only pull. |
| `/transport` (`/tr`) | Show the transport information for this compatibility command. |

Model, reasoning, permission, and configuration options depend on the selected adapter. Use the corresponding list command to see its current options.

### Session and native commands

The table covers commands shared by Feishu, Telegram, and the Web Workbench, plus the Web report viewer. In Web, type `/` to browse the catalog or enter a command directly. The Workbench has its own controls for session management, task control, and settings.

| Command | Use and availability |
| --- | --- |
| `/context` (`/ctx`) | Show the latest reported context usage, window limit, and utilization. |
| `/usage` (`/u`) | Show the latest reported session usage and any cost reported with it. |
| `/goal` (`/g`) | Show the latest reported Codex goal status and token figures when available. |
| `/compact` (`/cp`), `/compact <instructions>` | Compact the bound session. Codex and Claude support the bare command. Pi accepts optional instructions. |
| `/goal set <objective>`, `/goal pause`, `/goal resume`, `/goal clear` | Set, pause, resume, or clear the bound Codex session’s goal. `/goal <objective>` is shorthand for setting a goal. Setting or resuming may start a turn. |
| `/review [instructions]` (`/rv`), `/review-branch <branch>` (`/rvb`), `/review-commit <sha>` (`/rvc`) | Run Codex’s native review of uncommitted changes or a custom target, a branch, or a specific commit. |
| `/review-result [report-id]` (`/rvr`) | View the latest or a specific report in the bound Web session. Group chats receive a severity count and the report reference. |

Context, usage, and goal queries use observations already recorded for the bound provider session. Pi reports an estimate of context usage and cumulative session statistics. A session with no matching report shows that data is unavailable.

The dynamic catalog combines the current provider session’s advertised commands with the Runner’s verified capabilities. Commands marked **Available** can be invoked. Reported entries that cannot run show the reason when available, such as missing release evidence, adapter drift, or group permissions. Native commands require an already-bound provider session. Group execution requires an administrator configured in `access.admins` for Feishu or `telegram.admins` for Telegram.

Managed deployments of these native commands require command protocol 2 evidence from the independent host deployer. Retrying with the same request ID reads the existing receipt, including after a restart. Sending a new command creates a new request. Use the receipt tools above to check an earlier command. Cancellation stays pending until the adapter confirms the outcome.

To request a real channel notification, say “mention me when it finishes” or explicitly mention a participant in the task. The Agent uses `fcb mention` internally. Current-source Feishu group task replies already mention the current requester. npm `0.1.0` predates this group behavior.

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

Read [SECURITY.md](https://github.com/Chenkeliang/CodeBridge/blob/main/SECURITY.md) before exposing anything beyond localhost.

## Concurrency and known boundaries

- Different chats can run in parallel up to `runnerHost.maxConcurrentRuns` (default `4`).
- Each Session has one active task and defaults to at most 100 queued turns, controlled by `orchestration.session.maxQueuedTurns`. `/stop` cancels the active task. Queued turns follow the session’s queue state.
- **Current source, not npm:** each new ordinary Feishu group request gets an independent conversation and normally requires a bot mention. Quoting a verified bot reply continues its conversation without another mention. Ordinary replies stay in the group stream; existing native threads remain threads. Members quoting the same answer share its context.
- **npm `0.1.0`** uses the older group routing and lacks these ordinary-message isolation and quoted-reply fixes. Change agent, directory, model, or resumed session within the target conversation; slash commands without a reference use group-level context.
- In current source, members of an explicitly allowed Feishu group can ask and continue tasks. Group configuration commands require `access.admins` or `access.allowedUsers`; incident write approval remains scoped to that alert group’s `approverOpenIds`. Administrators are not automatically approvers for every workflow.
- Channel sessions may rotate on the next message after 12 idle hours. Context usage does not start a new session; history compaction stays with the provider. Busy/queued sessions do not rotate. Current-source Feishu group replies skip idle rotation; alert incidents are exempt. Configure `orchestration.session.autoRotate` to adjust idle rotation. The legacy `maxContextRatio` field is ignored.
- Agent notifications are limited to the current sender and participants explicitly mentioned in the current task. CodeBridge does not search the organization directory, mention everyone, or accept arbitrary user IDs from the Agent.
- `/transport` remains only as a compatibility response; ACP is the only transport.

## Backends and adapters

Pi uses `pi-sdk`; OpenCode uses `opencode acp`. Install, configure, and authenticate optional agents separately. The following are built-in ACP defaults; explicit `acpCommand` / `acpArgs` override them. Network access is not a default option of the stock Codex adapter; see the [Codex network guide](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/codex-acp-network.md) (Chinese).

| Backend | ACP command |
|---------|-------------|
| Cursor | `cursor-agent acp` |
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp@0.81.1` |
| Codex | `npx -y @agentclientprotocol/codex-acp@1.13.1` |

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
| Feishu app and permissions | [docs/zh-CN/feishu-app-setup.md](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/feishu-app-setup.md) |
| Feishu custom menu | [docs/zh-CN/feishu-bot-menu.md](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/feishu-bot-menu.md) |
| Manual / Docker quick start | [docs/zh-CN/quickstart.md](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/quickstart.md) |
| Model, effort, and permission | [docs/zh-CN/model-effort.md](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/model-effort.md) |
| Docker Bridge + host Runner | [docs/zh-CN/deploy/docker-host-runner.md](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/zh-CN/deploy/docker-host-runner.md) |
| Multi-project Agent workbench baseline | [docs/orchestration/README.md](https://github.com/Chenkeliang/CodeBridge/blob/main/docs/orchestration/README.md) |
| Full config example | [examples/config.full.yaml](https://github.com/Chenkeliang/CodeBridge/blob/main/examples/config.full.yaml) |
| Security policy | [SECURITY.md](https://github.com/Chenkeliang/CodeBridge/blob/main/SECURITY.md) |

## Development

```bash
pnpm install
pnpm run lint
pnpm run build
pnpm test
```

The monorepo contains `core`, `backends`, `work-items`, `policy`, `run-executor`, `project-catalog`, `runner-host`, `runner-client`, `router`, `channel-feishu`, `channel-telegram`, and `apps/bridge`.

## License

[MIT](LICENSE)
