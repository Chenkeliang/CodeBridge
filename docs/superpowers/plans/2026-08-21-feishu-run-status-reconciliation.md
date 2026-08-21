# Feishu Run Status Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Feishu run card converge to the authoritative Runtime Run state after quiet periods, Core SSE reconnects, Feishu WebSocket reconnects, card write failures, and Bridge restarts, without duplicating the Runtime state machine or completing Delivery before the projected terminal card is durably visible.

**Architecture:** Extend the existing Delivery read model with a nullable nested Runtime Run snapshot, then add one Bridge-owned single-flight reconciler that refreshes all unfinished Feishu deliveries on connect, every 15 seconds, and after WebSocket reconnect. `FeishuSessionWatcher` remains the only production card owner: Run snapshots correct status immediately, while Session event replay remains responsible for final body projection and the only path allowed to complete Delivery.

**Tech Stack:** TypeScript, SQLite, Hono, Vitest, existing `ChannelSessionIngress`, Feishu WebSocket/HTTP SDK, GitNexus.

---

## 0. Locked boundaries and risk gates

- Runtime Run status is read-only to the Feishu adapter. Do not modify the Run state machine, Lease timings, `SessionRecoveryService`, or `RunHeartbeat`.
- `ChannelDeliveryRow.runSnapshot` is a nested nullable read model. Do not flatten Runtime fields into Delivery status.
- The reconciler belongs only to the `ChannelSessionIngress` production path. Do not add a second loop to `streamAgentReply` legacy fallback.
- A terminal Run snapshot may stop the timer and correct the card title, but it may not complete Delivery. Completion requires the terminal event to have been replayed/projected and the terminal card write to have succeeded.
- A permanently invalid card is suppressed in process memory and logged once. Bridge restart may probe it once again. No fallback message, database column, outbox, or exactly-once claim is added.
- Telegram receives only compile/contract regression coverage. Telegram runtime activation remains deferred until credentials are configured.
- GitNexus pre-edit impact: `FeishuSessionWatcher` and `renderFeishuRunStatus` are **CRITICAL** because they participate in dispatch, connect, recovery, stream, and menu flows. `FeishuBridge` and Delivery mapping are LOW. Stop if implementation touches unexpected Runtime execution flows.

## 1. File map

### Shared contract and read model

- Modify `packages/core/src/types.ts`: add the transport-neutral Delivery Run snapshot type and `runSnapshot` field.
- Modify `packages/work-items/src/session-runtime.ts`: join unfinished Delivery rows to `runs` and `session_runtime`, then map the nested snapshot.
- Modify `packages/work-items/src/session-runtime.test.ts`: lock joined/null snapshot behavior and no-schema-change behavior.
- Modify `packages/session-coordinator/src/delivery.test.ts`: retain claim/ack/complete invariants with the extended row.
- Modify `apps/bridge/src/session-api.test.ts`: lock the JSON contract.
- Modify `apps/bridge/src/channel-ingress.test.ts`: lock client mapping and Telegram-compatible optionality.

### Feishu reconciliation and presentation

- Create `packages/channel-feishu/src/delivery-reconciler.ts`: own single-flight/coalesced triggers and the 15-second timer.
- Create `packages/channel-feishu/src/delivery-reconciler.test.ts`: fake-timer tests for connect/tick/reconnect/disconnect and coalescing.
- Modify `packages/channel-feishu/src/run-status.ts`: separate Runtime status, Core SSE, inbound WebSocket, HTTP write health, task activity, and verification time.
- Modify `packages/channel-feishu/src/run-status.test.ts`: table-driven rendering and terminal precedence.
- Modify `packages/channel-feishu/src/session-watcher.ts`: reconcile Delivery snapshots, restore terminal status safely, classify write failures, and preserve terminal-event completion.
- Modify `packages/channel-feishu/src/session-watcher.test.ts`: restart, race, transient/permanent write failure, and SSE state tests.
- Modify `packages/channel-feishu/src/bridge.ts`: replace one-shot recovery with the reconciler and wire WebSocket lifecycle callbacks.
- Modify `packages/channel-feishu/src/bridge-lifecycle.test.ts`: verify immediate reconnect reconciliation and timer cleanup.
- Modify `packages/channel-feishu/src/bridge-recovery.test.ts`: verify terminal restart recovery.
- Modify `packages/channel-feishu/src/bridge-stream.test.ts`: remove the false “任务连接保持” contract and retain legacy regressions.
- Modify `packages/channel-telegram/src/telegram-session-watcher.test.ts`: ensure the extended Delivery row does not alter Telegram projection.

