# Remove Flow from CodeBridge

Status: local implementation complete. Verification is recorded in
`docs/plans/2026-09-23-remove-flow-verification.md`. Not deployed.

## Scope and baseline

User authorization: remove all Flow functionality and its integrations.
Verified production base: `origin/main@38f7e2734fe43f75ea00968f143b20337d21a3b5` after fetch.
Working branch: `codex/remove-flow`, initially zero commits ahead of the base.
Initial worktree: clean.

Remove the product, rather than hide it behind a feature flag. Do not replace
it with a new Skill, memory, plugin, or generalized candidate framework in this
change. Ordinary Agent sessions, attachments, queues, provider history import,
permission handling, delivery, cancellation, recovery, and deployment remain.
No push, merge, deployment, or deletion of live databases is included.

## Verified call chains

1. Bridge `cli.ts` computes `flowSaveSourceAvailability`; Runner Host adds the
   internal MCP configuration, while Pi registers its custom save tool.
   Successful tool events reach `FlowSaveToolTranslator` and
   `FlowSaveIntentService.requestFromTool`. The manual Web API calls the same
   service through `requestManual`.
2. Requested events feed Session projection and the global pending inbox.
   Confirm calls `extractRunDefinition`, materializes a Candidate in
   `flows.sqlite`, then appends completion. Startup reconciliation repairs the
   cross-store completion gap.
3. The Flow API edits and reviews definitions. Published Runbooks are consumed
   by explicit selection and, for eligible Web requests, Session bindings.
   `resolveFlowInvocation` -> `compileCatalogFlow` -> persisted plan ->
   Session Runtime -> shared `RunExecutor` -> capability execution and
   postcondition checking -> event projection and channel delivery.
4. Ordinary Agent prompts receive published Flow recommendation guidance.
   `fcb flow suggest` and `fcb flow batch` submit recommendations or batch
   drafts. User confirmation starts runtime execution.
5. Feishu and Telegram each instantiate `ChannelFlowController`, support
   `/flow`, and render Flow events through channel watchers/projectors.

## Removal inventory

### R1: admission and shared execution contracts

- Remove Flow invocation, binding, plan compilation, and submission paths in
  `apps/bridge/src/session-api.ts`, `session-runtime-api.ts`,
  `session-runtime-types.ts`, and `work-item-api.ts`.
- Explicitly reject legacy Flow execution payloads. A stale client sending
  `flow_id`, a Flow execution kind, or a Flow plan must not accidentally cause
  ordinary Agent execution.
- Stop consulting old Session Flow bindings. Remove active binding APIs and
  serialized product controls while retaining safe decoding of existing rows.
- Inventory queued/running Flow attempts before any later deployment. Do not
  resume them as ordinary Agent runs. A terminal retirement/recovery policy
  must be tested before removing the executor branch.
- Trim Flow scheduling, capability step execution, dry-run snapshots, and
  plan-only code from `packages/run-executor` and `packages/work-items`.
  Preserve ordinary Run leases, cancellation, provider-session ownership,
  event persistence, and ordinary production-write approval checks.

### R2: Agent integration and service composition

- Remove Flow services, stores, startup reconciliation, batch recovery, and
  route composition from `apps/bridge/src/cli.ts` and `channel-ingress.ts`.
- Remove recommendation guidance and Flow save availability from ordinary
  Run requests and contexts.
- Remove `flow-save-tool-translator.ts`, `flow-save-intent.ts`,
  `flow-save-inbox.ts`, `flow-recommendation-guidance.ts`, `flow-compile.ts`,
  `flow-invocation.ts`, `flow-api.ts`, `flow-batch-api.ts`,
  `flow-batch-service.ts`, and `flow-batch-validation.ts` after callers are gone.
- Remove `packages/runner-host/src/flow-save-mcp-server.ts`, its CLI/server
  wiring, and `packages/backends/src/pi-flow-save-tool.ts` and registration.
- Remove the Flow commands from `fcb-script.ts`, retaining send, say, mention,
  and deployment commands.
- `StdioMcpServerConfig` currently lives in `core/src/flow-save-tool.ts`.
  If generic MCP support still uses it, move the transport contract before
  deleting that file; do not delete generic ACP MCP handling by association.

### R3: Web

- Remove the Flows area, navigation, candidate selection, Flow deep-link
  routing, save action, confirmation card, inbox polling, recommendation UI,
  definition controls, review/publish UI, and batch UI from `workbench.tsx`.
- Remove Flow-specific component and lib files once imports are removed.
- Update `api.ts`, `types.ts`, `session-store.ts`, `session-timeline.tsx`,
  `composer.tsx`, `composer-controls.tsx`, `session-chrome.tsx`, and
  `design-preview.tsx` to remove product contracts and callbacks.
- Old Flow links must resolve to a clear retired/unavailable destination;
  never display an unrelated Session as the selected Flow.
- Historical Flow blocks must not expose live confirm, publish, or execute
  actions. Existing ordinary messages and imported provider history remain
  readable, including mixed timelines.

### R4: Feishu and Telegram

