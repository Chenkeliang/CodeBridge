# Channel Runtime Truth Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Feishu and Telegram recovery preserve presentation settings, make queue resume idempotent per user command, prevent Agent runs from being projected as Flow runs, and keep one authoritative Feishu Run status card.

**Architecture:** Persist each decision at the boundary where it becomes fact: `show_thinking` on the Delivery, `execution_kind` on the Run, and command identity in the resume request. JSON replay and live SSE carry the same strict event DTO. Channels only transport identities and render state; they do not infer Runtime or Flow state.

**Tech Stack:** TypeScript, Hono, SQLite, Vitest, Feishu CardKit, Telegram Bot API, GitNexus.

---

## 0. Locked invariants and baseline

- [x] Commit the canonical Session event-wire repair separately as `6297ef9`.
- [x] Verify the baseline with 169 focused tests plus Core, Feishu, Telegram, Bridge, and Web type builds.
- [x] Do not stage `AGENTS.md`, `.playwright-cli`, `output`, `test-results`, Vite timestamp files, or unrelated Flow/Skill documents.
- [x] Do not introduce fallback parsing, camelCase wire aliases, inferred channel state, or compatibility branches.
- [x] Keep `/effort` independent from `/thinking`: effort controls model reasoning; thinking controls presentation.

## 1. Surface Matrix

| Surface | Entry | Read path | Write path | Recovery | Terminal feedback | Planned result |
|---|---|---|---|---|---|---|
| Web | Workbench | snapshot + canonical SSE | existing message/resume APIs | snapshot refresh | timeline/result | Agent steps never render as Flow; resume regression stays green |
| Agent/Runtime | Run executor | Run + Plan + events | existing executor events | persisted Run/events | persisted terminal event | generic Agent `STEP_*` retained; Run stores explicit execution kind |
| Feishu | message, `/c`, Run card | Delivery + live/replay events | CardKit + resume API | startup/reconnect/15s reconcile | the original Run card | thinking preference survives recovery; `/c` is repeatable; no detached 10m message |
| Telegram | update, `/c` | Delivery + live/replay events | edit message + resume API | startup recovery | original pending message | strict contract/tests only; production remains disabled and is not claimed closed-loop |

## 2. Task 1 — Persist the Delivery presentation snapshot

**Files:**

- Modify `packages/core/src/types.ts`
- Modify `packages/work-items/src/session-schema.ts`
- Modify `packages/work-items/src/session-runtime.ts`
- Modify `packages/session-coordinator/src/coordinator.ts`
- Modify `apps/bridge/src/channel-ingress.ts`
- Modify `apps/bridge/src/session-api.ts`
- Modify `apps/bridge/src/session-runtime-api.ts`
- Modify `packages/channel-feishu/src/bridge.ts`
- Modify `packages/channel-telegram/src/telegram-bridge.ts`
- Test the corresponding `*.test.ts` files plus `apps/integration/session-event-contract.integration.test.ts`

- [x] **Step 1: Write failing contract and migration tests**

Lock these cases:

```ts
expect(delivery.showThinking).toBe(false);
expect(submittedBody.show_thinking).toBe(false);
expect(invalidPartialDelivery.status).toBe(400);
expect(() => insertShowThinking(2)).toThrow();
```

Historical rows must migrate to `false`; a stored `true` must survive the status-table rebuild.

- [x] **Step 2: Run the focused tests and confirm RED**

```bash
pnpm vitest run \
  packages/work-items/src/session-schema.test.ts \
  packages/session-coordinator/src/delivery.test.ts \
  apps/bridge/src/channel-ingress.test.ts \
  apps/bridge/src/session-api.test.ts \
  packages/channel-feishu/src/bridge-lifecycle.test.ts \
  packages/channel-feishu/src/bridge-recovery.test.ts \
  packages/channel-telegram/src/telegram-bridge.test.ts
```