## 2. Task 1 — Add the authoritative Delivery Run snapshot

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/work-items/src/session-runtime.ts`
- Test: `packages/work-items/src/session-runtime.test.ts`
- Test: `packages/session-coordinator/src/delivery.test.ts`
- Test: `apps/bridge/src/session-api.test.ts`
- Test: `apps/bridge/src/channel-ingress.test.ts`

- [ ] **Step 1: Write failing store and API tests**

Create one unfinished Delivery for a running Run and assert:

```ts
expect(store.listDeliveries("feishu")[0]?.runSnapshot).toEqual({
  status: "running",
  createdAt: expect.any(String),
  updatedAt: expect.any(String),
  leaseExpiresAt: expect.any(String),
  terminalReason: null,
  sessionActiveRunId: run.id,
  sessionQueueState: "ready",
});
```

Also assert a pending Delivery without `run_id` returns `runSnapshot: null`, a terminal Run returns its terminal reason, and `/v1/deliveries` plus `ChannelSessionIngress.listDeliveries()` preserve the nested shape.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
pnpm vitest run packages/work-items/src/session-runtime.test.ts packages/session-coordinator/src/delivery.test.ts apps/bridge/src/session-api.test.ts apps/bridge/src/channel-ingress.test.ts
```

Expected: FAIL because `ChannelDeliveryRow` has no `runSnapshot` and `listDeliveries` selects only Delivery columns.

- [ ] **Step 3: Add the shared read-model type**

Add to `packages/core/src/types.ts`:

```ts
export type ChannelRuntimeRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface ChannelDeliveryRunSnapshot {
  status: ChannelRuntimeRunStatus;
  createdAt: string;
  updatedAt: string;
  leaseExpiresAt: string | null;
  terminalReason: string | null;
  sessionActiveRunId: string | null;
  sessionQueueState: "ready" | "paused";
}
```

Add `runSnapshot: ChannelDeliveryRunSnapshot | null` to `ChannelDeliveryRow`.
Update existing Delivery literals/test doubles across Feishu, Telegram, Bridge, and
Coordinator tests with `runSnapshot: null` unless the test explicitly exercises a Run.

- [ ] **Step 4: Join the authoritative rows without changing schema**

Change the transaction query to select `d.*` plus aliased Run/Session fields:

```sql
SELECT d.*,
       r.status AS run_snapshot_status,
       r.created_at AS run_snapshot_created_at,
       r.updated_at AS run_snapshot_updated_at,
       r.lease_expires_at AS run_snapshot_lease_expires_at,
       r.terminal_reason AS run_snapshot_terminal_reason,
       sr.active_run_id AS run_snapshot_active_run_id,
       sr.queue_state AS run_snapshot_queue_state
FROM channel_turn_delivery d
LEFT JOIN runs r ON r.id = d.run_id
LEFT JOIN session_runtime sr ON sr.session_id = d.session_id
WHERE d.channel = ? AND d.status != 'completed'
ORDER BY d.accepted_sequence ASC
```

Map `runSnapshot` to `null` when `run_snapshot_status` is null. Validate the status and queue-state unions before returning; do not silently coerce an unknown database value.

- [ ] **Step 5: Re-run focused tests and confirm GREEN**

Run the Step 2 command. Expected: PASS.

## 3. Task 2 — Separate Runtime and transport presentation state

**Files:**
- Modify: `packages/channel-feishu/src/run-status.ts`
- Test: `packages/channel-feishu/src/run-status.test.ts`

- [ ] **Step 1: Write table-driven rendering tests**

Cover:

```text
running + connected + recent event      -> 🟢 执行中
running + connected + quiet             -> 🟠 任务运行中 · 暂无新事件
running + core reconnecting              -> ⚠️ 事件流重连中 · 后台任务仍在运行
running + verification unavailable       -> ⚠️ 暂时无法核验任务状态
succeeded/failed/cancelled/interrupted   -> terminal title regardless of transport
```

