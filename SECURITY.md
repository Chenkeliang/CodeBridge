# Security Policy

Availability is tracked in [release status](docs/release-status.md). The npm 0.1.0 release predates the security and management changes in this local candidate. The following reference-storage rules describe this candidate's source; upgrade the Bridge and host controller together before migrating live configuration.

## Runner token

- Use a long random `RUNNER_TOKEN`
- Runner binds `127.0.0.1` by default. Keep Bridge and Runner local; the shared token is not a multi-user isolation mechanism. Agents receive it as `FCB_TOKEN`, while outbound requests also validate their persisted Run source.
- Opt-in Web has no independent login and serves its local API token through `/workbench/config.json`. It is intended for the local OS user, not direct public exposure.

## Secret storage and migration

- Main configuration secrets (`feishu.appSecret`, `telegram.botToken`, `runner.token`) use
  `keychain:<service>` (OS credential store) or `env:<NAME>` references.
- Saving new credential values moves them to the OS keychain and verifies the read-back before writing a reference.
  Interactive initialization never falls back to plaintext. Unattended `codebridge init --defaults`
  requires `RUNNER_TOKEN` in the environment and stores only `env:RUNNER_TOKEN`.
- Publisher credentials in `publisher-tokens.json` and controller credentials in `deployer/config.json`
  use the same reference mechanism. The host installer never serializes resolved environment values.
- `codebridge secrets status` reports sources/readability without values. `codebridge secrets migrate`
  preserves credential values while replacing legacy plaintext in all three configuration files.
  Update the Bridge and independent host controller to a reference-aware version before migrating live files.
- Configuration files are private (`0600`). Keep the data directory private (`0700`). Migration does not create
  plaintext `.bak` files. If rollback copies are needed, encrypt them, put them outside the repository/data directory,
  and keep the recovery key in the OS keychain. Never commit runtime configuration, tokens or backup files.
- References remove secrets from configuration files; processes running as the same OS user may still access
  the credential store. Agents still receive the common Runner token as `FCB_TOKEN` for local authenticated
  file/message/mention/alert/deployment requests. Run-scoped short-lived credentials are a separate hardening task;
  this storage change does not expand or replace runtime authorization.

## Open-source checks

Install the upstream scanner (Gitleaks >= 8.25, `brew install gitleaks`) and run `pnpm secrets:check` before contributing.
The check scans reachable Git history and the current working directory, redacts findings, and rejects tracked
runtime/backup files. CI runs it with full Git history. The config extends the upstream default rules and permits
only two explicitly scoped test non-secrets: the fake keychain value and public idempotency request identifiers.
Do not add live credentials to allowlists or baselines. Reports must never contain unredacted secrets.
A clean scanner result is not a security certification. Report an actual leak privately, revoke/rotate the affected
credential, and coordinate any history rewrite with maintainers rather than force-pushing automatically.
Unit tests block native OS-keychain access; credential tests must provide a simulated `SecretOptions.run`.

## Local management boundary

The Channels and Tasks pages use the existing local Workbench token, with same-origin and configuration-revision checks on writes. They do not add independent browser login or isolate users/processes sharing the same OS account. Feishu and Telegram identities remain channel-specific; receiving a notification does not grant approval authority.

Skill rules and launchd definitions stay in their original private directories. Editing them creates an AES-256-GCM encrypted recovery copy in `<dataDir>/management-backups/`, with its key in the OS keychain. Missing keychain access blocks the replacement. Runtime configuration, real identities, business Skills, task definitions and recovery copies must not enter Git or release packages.

Docker preparation may resolve references into `deploy/.env`; treat it as a live secret file. Source storage hardening does not provide a multi-user sandbox or task-scoped short-lived credentials.

## ACP mode / permissions

码桥通过 ACP `session/set_config_option` 设置三个 backend 实时 advertise 的 `mode`。使用 `/permission` 查看当前 adapter 的真实选项；Claude 默认仍是 `bypassPermissions`（可在 `backends.claude.claudePermissionMode` 修改）。

仅在可信本机环境使用 `bypassPermissions` 或 Codex 的 `agent-full-access`。更严格可选择 Claude `default`、Cursor `ask` 或 Codex `read-only`。

## Reporting

Open a GitHub security advisory or email maintainers for sensitive issues.