Expected: missing `showThinking/show_thinking` fields and recovery still forces `true`.

- [x] **Step 3: Add the strict Delivery contract**

```ts
interface ChannelSessionMessage {
  replyToMessageId?: string;
  showThinking?: boolean;
}

interface ChannelDeliveryInput {
  showThinking: boolean;
}

interface ChannelDeliveryRow {
  showThinking: boolean;
}
```

`replyToMessageId` and `showThinking` must be present together. HTTP and SQLite use `show_thinking`; TypeScript uses `showThinking`.

- [x] **Step 4: Add the SQLite column and safe migration**

```sql
show_thinking INTEGER NOT NULL DEFAULT 0
  CHECK (show_thinking IN (0, 1))
```

Update the old delivery-table rebuild to copy this column. Replace the broad `row.sql.includes("CHECK")` test with a check that specifically recognizes the delivery `status` constraint.

- [x] **Step 5: Capture once and restore from the snapshot**

Both channels resolve once at submit time:

```ts
const showThinking = binding.showThinking ?? true;
```

Pass that value to both the live renderer and the persisted Delivery. Recovery must use `delivery.showThinking`; delete all recovery hard-codes and binding re-reads.

For Telegram, pass `message.message_id` as `replyToMessageId` and `update.update_id` as the stable submit idempotency key, without enabling the channel.

- [x] **Step 6: Verify Task 1 and commit**

```bash
pnpm vitest run \
  packages/work-items/src/session-schema.test.ts \
  packages/session-coordinator/src/delivery.test.ts \
  apps/bridge/src/channel-ingress.test.ts \
  apps/bridge/src/session-api.test.ts \
  apps/integration/session-event-contract.integration.test.ts \
  packages/channel-feishu/src/bridge-lifecycle.test.ts \
  packages/channel-feishu/src/bridge-recovery.test.ts \
  packages/channel-feishu/src/session-watcher.test.ts \
  packages/channel-telegram/src/telegram-bridge.test.ts \
  packages/channel-telegram/src/telegram-session-watcher.test.ts
git diff --check
```

Commit message: `fix(channels): persist thinking presentation snapshot`

## 3. Task 2 — Make queue resume idempotent per command

**Files:**

- Modify `packages/core/src/types.ts`
- Modify `packages/session-coordinator/src/coordinator.ts`
- Modify `apps/bridge/src/session-runtime-api.ts`
- Modify `apps/bridge/src/channel-ingress.ts`
- Modify `packages/channel-feishu/src/bridge.ts`
- Modify `packages/channel-telegram/src/telegram-bridge.ts`
- Test `coordinator.test.ts`, `session-api.test.ts`, `channel-ingress.test.ts`, both channel bridge tests, and router slash tests

- [x] **Step 1: Write the failing repeated-resume tests**

Test this exact sequence:

```text
pause(v1) -> /c(message A) -> ready
retry message A -> cached, no second state transition; handoff may be retried
pause(v2) -> retry message A -> stays paused
/c(message B) -> ready
```

Also assert Feishu sends `feishu:<messageId>` and Telegram sends `telegram:<updateId>`.

- [x] **Step 2: Run the focused tests and confirm RED**

```bash
pnpm vitest run \
  packages/session-coordinator/src/coordinator.test.ts \
  apps/bridge/src/channel-ingress.test.ts \
  apps/bridge/src/session-api.test.ts \
  packages/router/src/slash-commands.test.ts \
  packages/channel-feishu/src/bridge-lifecycle.test.ts \
  packages/channel-telegram/src/telegram-bridge.test.ts
```

- [x] **Step 3: Change the command contract**

```ts
resumeQueue(
  sessionId: string,
  commandId: string,
): Promise<{ queueState: "ready" | "paused" }>;
```

ChannelIngress sends `idempotency-key: resume:${commandId}`. Session ID and runtime version are not command identity.