Assert rendered text contains separate “最近任务事件” and “最近状态核验”, never contains “任务连接保持”, and uses snapshot `createdAt/updatedAt` after a restart.

- [ ] **Step 2: Run the status test and confirm RED**

Run:

```bash
pnpm vitest run packages/channel-feishu/src/run-status.test.ts
```

Expected: FAIL on the old quiet title and missing verification/transport state.

- [ ] **Step 3: Implement pure status transitions**

Keep the public model explicit:

```ts
export type FeishuConnectionState = "connected" | "reconnecting" | "unavailable";
export type FeishuHttpWriteState = "healthy" | "degraded" | "unavailable";

export interface FeishuTransportSnapshot {
  coreEventStream: FeishuConnectionState;
  feishuInboundWebSocket: FeishuConnectionState;
  feishuHttpWrite: FeishuHttpWriteState;
}

export function applyRunSnapshot(
  status: FeishuRunStatus,
  snapshot: ChannelDeliveryRunSnapshot,
  now?: number,
): boolean;
export function recordRunVerification(status: FeishuRunStatus, now?: number): void;
export function setCoreEventStream(status: FeishuRunStatus, state: FeishuConnectionState): void;
export function setInboundWebSocket(status: FeishuRunStatus, state: FeishuConnectionState): void;
export function setHttpWrite(status: FeishuRunStatus, state: FeishuHttpWriteState): void;
```

`applyRunSnapshot` maps queued/running/waiting to live display and terminal statuses to immutable terminal state. A later live snapshot must return `false` and must not reverse a terminal state.

- [ ] **Step 4: Re-run status tests and confirm GREEN**

Run the Step 2 command. Expected: PASS.

## 4. Task 3 — Add one Bridge-owned single-flight reconciler

**Files:**
- Create: `packages/channel-feishu/src/delivery-reconciler.ts`
- Create: `packages/channel-feishu/src/delivery-reconciler.test.ts`
- Modify: `packages/channel-feishu/src/bridge.ts`
- Test: `packages/channel-feishu/src/bridge-lifecycle.test.ts`

- [ ] **Step 1: Write reconciler lifecycle tests**

Use fake timers and a deferred first pass. Assert:

- `start()` triggers one immediate pass and one pass per 15-second tick;
- two triggers while a pass is running coalesce into exactly one follow-up pass;
- `reconnected` can call `trigger()` immediately;
- `stop()` clears the timer and prevents later ticks;
- failures log once per pass and do not kill later reconciliation.

- [ ] **Step 2: Run the new tests and confirm RED**

Run:

```bash
pnpm vitest run packages/channel-feishu/src/delivery-reconciler.test.ts packages/channel-feishu/src/bridge-lifecycle.test.ts
```

Expected: FAIL because the reconciler does not exist and reconnect only logs.

- [ ] **Step 3: Implement the isolated coordinator**

Create:

```ts
export class FeishuDeliveryReconciler {
  constructor(options: {
    intervalMs: number;
    reconcile(): Promise<void>;
    onError(error: unknown): void;
  });
  start(): void;
  trigger(): Promise<void>;
  stop(): void;
}
```

`trigger()` owns `inFlight` and `rerunRequested`; it never runs two passes concurrently. Use `unref()` on the interval.

- [ ] **Step 4: Wire Bridge lifecycle and retain one card owner**

Rename the old `recoverDeliveries()` behavior to `reconcileDeliveries()`. On every pass, group current unfinished rows by Session, call `ensureSessionWatcher()`, reconcile each Delivery idempotently, and start a watcher only once from the minimum accepted sequence.

Wire:

```text
channel.connect() success -> inbound connected -> reconciler.start()
reconnecting              -> inbound reconnecting on every watcher
reconnected               -> inbound connected -> reconciler.trigger()
disconnect                -> reconciler.stop() before watcher abort
```

Do not touch `streamAgentReply`.

- [ ] **Step 5: Re-run lifecycle tests and confirm GREEN**

Run the Step 2 command. Expected: PASS.

## 5. Task 4 — Reconcile SessionWatcher without reversing terminal state

**Files:**
- Modify: `packages/channel-feishu/src/session-watcher.ts`
- Test: `packages/channel-feishu/src/session-watcher.test.ts`
- Modify: `packages/channel-feishu/src/bridge-recovery.test.ts`

