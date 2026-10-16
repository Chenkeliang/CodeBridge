# Contributing

Use macOS, Node.js ≥22.19 and pnpm 10.34.1. The npm package is a distribution artifact; contribute from a source checkout. Read [release availability](docs/release-status.md) before describing a feature as released.

1. Fork/clone the repository if needed, then create a feature branch from the current production base.
2. Install with `pnpm install --frozen-lockfile`.
3. Change only the intended files and run the relevant checks. For code changes, use `pnpm build`, `pnpm lint`, and `pnpm test`; distribution changes also require `pnpm version:check`, `pnpm package:release`, and `pnpm test:package`.
4. Submit a PR describing the problem, resulting behavior, scope, and verification. Do not include runtime config, credentials, user data, or backups.

## Documentation changes

Keep both READMEs, configuration examples and the affected user guide consistent with the current source. Separate npm-released, source-only and planned features; add post-release changes under `Unreleased` in [CHANGELOG](CHANGELOG.md). Use portable placeholder paths and environment/credential-store references. Do not rewrite historical acceptance reports as proof of a new release.

Check Markdown links and parse YAML examples against `packages/core/src/config-schema.ts`. Documentation-only changes need appropriate static checks, not live model calls or messages to production chats. Optional real-channel verification must name its side effects and use a dedicated test conversation.

## Architecture and extension points

- `packages/core`: configuration contracts, common types, secret references.
- `packages/backends`, `packages/runner-host`, `packages/runner-client`: agent adapters and the authenticated host execution boundary.
- `packages/session-catalog`, `packages/session-coordinator`, `packages/work-items`: Sessions, queue/recovery, Runs and durable events.
- `packages/router`, `packages/channel-feishu`, `packages/channel-telegram`: command routing, channel identity/transport and presentation.
- `packages/policy`, `packages/run-executor`, `packages/mcp-runtime`, `packages/agent-registry`, `packages/project-catalog`: authorization, execution and registered resources.
- `apps/bridge`: composition root, CLI and APIs; `apps/web`: optional local Workbench.

Use existing registration and configuration mechanisms before adding a special case. Channel adapters translate verified native identities; shared rules and state transitions belong in the backend. See [architecture](docs/orchestration/architecture.md), [project rules](AGENTS.md), and the [channel automation roadmap](docs/zh-CN/channel-automation-roadmap.md).

Check Web, Agent, Feishu and Telegram independently for interaction changes; a working API alone does not prove that a user can finish the flow. Preserve authentication, explicit approval, delivery recovery and audit boundaries. Report sensitive findings through [SECURITY](SECURITY.md), not a public issue containing secrets.
