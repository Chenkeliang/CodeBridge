# Session Event Wire Contract Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Web and channel real-time events plus finite terminal replay by making one snake_case Session event DTO the only API contract, with no camelCase compatibility path.

**Architecture:** Keep internal `DomainEvent` camelCase. Serialize every public Session event through one `SessionEventWire` mapper. The live endpoint transports that DTO as SSE; the finite endpoint transports the same DTO in paginated JSON. Channel ingress parses each transport independently and rejects content-type/schema mismatches.

**Tech Stack:** TypeScript, Hono, SQLite-backed work-items, SSE, Vitest, Feishu session watcher.

---

## 0. Locked invariants

- No dual-read compatibility for `runId`/`run_id` or JSON/SSE.
- Exactly one `/v1/sessions/:session_id/events` route is registered.
- `DomainEvent` never crosses an HTTP/SSE boundary directly.
- Live events use `text/event-stream`; finite history uses `application/json` pagination.
- Both transports carry the same snake_case `SessionEventWire` payload.
- Contract violations fail explicitly; they never become an empty replay or `runId: null` through missing-field coercion.
- Telegram remains disabled but shares the repaired ingress contract.
- Do not modify or stage unrelated dirty files.

## 1. File map

- Create `packages/core/src/session-event-wire.ts`: own the canonical Session event wire DTO and strict parser.
- Modify `apps/bridge/src/session-runtime-types.ts`: serialize internal Domain events into the canonical DTO.
- Modify `apps/bridge/src/session-runtime-api.ts`: serialize finite JSON and live SSE through the canonical mapper.
- Modify `apps/bridge/src/session-api.ts`: remove the duplicate Session events route and its private serializers.
- Modify `apps/bridge/src/channel-ingress.ts`: strict SSE parsing for live events and strict paginated JSON parsing for replay.
- Modify `apps/bridge/src/session-api.test.ts`: lock one canonical route and snake_case payloads for both transports.
- Modify `apps/bridge/src/channel-ingress.test.ts`: lock transport mismatch errors and remove the false finite-SSE fixture.
- Modify `apps/web/src/lib/api.ts`: consume the same strict DTO from live SSE and reject transport/schema mismatches.
- Create `apps/integration/session-event-contract.integration.test.ts`: exercise real Session app → Channel ingress → Feishu watcher paths.

## 2. Task 1 — Reproduce the contract split

- [x] Add a Session API test asserting that finite history returns `application/json`, contains `run_id`, and contains no `runId`.
- [x] Add a live SSE test asserting that the `data:` frame contains `run_id`, `occurred_at`, and `result_ref`, and contains no camelCase transport fields.
- [x] Replace the finite replay fixture with JSON pagination and assert that an SSE response is rejected for replay.
- [x] Add a live-ingress test asserting that JSON is rejected for `events()`.
- [x] Run the focused tests and confirm they fail against the current mixed contract.

Run:

```bash
pnpm vitest run apps/bridge/src/session-api.test.ts apps/bridge/src/channel-ingress.test.ts
```

Expected RED: live Session SSE still exposes camelCase, and replay still assumes SSE.

## 3. Task 2 — Establish the only wire DTO and route

- [x] Add `SessionEventWire` to Core and `toApiSessionEvent(event)` in `session-runtime-types.ts` with all keys explicitly snake_case.
- [x] Use that mapper for every live SSE `data:` frame and every finite JSON event.
- [x] Delete the later duplicate `/events` route from `session-api.ts` plus its orphaned serializers/imports.
- [x] Verify only one production route registration remains with `rg`.
- [x] Run Session API tests and confirm GREEN.

Contract:

```ts
interface SessionEventWire {
  schema_version: number;
  event_id: string;
  sequence: number;
  work_item_id: string;
  run_id: string | null;
  type: string;
  occurred_at: string;
  actor: string;
  target: string | null;
  input_hash: string | null;
  result_ref: string | null;
  payload: Record<string, unknown>;
}
```

## 4. Task 3 — Separate live and replay transports

- [x] Make `events()` require `text/event-stream` before reading frames.
- [x] Make `replayEvents()` require `application/json`, parse `{ events, next_sequence, has_more }`, and follow pages until `has_more` is false.
- [x] Validate the required snake_case wire fields without reading camelCase alternatives.
- [x] Raise stable errors `session_event_transport_mismatch` and `session_event_schema_mismatch`.
- [x] Cancel the underlying SSE stream when its consumer exits or its abort signal fires.
- [x] Run Channel ingress tests and confirm GREEN.

## 5. Task 4 — Prove the active Feishu surface chain

- [x] Build an in-memory real `createSessionApp` with a persisted work item and Session.
- [x] Assert `createChannelSessionIngress.events()` receives the real live `AGENT_EVENT` and `RUN_SUCCEEDED` with the correct `runId`.
- [x] Assert Bridge-triggered `replayEvents()` returns the same persisted events through finite JSON.
- [x] Feed the real ingress into `FeishuBridge`, verify both resumed and live cards receive final text, and verify terminal Delivery completion.
- [x] Run the integration test and all focused Feishu tests.

Run:

```bash
pnpm vitest run \
  apps/integration/session-event-contract.integration.test.ts \
  apps/bridge/src/channel-ingress.test.ts \
  packages/channel-feishu/src/session-watcher.test.ts \
  packages/channel-feishu/src/bridge-recovery.test.ts
```

## 6. Task 5 — Full verification and active recovery

- [x] Run Bridge, Web, core channel, Feishu, and Telegram relevant tests.
- [x] Build all dependent packages, including `channel-feishu`, before Bridge.
- [x] Run lint and `git diff --check`.
- [x] Run GitNexus change detection and verify only Session event transport/consumer flows changed.
- [x] Restart Bridge and verify the active process build timestamps are current.
- [x] Verify the stuck Run remains the original Run, its card is updated from persisted events, and its Delivery transitions from `delivering` to `completed`.
- [x] Independently verify Web event streaming; do not infer it from Feishu.

## 7. Completion Surface Matrix

| Surface | Entry | Read path | Write path | Event consumption | Error/recovery | Terminal feedback |
|---|---|---|---|---|---|---|
| Web | active Workbench | composite snapshot + live SSE | existing message APIs | canonical wire DTO | schema/transport rejection + snapshot refresh | active timeline/result |
| Agent/Runtime | existing Run | SQLite DomainEvent | unchanged | fact source | unchanged | persisted terminal event |
| Feishu | active Run card | Channel ingress live/replay | CardKit update | normalized channel DTO | finite JSON replay | original card + completed Delivery |
| Telegram | disabled | repaired shared ingress | disabled | contract tests only | planned enablement later | not claimed closed-loop |
