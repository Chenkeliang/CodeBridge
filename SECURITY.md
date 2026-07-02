# Security Policy

## Runner token

- Use a long random `RUNNER_TOKEN`
- Runner binds `127.0.0.1` by default — do not expose to the public internet without authentication

## Codex bypass

`allowBypassApprovals: false` by default. Enabling it allows unattended command execution on the host.

## Reporting

Open a GitHub security advisory or email maintainers for sensitive issues.
