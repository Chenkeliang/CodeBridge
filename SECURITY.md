# Security Policy

## Runner token

- Use a long random `RUNNER_TOKEN`
- Runner binds `127.0.0.1` by default — do not expose to the public internet without authentication

## Secrets in config.yaml

- `feishu.appSecret`, `telegram.botToken` and `runner.token` accept references instead of plaintext:
  `keychain:<service>` (macOS Keychain / Linux Secret Service) or `env:<NAME>`.
- `codebridge secrets migrate` moves existing plaintext values into the keychain (written via stdin, never argv)
  and rewrites them as references; `codebridge secrets status` and `codebridge doctor` report each source without values.
- When CodeBridge saves config it writes back the reference (or the original on-disk value), so resolved and
  env-provided secrets are never persisted. The host deployer copies keychain references, not values.

## ACP mode / permissions

码桥通过 ACP `session/set_config_option` 设置三个 backend 实时 advertise 的 `mode`。使用 `/permission` 查看当前 adapter 的真实选项；Claude 默认仍是 `bypassPermissions`（可在 `backends.claude.claudePermissionMode` 修改）。

仅在可信本机环境使用 `bypassPermissions` 或 Codex 的 `agent-full-access`。更严格可选择 Claude `default`、Cursor `ask` 或 Codex `read-only`。

## Reporting

Open a GitHub security advisory or email maintainers for sensitive issues.