- Remove Flow controller calls, submission helpers, batch polling, Flow save
  notices, and Flow projector rendering from each bridge and watcher.
- Remove shared `channel-flow-controller.ts`, `channel-flow-projector.ts`,
  their exports, Flow channel DTOs, and ingress adapter methods.
- Remove advertised Flow commands from command help. Explicit legacy `/flow`
  commands should get a retired response, not be forwarded to an Agent as an
  instruction to execute a business operation.
- Preserve same-message streaming, edit fallback, final delivery, ordinary
  approvals, restart recovery, and zero writes after delivery terminal state.
- Telegram remains disabled. Automated verification cannot establish its
  production reachability.

### R5: packages, storage, documentation, and tests

- Remove `packages/flow-catalog` and `packages/workflow-engine` once all
  consumers are removed or shared utility contracts are relocated.
- Remove Flow batch storage module exports, Flow-specific core contracts,
  package dependencies, TypeScript project references, and lockfile entries.
- Audit `packages/policy/src/equity-capabilities.ts` and other capability
  callers before deleting anything: remove exclusive Flow use, preserve any
  independently used policy/approval mechanism.
- Preserve old database files and canonical events. Retain only documented
  historical decoding/schema compatibility; do not create a live fallback
  Flow service to read them. Physical data deletion is a separate operation.
- Update current README/configuration/help/example claims. Mark historical
  Flow specifications and verification documents as retired records rather
  than presenting them as current functionality.
- Remove obsolete Flow feature tests with their removed code. Keep unrelated
  provider-history/overflow tests, rewriting only fixtures/assertions that
  depended on Flow UI. Add retirement regression tests before implementation.
- Do not blanket-remove the English word `flow`: control flow, overflow,
  deployment workflows, and GitHub workflows are not this product.

## Baseline Surface Matrix

Pre-removal state below was source-inspected `implemented`; this task has not
re-verified deployment reachability or a live closed loop. Planned removal is
assigned per surface, with no implementation completion claim.

| Surface | Entry | Read path | Write path | Event consumption | Error handling | Recovery | Terminal feedback | Planned landing / state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Web | Flows, save action, links | Catalog, inbox, hydrate | save/confirm/review/run | SSE + timeline | retired links/API; no stale actions | no Flow poll/rebind | no live Flow controls | R3/R6; implemented now, removal planned |
| Agent | MCP/Pi save tool, prompt, fcb | source availability + recommendations | translated tool/fcb calls | tool_end translation | removed command fails clearly | resumed sessions cannot regain tool | no promise of saving a Flow | R2/R6; implemented now, removal planned |
| Feishu | /flow + ordinary run notices | channel ingress | controller execution/batch | watcher/projector | retired command response | delivery replay remains safe | ordinary final card only | R4/R6; implemented now, removal planned |
| Telegram | /flow + notices | channel ingress | controller execution/batch | watcher/projector | retired command response | delivery replay remains safe | ordinary final card only | R4/R6; implemented, disabled per user; removal planned |
| Bridge | route composition + runtime | Catalog/events/bindings | requests/plans/Catalog | domain projection | reject old Flow payloads | no Flow resume/batch recovery | ordinary Run terminal contract | R1/R2/R5/R6; implemented now, removal planned |

## R6: verification and completion

Regression cases:

- Flow creation/execution APIs and legacy payloads cannot create Candidate,
  Run, plan, binding, batch, or business side effect.
- Existing Session with an old Flow binding can submit an ordinary message.
- Ordinary fresh/resumed ACP and Pi requests contain no Flow save tool or
  Flow recommendation prompt, while attachments and generic MCP remain valid.
- Web has no Flows navigation, save action, polling, or Flow network calls.
  Mixed historical timelines hydrate without crashes or active Flow buttons.
- Feishu and Telegram no longer advertise or execute Flow; ordinary streaming,
  permission handling, terminal delivery, and restart behavior still pass.
- Old queued Flow data does not become an ordinary Agent task after restart.
- Provider-history import, narrow-screen containment, and ordinary Session
  switching still pass their independent assertions.

Verification commands: focused Vitest regression suites during each step;
`pnpm build`, `pnpm test`, `pnpm lint`, and the relevant Playwright suites after
integration. Playwright must use the edited build/server rather than reusing
an unrelated deployment. Run GitNexus impact before symbol edits and
detect-changes before any commit. Audit remaining Flow references and explain
every historical-compatibility exception. Recheck this Matrix before claiming
completion. Live deployment tests require a separately authorized deployment.

## Tooling compatibility resolved

The installed CLI does not implement the optional gitnexus-work skill's schema-4
JSON receipt protocol. Following renewed user authorization to execute, this
change uses the applicable gitnexus-refactoring workflow and the project's
supported impact/detect-changes gates. The unsupported JSON check is not
reported as passing. GitNexus is bound explicitly to CodeBridge; the initial
index commit equals the verified base. High-risk executor and channel watcher
changes were reported before editing.

Verification results and retained historical compatibility are recorded in the
completion report after all checks. No deployment is part of this change.
