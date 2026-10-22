# Changelog

## Unreleased — source after npm 0.1.0

Not published to npm. Source metadata still reports 0.1.0; record the Git commit as well. See [release availability](docs/release-status.md).

- Feishu group requests use independent conversations; quoting a bot reply resumes its conversation and group replies mention the current requester (`fb5fb49`).
- Preserve idle Feishu group reply sessions and restore archived Codex sessions before resuming (`8e3a0a0`).
- Bound projection queries, reclaim active leases, and drain already-ready startup responses before declaring a timeout (`c6d763d`, `fae0cdc`).
- Fix Feishu image/delivery behavior and add boolean ACP configuration plus source-only Codex network integration checks (`35d6fcb`). A compatible network-option adapter is still required.
- Align bilingual documentation, configuration examples, and published/source/planned capability labels. Distinguish the local management candidate from public main and npm.

Local feature candidate (not merged to public main, not deployed or published):

- Include the reference-only credential storage candidate as `c830331` (replayed from `fd306b0`).
- Add Channels and Tasks to Workbench for channel access, group members, existing launchd plans, fixed publisher destinations and Feishu alert settings.
- Maintain external Skill rules in place, with file revisions and encrypted recovery copies; preserve existing incident state and apply current group approvers to new responses.
- Persist configuration atomically and retain the previous in-memory authorization state on save failure.

## 0.1.0 — 2026-10-10

First npm distribution release.

- Ships the Bridge, host Runner, internal modules and Workbench static assets in one installable package.
- Adds interactive initialization with credential verification, Telegram allowlists, keychain references and safe cancellation.
- Generates a private config with a random Runner token for non-interactive setup, without replacing an existing file.
- Preserves secret references during config updates and redacts credentials from Feishu SDK logs.
- Adds configurable context/idle session rotation and scopes deployment instructions to CodeBridge maintenance tasks.
- Provides a shared package-derived version, version consistency checks and isolated package-install verification.

Runtime requirements: Node.js 22.19 or newer. macOS is the supported host setup; this candidate does not add Linux service management. Agent CLI installation and provider authentication remain separate setup steps.
