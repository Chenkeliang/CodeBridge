# Contributing

1. Fork and clone the repo
2. `pnpm install && pnpm build && pnpm test`
3. Create a feature branch
4. Submit a PR with a clear description

## Project structure

- `packages/core` — types, ConfigStore
- `packages/backends` — cursor/claude/codex adapters
- `packages/runner-host` — host Runner HTTP server
- `packages/router` — session routing, slash commands
- `packages/channel-feishu` — Feishu Channel SDK bridge
- `apps/bridge` — CLI entry