- [x] **Step 4: Preserve crash-safe at-least-once execution handoff**

Coordinator keeps the persisted idempotency outcome limited to:

```ts
{
  runtime: SessionRuntime;
  dispatched: { turn: SessionTurn; run: Run } | null;
}
```

The API may call `observeExecution` again for a cached `dispatched` Run. This closes the crash window where the transaction committed before the first handoff. `RunExecutor.claimRun` remains the atomic exactly-once execution gate, so a repeated observer cannot duplicate Agent work or side effects.

The API response continues to serialize the current `runtimeView`. A replayed old command must not return its historical `ready` snapshot after the Session has subsequently become paused.

Add a crash-window test: commit the resume outcome without observing it, replay the same HTTP command, and prove the queued Run is claimed and started exactly once. Do not assert that the observer function itself is called only once.

- [x] **Step 5: Verify Task 2 and commit**

```bash
pnpm vitest run \
  packages/session-coordinator/src/coordinator.test.ts \
  apps/bridge/src/channel-ingress.test.ts \
  apps/bridge/src/session-api.test.ts \
  packages/router/src/slash-commands.test.ts \
  packages/channel-feishu/src/bridge-lifecycle.test.ts \
  packages/channel-telegram/src/telegram-bridge.test.ts
pnpm --filter @codebridge/channel-feishu build
pnpm --filter @codebridge/channel-telegram build
pnpm --filter @codebridge/bridge build
git diff --check
```

Commit message: `fix(channels): scope queue resume idempotency to command`

## 4. Task 3 — Persist and transport explicit Run execution identity

**Files:**

- Modify `packages/work-items/src/index.ts`
- Modify `packages/work-items/src/session-schema.ts`
- Modify `packages/work-items/src/session-runtime.ts`
- Modify `packages/work-items/src/session-projector.ts`
- Modify `packages/core/src/session-event-wire.ts`
- Modify `apps/bridge/src/session-runtime-types.ts`
- Modify `apps/bridge/src/session-runtime-api.ts`
- Modify `apps/bridge/src/channel-ingress.ts`
- Modify `packages/core/src/types.ts`
- Modify `packages/router/src/channel-flow-projector.ts`
- Modify `apps/web/src/lib/flow-events.ts`
- Modify Feishu and Telegram watcher tests and all related projector tests

- [x] **Step 1: Write failing Agent-vs-Flow tests**

Required fixtures:

```ts
const agentRun = { executionKind: "agent" };
const publishedFlowRun = { executionKind: "flow" };
const candidateDryRun = { executionKind: "flow" };
```

An Agent `STEP_STARTED/STEP_SUCCEEDED` must not create a Flow block or Flow channel summary. Both Flow fixtures must continue to project, regardless of `Plan.source`.

- [x] **Step 2: Persist `execution_kind` on Run**

```sql
execution_kind TEXT NOT NULL DEFAULT 'agent'
  CHECK (execution_kind IN ('agent', 'flow'))
```

New Runs receive the value explicitly from the resolved invocation carried by the Turn:

```ts
executionKind: turn.message.flowInvocationSource === "none"
  ? "agent"
  : "flow"
```

Do not infer from `Plan.source`: a valid Candidate Runbook can have `agent_generated` provenance. Do not require `work_items.workflow_id`: the Session WorkItem is intentionally reused.

Historical migration sets `flow` only where the stored Run has a non-null `workflow_revision`; all other rows remain `agent`. Partial or invalid new identities fail explicitly.

- [x] **Step 3: Copy the immutable identity onto DomainEvent and the canonical event DTO**

Persist `domain_events.execution_kind` as `agent | flow | null`. When appending a run-scoped event, copy the already-persisted `runs.execution_kind`; a missing Run or invalid value is a contract error. Runless events store `null`. Do not query Plan history or infer identity inside Web/channel consumers.

```ts
execution_kind: "agent" | "flow" | null;
```

