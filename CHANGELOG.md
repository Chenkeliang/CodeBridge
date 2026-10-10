# Changelog

## 0.1.0 — Unreleased candidate

This is the first npm distribution candidate; no public npm release or Git tag has been created yet.

- Ships the Bridge, host Runner, internal modules and Workbench static assets in one installable package.
- Adds interactive initialization with credential verification, Telegram allowlists, keychain references and safe cancellation.
- Generates a private config with a random Runner token for non-interactive setup, without replacing an existing file.
- Preserves secret references during config updates and redacts credentials from Feishu SDK logs.
- Adds configurable context/idle session rotation and scopes deployment instructions to CodeBridge maintenance tasks.
- Provides a shared package-derived version, version consistency checks and isolated package-install verification.

Runtime requirements: Node.js 22.19 or newer. macOS is the supported host setup; this candidate does not add Linux service management. Agent CLI installation and provider authentication remain separate setup steps.
