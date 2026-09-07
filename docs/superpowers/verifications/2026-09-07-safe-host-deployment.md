# Safe host deployment verification

Base production commit d975427; source worktree CodeBridge-wt-safe-deploy on feat_safe_host_deploy. No shared branch merge/push. Independent publisher installed from explicit source copy, with private config and fixed host paths. Only the native Feishu sender verified through the user-authorized 0907 UI message is configured as owner.

## Checks
- Full workspace build passes.
- Full Vitest run: 154 files, 1524 tests pass (includes Python fault suite wrapper).
- Python publisher suite: 33 tests pass.
- Independent reviewer reproduced and closed auto-publish double-worker race, state-persist/maintenance-cleanup crash windows, notification loss/retry availability, rollback mutex blockage, custom data directory, and queued-delivery drain deadlock.
- Installer dry-run and installation healthy; script digest matches installed controller. No business service restart performed by installer.
- Actual Feishu bootstrap/prepare/publish/status/rollback final evidence saved under /Users/keliang/outputs/codebridge-safe-deploy after live verification, not inferred from mocks.

## Surface matrix
| Surface | Entry/read/write/events | Recovery/error/terminal | Evidence |
|---|---|---|---|
| Feishu | bounded oral command recognition plus native owner identity; normal edit messages continue to Agent | independent status notifications; maintenance refuses new tasks with resend guidance; no text-based impersonation | parser/native owner/negation tests pass; real UI test pending at commit |
| Agent | bound codebridge_deploy MCP (fcb for non-sandboxed shells) -> existing authenticated API -> active native-owned Run/delivery context | publish intent required; no direct restart needed; source directory supplied | fcb HTTP tests and native-context authorization tests pass |
| Web | existing Session API remains reachable; executor pauses new runs while active work drains | queued work resumes on maintenance removal | dispatch pause/reclaim tests pass; no new UI |
| Telegram | deployment owner interface restricted to Feishu; shared executor maintenance applies | existing work may finish; new work remains queued | existing full suite passes; production disabled |
| Host publisher | authenticated localhost command + durable job state + frozen build + launchd switch | failed boot rollback, PID/readiness checks, interrupted worker recovery, nonblocking retry notifications | 33 fault tests pass; live install health passes |

## Limits
Normal release refuses detected DB DDL changes and controller/installer source changes. No automatic database rollback or controller self-update. Explicit local controller installation remains separate. Same-UID shell access is not a sandbox; oral/API owner checks do not create an OS privilege boundary against a compromised local process. HTTP disconnect during a result notification does not re-execute deployment; stable notification IDs are retried. Power-off/sleep cannot be overcome by launchd KeepAlive.


## Real environment follow-up
Actual owner Agent shell returned `connect EPERM 127.0.0.1:19790` on macOS before any service restart. Added deploy to the existing stdio MCP server, binding API/token/run ID in Runner configuration. Per-run env is part of the MCP pool key. Strict tool input excludes identity; HTTP errors are tool errors. Flow-save remains optional independently. No sandbox/network permission was relaxed. Full regression and real MCP task result recorded externally after publication.