Every event with a non-null `run_id` must have a non-null execution kind. Events without a Run use `null`. Finite JSON and live SSE use the same serializer and strict parser.

- [x] **Step 4: Gate only Flow-specific projections**

- Web live and persisted `flow_step`, `flow_run`, and `flow_failure` require `execution_kind=flow`.
- Feishu and Telegram `ChannelFlowProjector` ignore Agent run events.
- `FLOW_BATCH_*` remains independently identifiable.
- Runless `PARAM_RESOLVED` is Flow-specific only when its payload contains non-empty `flow_id` and `flow_revision`; `FLOW_BATCH_*` requires non-empty `flow_id` and `definition_revision`.
- Agent `STEP_*`, generic errors, and Agent permission approval remain valid Runtime events; do not delete or rename them.

- [x] **Step 5: Repair historical false Flow blocks**

Add an idempotent schema repair that deletes only `flow_step`, `flow_run`, and `flow_failure` blocks whose joined Run has `execution_kind='agent'`. Delete their output segments first. Preserve `flow_batch`, runless `flow_param`, and all blocks for Flow Runs; ambiguous parameter history is not deleted without source-event evidence.

Test the dry dataset before/after counts and prove a second run is a no-op.

- [x] **Step 6: Verify Task 3 and commit**

```bash
pnpm vitest run \
  packages/core/src/session-event-wire.test.ts \
  packages/work-items/src/session-schema.test.ts \
  packages/work-items/src/session-projector.test.ts \
  packages/router/src/channel-flow-projector.test.ts \
  apps/bridge/src/session-api.test.ts \
  apps/bridge/src/channel-ingress.test.ts \
  apps/web/src/lib/flow-events.test.ts \
  apps/web/src/lib/session-store.test.ts \
  packages/channel-feishu/src/session-watcher.test.ts \
  packages/channel-telegram/src/telegram-session-watcher.test.ts \
  apps/integration/session-event-contract.integration.test.ts
```

Commit message: `fix(flow): project steps only for explicit flow runs`

## 5. Task 4 — Remove detached Feishu progress messages

**Files:**

- Modify `packages/channel-feishu/src/session-watcher.ts`
- Modify `packages/channel-feishu/src/bridge.ts`
- Modify `packages/channel-feishu/src/session-watcher.test.ts`
- Modify `packages/channel-feishu/src/bridge-stream.test.ts`

- [x] **Step 1: Replace the test that expects a detached reminder**

Advance fake time past ten minutes and assert:

```ts
expect(host.sendMarkdown).not.toHaveBeenCalled();
expect(originalCardContent()).toContain("已运行");
```

Then make the Run terminal and assert the same card contains `✅ 已完成`.

- [x] **Step 2: Remove the second status surface**

Delete `FEISHU_PROGRESS_NOTICE_INTERVAL_MS`, both `noticeTimer` blocks, and notice-only counters. Keep:

- the main 15-second Runtime reconciliation,
- the legacy 15-second same-card status timer,
- permission, error, and queue messages,
- terminal write-before-Delivery-complete ordering.

- [x] **Step 3: Verify Task 4 and commit**

```bash
pnpm vitest run \
  packages/channel-feishu/src/session-watcher.test.ts \
  packages/channel-feishu/src/bridge-stream.test.ts \
  packages/channel-feishu/src/bridge-recovery.test.ts
pnpm --filter @codebridge/channel-feishu build
git diff --check
```

Commit message: `fix(feishu): keep run status on one card`

## 6. Task 5 — Full verification and live Feishu acceptance

- [x] **Step 1: Run the complete affected test matrix**

