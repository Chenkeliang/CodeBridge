# Flow removal verification

Branch: `codex/remove-flow`.
Production base: `origin/main@38f7e2734fe43f75ea00968f143b20337d21a3b5`.
Scope: local code removal and verification. No push, merge, deployment,
service restart, Telegram enablement, or live data deletion.

## Result

- Removed Flow navigation, composer selection, save action, confirmation and
  management UI, global inbox polling, recommendations, and batch controls.
- Removed Flow API implementations, save-intent services, translation of tool
  events, recommendation prompt injection, and startup/batch recovery services.
- Removed Flow execution and capability-plan evaluation from RunExecutor.
  Old queued Flow/plan runs terminate as interrupted with `flow_retired`,
  without resolving or calling an Agent. Ordinary Run lifecycle remains.
- Removed channel controllers, Flow rendering and notices, batch polling,
  advertised commands, and `fcb flow` functionality. Legacy commands return a
  retirement message. Native permission commands remain distinct and intact.
- Removed Flow Catalog and workflow-engine packages and their dependencies,
  Flow-specific core/channel DTOs, and the inbox index/query implementation.
- Extracted the shared deployment MCP into `deployment-mcp-server.ts` and the
  generic transport type into `mcp-types.ts`. Deployment authorization, bound
  Run identity, and Pi bash environment isolation remain covered by tests.
- Old Flow HTTP paths return 410 after authentication. Rejection of obsolete
  execution fields is restricted to execution submission endpoints, so Skill
  or other APIs may still use their own `plan` data.
- Updated current README/rules and marked old Flow documents as historical.
  AGENTS.md, CLAUDE.md, and user skill files were not modified.

## Historical compatibility intentionally retained

These are not active Flow functionality:

- Existing SQLite columns/tables, immutable events, run execution identity,
  and old plan record decoding remain so opening an existing database does
  not require destructive migration. No live `flows.sqlite` was deleted.
- Session/Run serialized legacy fields can still be read. Session binding
  writes were removed, and ordinary messages ignore historical bindings.
- The projector recognizes retired event kinds as no-ops and advances its
  cursor. Old stored Flow timeline blocks have no active controls in Web.
- HTTP/command tombstones prevent stale clients or resumed Agent context
  from silently treating a former Flow invocation as ordinary execution.
- Generic policy, capability registry, MCP runtime, Agent permissions,
  production-write approval, Session coordinator, and event storage remain.
  Their shared infrastructure must not be deleted just because Flow used it.

## Verification evidence

- Initial retirement regression failed against the original startup wiring.
- First integrated suite: 1159 passed / 45 failed. Failures included obsolete
  feature assertions, deleted-file references, and a timeline syntax leftover;
  these were corrected, with unrelated Skill/directory tests preserved.
- Intermediate suite: 1200 passed / 4 failed. Remaining failures were stale
  Flow-notice/index assertions; generic terminal/recovery assertions remain.
- Next full suite: 130 files / 1203 tests passed.
- Final full suite after the dry-run guard: 130 files / 1204 tests passed
  (`pnpm exec vitest run --reporter=dot`, 29.15 seconds).
- Final retirement safety suite: 10/10 passed, including old execution fields,
  dry-run rejection, stale Session binding, queued Flow interruption, and a
  non-Flow Skill plan payload. The latter exposed an overbroad rejection gate
  in RED and passed after narrowing the route match.
- `pnpm build`: passed for the remaining 18 workspace projects.
- `pnpm lint`: passed; 0 errors and 8 warnings. Warnings are not described as
  a zero-warning result.
- Browser suite: 13/13 passed against an isolated Vite server on
  `127.0.0.1:5187`, never reusing the deployed Web server. Covered retirement
  navigation/network activity, old links, provider-history read/confirm/retry
  and Session race behavior, and overflow at 320/768/1280/1536px.
- `git diff --check`: passed.

Unit tests require execution outside the restricted sandbox on this host:
the sandbox attempt failed resolving localhost before test collection. That
startup failure was not counted as a regression RED or a passing check.

## Graph and scope review

The initial, pre-removal graph reported CRITICAL: 133 changed symbols and
75 affected execution processes. The CLI display shortened the lists, so
the complete MCP result was obtained through stdio for inspection.

After `gitnexus analyze --index-only --force`, source hashes in the index
matched the working source files. The current graph reported CRITICAL:
91 changed symbols and 89 affected processes. Full returned array counts
match the summary; no partial/truncated marker was returned. This installed
version omits those flags rather than explicitly returning false.

Affected retained areas were checked against the regression suites: permission
resolution, stop/cancel, provider ownership/leases, Agent event persistence,
outbound publication, Feishu live/recovery cards, Telegram final delivery,
Session API/projection, provider-history import, composer, and Skill control
plane. Removed Flow-only processes were checked against source/dependency
removal and retirement contracts. Graph file counts do not represent all
deleted files; the Git diff inventory is the source of truth for deletions.

The final staged gate includes the new files: CRITICAL, 156 symbols and
89 processes across 106 non-deleted paths. Git records 177 changed paths in
total, including 71 deletions. The full returned lists were checked; no
partial/truncated marker was returned. `git diff --cached --check` passed.

## Completion Surface Matrix

Production reachability is not inferred from local tests. Deployment remains
a separate, not-yet-authorized step.

| Surface | Entry | Read path | Write path | Event consumption | Error handling | Recovery | Terminal feedback | State and landing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Web | Flow menu/actions removed | No Flow API/polling | No Flow mutations | Ordinary timeline; legacy controls hidden | Old links report retirement | Refresh/import/races tested | Ordinary messages visible | R3/R6 implemented and browser-tested; production reachable/closed-loop not verified |
| Agent | Save tools/prompt/fcb removed | No Flow source/recommendation lookup | No translated save event | Normal Agent events retained | fcb legacy call fails clearly | Normal resume/lease tests pass | No new Flow promise from injected code | R2/R6 implemented/tested; live production not verified; old Agent transcript text is not rewritten |
| Feishu | Controller removed; /flow retired | Ordinary ingress | No Flow submit/batch | Ordinary stream and delivery | Retirement response | Live/replay/restart contracts pass | No Flow footer; ordinary terminal card | R4/R6 implemented/tested; live production not verified |
| Telegram | Menu/controller removed; /flow retired | Ordinary ingress | No Flow submit/batch | Ordinary events | Retirement response/edit fallback | Recovery contracts pass | Ordinary final chunks | R4/R6 implemented/tested; disabled; not reachable or live closed-loop |
| Bridge | Old Flow routes rejected | No Catalog/inbox service | No save/publish/bind/execute API | Retired events recognized, no controls | 410 before business mutation | Old runs cannot fall back to Agent | Interrupted with retirement reason | R1/R2/R5/R6 implemented/tested; production deployment pending |

No implementation of replacement Skills, memory generation, or plugin
orchestration is included in this removal.
