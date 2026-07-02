# Security Policy

## Runner token

- Use a long random `RUNNER_TOKEN`
- Runner binds `127.0.0.1` by default — do not expose to the public internet without authentication

## Codex bypass

`allowBypassApprovals: false` by default. Enabling it allows unattended command execution on the host.

## Claude permission mode

飞书通过 `claude -p` 非交互调用时，CLI 默认 `dontAsk` 会**直接拒绝** Bash（无法跑 skill/脚本）。

码桥默认对 Claude 传入 `--permission-mode bypassPermissions`（可在 `backends.claude.claudePermissionMode` 修改）。

仅在可信本机环境使用；更严格可设为 `acceptEdits` 或 `default`（但飞书场景下往往无法人工点批准）。

## Reporting

Open a GitHub security advisory or email maintainers for sensitive issues.