- [ ] **Step 1: Write restart and race failure tests**

Cover these sequences:

1. Delivery snapshot is `succeeded` before `resumeCardForRun`: the first restored card is terminal and no live timer is created.
2. Snapshot terminal arrives before historical events: status changes immediately, but `completeDelivery` is not called until the terminal event is replayed.
3. SSE terminal and reconciler terminal race: one terminal card write and one idempotent completion.
4. Terminal snapshot followed by stale running snapshot: card stays terminal.
5. `sessionActiveRunId` differs for a running/waiting Run: render unavailable/inconsistent warning, not green running.
6. SSE iterator failure marks Core SSE reconnecting; successful reconnection marks connected without changing Runtime status.

- [ ] **Step 2: Run watcher tests and confirm RED**

Run:

```bash
pnpm vitest run packages/channel-feishu/src/session-watcher.test.ts packages/channel-feishu/src/bridge-recovery.test.ts
```

Expected: FAIL because resume always creates a fresh running timer and no snapshot API exists.

- [ ] **Step 3: Add an idempotent Delivery reconciliation entry**

Expose one watcher method:

```ts
async reconcileDelivery(
  delivery: ChannelDeliveryRow,
  turn: PendingTurn,
  inboundState: FeishuConnectionState,
): Promise<void>;
```

Rules:

- no `runId`: register the pending Turn only;
- `runId + no surfaceMessageId`: claim/open once;
- `runId + surfaceMessageId`: create one resumed-card record or update its Run snapshot;
- initialize `startedAt/endedAt` from Run snapshot dates;
- terminal snapshot clears the render timer and writes a terminal status card, but sets `terminalEventObserved = false` until replay;
- when the Run already has a live `FeishuRunCard`, apply the same Run/transport snapshot through card methods; do not maintain a second status object in the watcher;
- only the terminal event handler sets `terminalEventObserved = true`, flushes the projected final card, and calls `completeDelivery`;
- terminal transitions are serialized per Run and first-wins.

- [ ] **Step 4: Track Core SSE and transport states independently**

Before each `for await` attempt, mark the Core stream connected; on an exception mark reconnecting, render a status-only update, wait 250 ms, then retry from the unchanged sequence. Successful event handling alone advances the cursor.

Bridge WebSocket state updates every live/resumed status model but never changes Runtime state. HTTP write results update only `feishuHttpWrite`.

- [ ] **Step 5: Re-run watcher tests and confirm GREEN**

Run the Step 2 command. Expected: PASS.

## 6. Task 5 — Make terminal card writes observable and recoverable

**Files:**
- Modify: `packages/channel-feishu/src/session-watcher.ts`
- Modify: `packages/channel-feishu/src/bridge.ts`
- Test: `packages/channel-feishu/src/session-watcher.test.ts`
- Test: `packages/channel-feishu/src/bridge-stream.test.ts`

- [ ] **Step 1: Write transient/permanent failure tests**

Assert:

