# Security Policy

## Runner token

- Use a long random `RUNNER_TOKEN`
- Runner binds `127.0.0.1` by default — do not expose to the public internet without authentication

## ACP mode / permissions

码桥通过 ACP `session/set_config_option` 设置三个 backend 实时 advertise 的 `mode`。使用 `/permission` 查看当前 adapter 的真实选项；Claude 默认仍是 `bypassPermissions`（可在 `backends.claude.claudePermissionMode` 修改）。

仅在可信本机环境使用 `bypassPermissions` 或 Codex 的 `agent-full-access`。更严格可选择 Claude `default`、Cursor `ask` 或 Codex `read-only`。

## Reporting

Open a GitHub security advisory or email maintainers for sensitive issues.