```bash
pnpm vitest run \
  packages/core/src/session-event-wire.test.ts \
  packages/work-items/src/session-schema.test.ts \
  packages/work-items/src/session-projector.test.ts \
  packages/session-coordinator/src/coordinator.test.ts \
  packages/session-coordinator/src/delivery.test.ts \
  packages/router/src/channel-flow-projector.test.ts \
  packages/router/src/slash-commands.test.ts \
  apps/bridge/src/session-api.test.ts \
  apps/bridge/src/channel-ingress.test.ts \
  apps/web/src/lib/api.test.ts \
  apps/web/src/lib/flow-events.test.ts \
  apps/web/src/lib/session-store.test.ts \
  packages/channel-feishu/src/session-watcher.test.ts \
  packages/channel-feishu/src/bridge-lifecycle.test.ts \
  packages/channel-feishu/src/bridge-stream.test.ts \
  packages/channel-feishu/src/bridge-recovery.test.ts \
  packages/channel-telegram/src/telegram-bridge.test.ts \
  packages/channel-telegram/src/telegram-session-watcher.test.ts \
  apps/integration/session-event-contract.integration.test.ts
```

- [x] **Step 2: Build all affected packages**

```bash
pnpm --filter @codebridge/core build
pnpm --filter @codebridge/work-items build
pnpm --filter @codebridge/session-coordinator build
pnpm --filter @codebridge/router build
pnpm --filter @codebridge/channel-feishu build
pnpm --filter @codebridge/channel-telegram build
pnpm --filter @codebridge/bridge build
pnpm --filter @codebridge/web build
```

- [x] **Step 3: Run pre-commit gates**

```bash
git diff --check
npx gitnexus detect-changes --repo CodeBridge --scope staged
```

Review the changed symbols and affected processes before every commit; HIGH/CRITICAL changes must remain within the declared Session/Channel/Flow projection paths.

- [x] **Step 4: Rebuild and restart Bridge**

```bash
bash scripts/start.sh restart
bash scripts/start.sh status
tail -n 200 /Users/keliang/.codebridge/bridge.log
```

Verify ports 19790/19789 are healthy, the Bridge log contains the current startup timestamp plus the Feishu connection/reconciler startup, and no schema migration or recovery loop error appears.

- [x] **Step 5: Perform real Feishu acceptance**

1. `/thinking off` → start a Run → restart Bridge → no thought/tool payload appears; the persisted card keeps the presentation snapshot and converges to the authoritative terminal state. Because the executor currently lives in Bridge, an in-flight Run interrupted by process restart terminates as `lease_expired_unknown_outcome` rather than continuing execution.
2. Run an ordinary Agent task that emits `STEP_*` → no `0 / 1` Flow summary or raw `run_*` step label appears.
3. Advance both modern and legacy renderers beyond the old ten-minute reminder boundary with fake time → no detached message is sent; the original card continues updating and becomes terminal.
4. Pause → `/c` → pause again → send a new `/c` → both commands restore the queue.

Telegram remains `implemented + contract-tested`, not `reachable/closed-loop`, until the user enables it; retain this as a release reminder.

## 7. Execution record

- Baseline event wire: `6297ef9`
- Delivery presentation snapshot: `6633165`
- Queue resume command identity: `21db40a`
- Runtime execution identity: `345b5f6`
- Web/channel projection gates: `cfcb01a`
- Historical false projection cleanup: `9edecdd`
- Single Feishu status card: `084dbf9`
- Verification: 28 test files / 491 tests passed; Core, Work Items, Session Coordinator, Run Executor, Router, Feishu, Telegram, Bridge, and Web production builds passed.
- Production migration: `agent=579`, `flow=10`; false Agent Flow blocks remaining `0`; legitimate `flow_step=16`, `flow_param=5`, `flow_run=4`, and `flow_batch=9` retained.
- Live Feishu: `/thinking off` persisted across Bridge restart; a normal Agent Run returned `execution-kind-smoke-ok` without Flow summary; two distinct `/c` commands on the same Session both restored the queue.
- Backup: `/Users/keliang/.codebridge/backups/orchestration-before-execution-kind-20260825T1250.sqlite`.