- transient terminal `setContent`/`updateCard` failure does not complete Delivery and succeeds on replay/reconciliation retry;
- error text/code containing the known invalid-card signal (`11310` or `cardid invalid`) marks that `surfaceMessageId` permanently invalid for the process;
- permanent invalid advances the Session event cursor so one dead card cannot block later runs, but keeps Delivery unfinished;
- the permanent structured warning is emitted once per process and periodic reconciliation does not retry it;
- after constructing a new Bridge/watcher (simulated restart), the same Delivery is probed once again;
- an old status-only write can never overwrite a queued terminal snapshot.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
pnpm vitest run packages/channel-feishu/src/session-watcher.test.ts packages/channel-feishu/src/bridge-stream.test.ts
```

Expected: FAIL because `FeishuRunCard` currently swallows content-write errors and the watcher has no permanent-failure classification.

- [ ] **Step 3: Add explicit write-failure semantics**

Add a small classifier in `session-watcher.ts`:

```ts
export function classifyFeishuCardWriteError(error: unknown): "transient" | "permanent" {
  const text = error instanceof Error ? error.message : String(error);
  return /11310|card\s*id\s*invalid|cardid\s*invalid/i.test(text)
    ? "permanent"
    : "transient";
}
```

`FeishuRunCard.finalize()` must surface the latest terminal write failure instead of setting `done`; replay may retry transient failures. The watcher records permanent invalid message IDs, logs a structured line containing channel/session/run/message/error class once, leaves Delivery unfinished, removes active retry timers, and allows the event cursor to advance.

- [ ] **Step 4: Remove false connectivity wording**

Replace “任务连接保持” and “会话仍连接” with the accepted status contract. Keep ordinary Agent/legacy rendering behavior otherwise unchanged.

- [ ] **Step 5: Re-run focused tests and confirm GREEN**

Run the Step 2 command. Expected: PASS.

## 7. Task 6 — Adversarial, cross-surface, and live verification

**Files:**
- Modify: `packages/channel-telegram/src/telegram-session-watcher.test.ts`
- Modify: `docs/superpowers/plans/2026-08-21-feishu-run-status-reconciliation.md`

- [ ] **Step 1: Run the focused contract matrix**

Run:

```bash
pnpm vitest run \
  packages/work-items/src/session-runtime.test.ts \
  packages/session-coordinator/src/delivery.test.ts \
  apps/bridge/src/session-api.test.ts \
  apps/bridge/src/channel-ingress.test.ts \
  packages/channel-feishu/src/delivery-reconciler.test.ts \
  packages/channel-feishu/src/run-status.test.ts \
  packages/channel-feishu/src/session-watcher.test.ts \
  packages/channel-feishu/src/bridge-lifecycle.test.ts \
  packages/channel-feishu/src/bridge-recovery.test.ts \
  packages/channel-feishu/src/bridge-stream.test.ts \
  packages/channel-telegram/src/telegram-session-watcher.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run static and full repository gates**

Run:

```bash
rg -n "任务连接保持|会话仍连接" packages/channel-feishu/src
pnpm test
pnpm lint
pnpm build
git diff --check
```

Expected: no production false-connectivity string; 0 test failures; lint 0 errors; build exit 0; diff check clean.

- [ ] **Step 3: Run GitNexus change detection before commit**

Stage only this plan’s files, then run:

```bash
npx gitnexus detect-changes --repo CodeBridge --scope staged
```

Expected: Delivery read model, Feishu connect/recovery/stream processes, and Telegram contract tests only. Any Run executor/Lease mutation is a stop condition.

- [ ] **Step 4: Commit the implementation slice**

Commit message:

```text
fix(feishu): reconcile run cards with runtime state
```

Do not stage user-owned `AGENTS.md`, local tooling directories, output artifacts, or unrelated drafts.

- [ ] **Step 5: Restart and perform read-only production smoke**

Run `bash scripts/start.sh restart`, verify ports 19790/19789, Bridge logs show Feishu enabled, and the reconciler starts without duplicate timers or errors.

- [ ] **Step 6: Perform real Feishu fault verification with Computer Use**

After action-time confirmation before sending a real Feishu message, run a bounded low-risk task in the user’s test conversation and verify:

- live card and `/status` agree;
- quiet text never claims a connection merely from elapsed time;
- a controlled Bridge restart restores the same card from persisted Run state;
- terminal card stops elapsed time and Delivery completes only after final content is present.

Do not stop Runner or simulate a 90-second Lease interruption on a Session with unrelated active work. Use test fixtures for destructive fault injection unless the user authorizes a dedicated real Run.

## 8. Completion Surface Matrix

Before marking complete, record actual results for Web, Agent, Feishu, and Telegram across entry, read path, write path, event consumption, error handling, recovery, terminal feedback, and deployment state. Telegram must remain `implemented / deployment disabled`, not `reachable`.

## 9. Plan self-review

- Spec coverage: FRSR-2 through FRSR-6 each has a task; FRSR-1 is satisfied by accepted commits `fc2f631` and `dbe83b6`.
- Type consistency: all layers use `ChannelDeliveryRow.runSnapshot`; Feishu status uses separate Runtime and transport fields.
- Completion safety: a Run snapshot cannot complete Delivery; terminal event projection plus successful terminal write is mandatory.
- Scope: no Runtime state mutation, no schema migration, no Telegram UI, no fallback outbox.
- Placeholder scan: no TBD/TODO or undefined endpoint remains.
