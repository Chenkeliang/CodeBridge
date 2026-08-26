# Flow Save Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every canonical pending Flow Save Intent discoverable and actionable from `Web → Flows → 待生成`, even when Web is currently showing another Agent or Session, without writing an unconfirmed record to the Flow Catalog.

**Architecture:** Add one indexed, read-only Event Store query over canonical `FLOW_SAVE_*` events, enrich valid pending requests with Session metadata in a Bridge-owned inbox service, and expose them through a strict paginated API. Web owns polling, navigation, and command UI; it renders pending requests beside Catalog Flows but never inserts them into the Catalog. Existing confirm/dismiss commands remain the only write paths. Feishu and Telegram only refine their existing notice to point at the reachable Web destination.

**Tech Stack:** TypeScript, Hono, SQLite, React 18, Tailwind CSS, Vitest/jsdom, Playwright, Feishu CardKit, Telegram Bot API, GitNexus.

**Canonical design:** `docs/superpowers/specs/2026-08-26-flow-save-inbox-design.md`

---

## 0. Locked contracts, review decisions, and risk gates

### 0.1 Domain identity

| Object | Truth source | Appears in Flow Catalog? | May mutate Catalog? |
|---|---|---:|---:|
| Pending Save Intent | canonical `FLOW_SAVE_REQUESTED` without a later terminal event | No | No |
| Dismissed/failed Save Intent | canonical terminal event | No | No |
| Candidate | `FlowCatalogStore` plus `FLOW_CANDIDATE_CREATED` | Yes | Yes, only through existing confirm |

The `待生成` group is a read surface over Save Intent events. It must not fabricate a `FlowRecord`, use a fake Catalog status, write a Timeline block, repair events, or create a Candidate while reading.

### 0.2 Pending query identity and cursor

`domain_events.sequence` is unique only inside one WorkItem. It is not a global Session cursor. The inbox uses the stable descending tuple:

```text
(occurred_at DESC, event_id DESC)
```

The HTTP cursor is an opaque Base64URL JSON value containing exactly `occurred_at` and `event_id`. The Event Store accepts a parsed tuple; it does not know HTTP encoding. A request's own `event_sequence` remains in the response for audit and per-request identity only.

The SQL predicate for the next page is:

```sql
requested.occurred_at < :occurred_at
OR (
  requested.occurred_at = :occurred_at
  AND requested.event_id < :event_id
)
```

### 0.3 Session deletion decision

If the Session referenced by a pending request no longer exists:

- preserve the canonical `FLOW_SAVE_REQUESTED` event as audit evidence;
- omit the request from the global inbox;
- emit one structured warning per read operation and request:

```json
{
  "code": "flow_save_pending_session_missing",
  "request_id": "fsr_...",
  "session_id": "sess_..."
}
```

- append no terminal event, create no Candidate, and do not invent a replacement Session.

This is deliberately not a cross-store deletion saga. A later historical-inbox feature may expose orphaned audit evidence, but V1 does not promise it.

### 0.4 Concrete index and query boundary

WFI-1 adds exactly:

```sql
CREATE INDEX IF NOT EXISTS domain_events_flow_save_inbox
  ON domain_events (type, occurred_at DESC, event_id DESC);
```

The global query scans `FLOW_SAVE_REQUESTED` through this index and excludes terminal events using `NOT EXISTS` on the same `work_item_id` and `target`, with `terminal.sequence > requested.sequence`. Existing `domain_events_target_sequence(target, sequence)` supports that exclusion. The same statement uses `LEFT JOIN` to return WorkItem, request Run/Turn, and source Run/Turn identity evidence; malformed relationships remain visible to the Bridge service so it can fail closed and warn instead of silently disappearing.

Session enrichment is one `SessionCatalogStore.listSessions(undefined, { includeArchived: true })` call per inbox page. No per-event Session, WorkItem, Run, Turn, target-event, or Catalog query is allowed.

### 0.5 Agent display-name mapping

The API returns the stable `agent_id`, not a duplicated display name. Workbench maps it through its already-loaded `AgentProfile[]`:

```ts
const agentName = agents.find((agent) => agent.agent_id === request.agent_id)
  ?.display_name ?? request.agent_id;
```

Unknown Agent IDs remain visible as their raw ID. They are not dropped or guessed.

### 0.6 Polling and immediate-refresh contract

Web owns one monotonic request generation, one `AbortController`, and one timer:

- mount, entering Flows, manual refresh, confirm/dismiss success, and `visibilitychange → visible` start an immediate generation;
- periodic refresh runs no more often than every 15 seconds;
- a periodic request never starts while another periodic request is active;
- an immediate refresh aborts an in-flight periodic request before it starts the new request;
- only the latest generation may commit `requests`, `next_cursor`, or error state;
- a stale response may neither replace newer data nor clear a newer error;
- an `AbortError` from a superseded request is not shown as a list failure;
- after an immediate refresh settles, clear and schedule the next timer from that settlement point.

Do not compare event sequences across WorkItems. Do not let a timer callback directly mutate UI state without a generation check. The abort controller enforces one in-flight network request; generation remains the second guard for a response that settles at the abort boundary.

### 0.7 HTTP contract

```http
GET /v1/flow-save-requests?state=pending&limit=50&cursor=<opaque>
Authorization: Bearer <token>
```

- `state` is required to equal `pending`; otherwise `400 { error: "flow_save_request_state_invalid" }`.
- `limit` defaults to 50 and is an integer in `[1, 100]`; otherwise `400 { error: "flow_save_request_limit_invalid" }`.
- a malformed, extra-key, non-string, or non-canonical cursor returns `400 { error: "flow_save_request_cursor_invalid" }`.
- missing Event Store/Session Catalog returns `503 { error: "flow_save_inbox_unavailable" }`.
- the endpoint is GET-only and writes zero events, Timeline blocks, Sessions, or Catalog records.

Response fields are snake_case and include `user_message` separately from `source_title`:

```ts
interface FlowSaveInboxItem {
  request_id: string;
  session_id: string;
  agent_id: string;
  session_title: string | null;
  request_turn_id: string;
  request_run_id: string;
  source_turn_id: string;
  source_run_id: string;
  source_title: string;
  source: "agent_intent" | "turn_action";
  user_message: string;
  source_imported: boolean;
  intent_summary: string | null;
  name_hint: string | null;
  created_at: string;
  event_sequence: number;
}

interface FlowSaveInboxPage {
  requests: FlowSaveInboxItem[];
  next_cursor: string | null;
}
```

### 0.8 UI and navigation contract

- The Flows rail icon shows `N` or `99+` and an accessible label such as `3 个待生成 Flow 请求`.
- Flows sidebar order is `待生成`, `候选`, `已发布`, `草稿`, `已停用`.
- Clicking a pending item opens its detail in the Flow main area without changing selected Agent or Session.
- `查看来源 Session` is the only action that changes Agent/Session; it must locate the exact `request_id` Timeline block after hydrate.
- Confirm success refreshes inbox and Catalog, removes the pending item, and opens the returned Candidate.
- Dismiss success refreshes inbox and selects the next pending item or the empty pending state.
- Pending item identity and command identity use `request_id`, never labels.
- All long strings use `min-w-0` and `[overflow-wrap:anywhere]`; do not add page-level `overflow-x-hidden`.

### 0.9 Error and retry matrix

| Result | Pending UI | Command key | Next action |
|---|---|---|---|
| list read fails | Keep last successful snapshot; show non-blocking error | N/A | manual/visibility/timer retry |
| confirm `503` | Keep request; show confirm retry only | reuse same confirm key | retry confirm |
| confirm/dismiss network unknown | Keep request; show only matching action retry | reuse same action key | retry same action |
| `404 request_not_found` | refresh inbox; remove stale item when canonical read agrees | clear key | choose another item |
| `409 state_conflict` | refresh canonical state; never reverse the action | clear key | follow refreshed state |
| confirm success | remove pending; open Candidate | clear key | Dry-run/Review |
| dismiss success | remove pending; select next/empty | clear key | none |

Command maps remain per `session_id + phase + request_id`, so concurrent requests cannot overwrite each other's Idempotency-Key. Global-inbox actions pass the request's own `session_id`; they must not read `selectedSessionRef.current` as the target identity.

### 0.10 Surface Matrix planning gate

| Surface | Entry | Read path | Write path | Event consumption | Error handling | Recovery | Terminal feedback | Planned landing | Four-state target |
|---|---|---|---|---|---|---|---|---|---|
| Web | Flows rail → 待生成 | global pending API + Catalog API | existing confirm/dismiss APIs | current Session SSE plus global read refresh | §0.9 | mount/visible/15s/manual refresh | request removed; Candidate opened or dismissed | WFI-3–WFI-5 | implemented + reachable + closed-loop |
| Agent | natural-language save tool | dispatch-time source availability | accepted tool result becomes canonical request | persisted correlated `tool_end` | strict tool result/error | toolCallId idempotency | says request recorded only | WFI-6 | implemented + reachable; Web is confirmation loop |
| Feishu | existing Run card | canonical event live/replay | CardKit update only | `FLOW_SAVE_REQUESTED` | existing card errors | Delivery recovery | points to `Web → Flows → 待生成` | WFI-7 | implemented + reachable; cross-surface loop verified |
| Telegram | existing pending/terminal message | canonical event live/recovery | edit existing message only | `FLOW_SAVE_REQUESTED` | existing message errors | Delivery recovery | same wording | WFI-8 | implemented/tested/planned; disabled, not reachable |
| Bridge | GET inbox; command APIs | Event Store + Session Catalog | confirm/dismiss unchanged | canonical Save Intent events | strict 400/503 | stateless read | stable page/cursor | WFI-1–WFI-2 | implemented + reachable |

### 0.11 Mandatory GitNexus gate

Before editing every named symbol, refresh a stale index and run upstream impact. Report direct callers, affected processes, and risk. Stop and warn before HIGH/CRITICAL edits.

Known pre-plan results:

- `Workbench`: LOW in graph, but treat as MEDIUM because it is the active Web surface.
- `SessionPanel`: LOW, 3 direct callers / 2 affected Web processes.
- `createSessionApp`: MEDIUM.
- `FeishuSessionWatcher.handle`: HIGH; it participates in live and recovery production flows. WFI-7 must stop for explicit approval before editing.

Before every commit run `gitnexus_detect_changes()` and verify only the current task's symbols/flows changed. Never stage `AGENTS.md`, `.claude/`, `CLAUDE.md`, generated output, or unrelated user files.

---

## Task WFI-1: Add the indexed canonical pending-event query

**Files:**

- Modify: `packages/work-items/src/index.ts`
- Modify: `packages/work-items/src/index.test.ts`

- [ ] **Step 1: Run impact analysis before editing**

Run upstream impact for `SqliteEventStore` and `SqliteEventStore.listEventsByTarget`. Record direct callers/processes and warn if HIGH/CRITICAL.

- [ ] **Step 2: Write RED tests for the query contract**

Add tests that create real WorkItems and canonical events, then require a new method such as:

```ts
store.listPendingFlowSaveRequestEvents({
  limit: 50,
  cursor: null,
});
```

Each returned row contains the `DomainEvent` plus nullable identity evidence from the same SQL query:

```ts
{
  event,
  workItemSessionId,
  requestRun: { runId, sessionId, turnId } | null,
  requestTurn: { turnId, sessionId } | null,
  sourceRun: { runId, sessionId, turnId } | null,
  sourceTurn: { turnId, sessionId } | null,
}
```

Cover independently:

1. pending requested event is returned;
2. later `FLOW_SAVE_DISMISSED`, `FLOW_CANDIDATE_CREATED`, or `FLOW_SAVE_FAILED` excludes it;
3. terminal event for another target or WorkItem does not exclude it;
4. same `occurred_at` is ordered by `event_id DESC`;
5. next-page tuple excludes the cursor row and returns older rows exactly once;
6. `limit + 1` computes `hasMore` without leaking the extra event;
7. 100 pending plus at least 500 terminal requests return correct results;
8. valid request/source Run and Turn evidence is returned by the same page query;
9. missing/mismatched Run or Turn is returned with nullable/mismatched evidence so Bridge can warn;
10. a temporary SQLite file reports `domain_events_flow_save_inbox` columns as `type, occurred_at, event_id` via `PRAGMA index_info`.

Expected RED: TypeScript/test failure because the method and index do not exist.

Run:

```bash
rtk proxy pnpm vitest run packages/work-items/src/index.test.ts
```

- [ ] **Step 3: Implement the minimal Event Store query**

Add exported input/result types with a structured cursor. Add the exact DDL from §0.4. Implement one SQL statement using `NOT EXISTS`, `ORDER BY occurred_at DESC, event_id DESC`, `LIMIT limit + 1`, and `LEFT JOIN` identity evidence:

- `work_items` by `requested.work_item_id`;
- request `runs` by `requested.run_id`;
- request `session_turns` by request Run `turn_id`;
- source `runs` by strict `json_extract(requested.payload, '$.source_run_id')`;
- source `session_turns` by source Run `turn_id`.

Keep malformed joins nullable. Keep cursor encoding out of this package.

Do not call `listEventsByTarget` in a loop. Do not add a second pending table or projection.

- [ ] **Step 4: Run GREEN and package build**

```bash
rtk proxy pnpm vitest run packages/work-items/src/index.test.ts
rtk proxy pnpm --filter @codebridge/work-items build
rtk git diff --check
```

- [ ] **Step 5: Detect scope and commit**

Run `gitnexus_detect_changes()`. Stage only the two WFI-1 files and commit:

```bash
git commit -m "feat(work-items): query pending Flow save events"
```

---

## Task WFI-2: Build the fail-closed inbox service and GET API

**Files:**

- Create: `apps/bridge/src/flow-save-inbox.ts`
- Create: `apps/bridge/src/flow-save-inbox.test.ts`
- Modify: `apps/bridge/src/flow-api.ts`
- Modify: `apps/bridge/src/flow-api.test.ts`
- Modify: `apps/bridge/src/cli.ts`

- [ ] **Step 1: Run impact analysis**

Run upstream impact for `createFlowApp`, `FlowSaveIntentService.getRequestState`, and the CLI startup action/symbol reported by GitNexus. The service must reuse the existing strict request-event parser or extract it without changing its accepted payload shape.

- [ ] **Step 2: Write RED service tests**

Create a real in-memory `SessionCatalogStore` and `SqliteEventStore`. Require `FlowSaveInboxService.listPending()` to:

- return a valid pending request enriched with `agentId` and `sessionTitle`;
- keep archived Sessions visible;
- load Sessions exactly once for a page;
- perform zero per-row Event Store reads after the one page query;
- omit a deleted/missing Session and emit exactly one `flow_save_pending_session_missing` warning;
- omit malformed request/session/run/turn identities and warn with a stable code;
- leave Event Store counts and Flow Catalog history unchanged;
- expose `sourceTitle` and `userMessage` as separate fields;
- pass the structured cursor to Event Store without re-sorting in memory.

Expected RED: module/service missing.

```bash
rtk proxy pnpm vitest run apps/bridge/src/flow-save-inbox.test.ts
```

- [ ] **Step 3: Implement the service without N+1**

The service must:

1. call the WFI-1 query once;
2. call `listSessions(undefined, { includeArchived: true })` once;
3. build a `Map<sessionId, AgentSession>`;
4. parse each requested event through the same strict canonical payload validation as `FlowSaveIntentService`;
5. verify request target, joined WorkItem identity, joined request/source Runs and Turns, Session task record, and payload consistently identify that Session;
6. omit and warn on any mismatch;
7. return domain camelCase objects and the raw next cursor tuple.

Do not call `getRequestState()`, `getRun()`, `getTurn()`, `getWorkItem()`, or `getSession()` for every row; WFI-1 has already excluded terminals and returned identity evidence.

- [ ] **Step 4: Write RED API tests**

In `flow-api.test.ts`, require:

- authenticated GET returns exact snake_case fields and opaque cursor;
- cursor round-trip with same timestamp/event ID has no duplicates;
- state missing/non-pending, invalid limit, malformed/extra-key cursor return exact 400 errors;
- missing service returns exact 503;
- deleted Session row is omitted rather than returned with guessed metadata;
- GET causes zero new events and zero Catalog history entries.

Expected RED: route is 404.

```bash
rtk proxy pnpm vitest run apps/bridge/src/flow-api.test.ts
```

- [ ] **Step 5: Implement strict cursor codec and route**

Keep Base64URL encode/decode in Bridge. Decode JSON with exact own keys, non-empty canonical ISO timestamp, and non-empty event ID. Re-encode the final returned tuple; never accept offset pagination or a numeric sequence cursor.

Instantiate `FlowSaveInboxService` in `cli.ts`, pass it to `createFlowApp`, and provide a structured warning sink. Do not modify confirm/dismiss behavior.

- [ ] **Step 6: Run GREEN, integration regression, and build**

```bash
rtk proxy pnpm vitest run \
  apps/bridge/src/flow-save-inbox.test.ts \
  apps/bridge/src/flow-api.test.ts \
  apps/bridge/src/flow-save-intent.test.ts \
  apps/bridge/src/flow-save-intent.integration.test.ts
rtk proxy pnpm --filter @codebridge/bridge build
rtk git diff --check
```

- [ ] **Step 7: Detect and commit**

Run `gitnexus_detect_changes()`, stage only WFI-2 files, and commit:

```bash
git commit -m "feat(bridge): expose pending Flow save inbox"
```

---

## Task WFI-3: Add Web API types and race-safe inbox state

**Files:**

- Modify: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/api.test.ts`
- Create: `apps/web/src/lib/flow-save-inbox-state.ts`
- Create: `apps/web/src/lib/flow-save-inbox-state.test.ts`
- Modify: `apps/web/src/components/workbench.tsx`
- Modify: `apps/web/src/components/workbench-component-policy.test.ts`

- [ ] **Step 1: Run impact analysis**

Run impact for `Workbench`, the API `request` helper, and any existing timer/refresh helper that will be edited. Treat Workbench as an active MEDIUM surface even if graph risk is LOW.

- [ ] **Step 2: Write RED API-client tests**

Require `api.pendingFlowSaveRequests({ limit, cursor, signal })` to send:

```text
GET /v1/flow-save-requests?state=pending&limit=50[&cursor=...]
```

and parse `FlowSaveInboxPage` without converting the opaque cursor. Assert that the provided `AbortSignal` reaches `fetch` unchanged.

Expected RED: API function and types missing.

- [ ] **Step 3: Write RED pure-state tests for generation semantics**

The pure state module must cover:

1. generation 1 poll starts;
2. generation 2 immediate refresh starts before generation 1 settles;
3. generation 2 commits a new list;
4. late generation 1 success cannot overwrite it;
5. late generation 1 failure cannot overwrite/clear generation 2 state;
6. immediate generation 2 aborts generation 1 before starting its fetch;
7. `AbortError` is silent and cannot clear the last successful snapshot;
8. list failure retains the last successful snapshot;
9. confirm/dismiss immediate refresh resets the next-poll deadline;
10. a periodic tick does not start a second periodic request while one is active;
11. pagination merge deduplicates by `request_id` and preserves server order.

Expected RED: state module missing.

```bash
rtk proxy pnpm vitest run \
  apps/web/src/lib/api.test.ts \
  apps/web/src/lib/flow-save-inbox-state.test.ts
```

- [ ] **Step 4: Implement minimal API/types/state**

Keep state mechanics outside `Workbench` so stale-response rules are directly testable. The state module owns generation comparisons, the current abort controller, last-good snapshot retention, request deduplication, and next poll timing; Workbench owns React effects and network calls.

- [ ] **Step 5: Integrate one timer in Workbench**

Add inbox state, selected pending request ID, and one timer/ref lifecycle. Fetch on mount, entering Flows, manual refresh, visibility restoration, and 15-second cadence. On other areas, the same endpoint still supplies the badge count; do not create a separate count endpoint.

Policy tests must reject multiple `setInterval` calls for this feature and reject direct cross-WorkItem sequence comparisons.

- [ ] **Step 6: Run GREEN and Web build**

```bash
rtk proxy pnpm vitest run \
  apps/web/src/lib/api.test.ts \
  apps/web/src/lib/flow-save-inbox-state.test.ts \
  apps/web/src/components/workbench-component-policy.test.ts
rtk proxy pnpm --filter @codebridge/web build
rtk git diff --check
```

- [ ] **Step 7: Detect and commit**

Run `gitnexus_detect_changes()`, stage only WFI-3 files, and commit:

```bash
git commit -m "feat(web): load pending Flow save inbox"
```

---

## Task WFI-4: Render Flows badge, pending group, and direct detail

**Files:**

- Modify: `apps/web/src/components/session-chrome.tsx`
- Modify: `apps/web/src/components/session-chrome.test.tsx`
- Create: `apps/web/src/components/flow-save-inbox-detail.tsx`
- Create: `apps/web/src/components/flow-save-inbox-detail.test.tsx`
- Modify: `apps/web/src/components/workbench.tsx`
- Modify: `apps/web/src/components/workbench-component-policy.test.ts`

- [ ] **Step 1: Run impact analysis**

Run impact for `AgentRail`, `SessionPanel`, and `Workbench`. If the graph names the rail differently, inspect context before editing rather than guessing.

- [ ] **Step 2: Write RED component tests**

Cover:

- 0 pending hides the badge; 1 and 99 render exact values; 100 renders `99+`;
- badge accessible label contains the pending count;
- `待生成 · N` appears before Candidate/Published/Draft/Deprecated groups;
- Agent name uses `AgentProfile.display_name`, with raw `agent_id` fallback;
- request title uses `name_hint ?? source_title ?? 未命名保存请求`;
- direct detail shows `来源` from `source_title` and `你的请求` from `user_message` on separate lines;
- Imported warning, Agent/Session, summary, actions, and source-session link render;
- clicking pending detail does not call the Session-selection callback;
- unknown/busy/retry action states show only permitted controls.

Expected RED: missing props/component and absent pending group.

```bash
rtk proxy pnpm vitest run \
  apps/web/src/components/session-chrome.test.tsx \
  apps/web/src/components/flow-save-inbox-detail.test.tsx
```

- [ ] **Step 3: Implement presentational UI**

Keep command state in Workbench; both Timeline card and inbox detail receive the existing `FlowSaveRequestActionState`. If useful, extract a pure shared presentation fragment, but do not create a second status machine.

The Flows main-area render branch must take precedence over selected Session conversation without clearing `selectedSessionId`:

```text
area=flows + selected pending → pending detail
area=flows + selected Catalog flow → Flow detail
area=flows + neither → Flows empty state
area=agents → selected Session conversation
```

- [ ] **Step 4: Run GREEN and focused Workbench tests**

```bash
rtk proxy pnpm vitest run \
  apps/web/src/components/session-chrome.test.tsx \
  apps/web/src/components/flow-save-inbox-detail.test.tsx \
  apps/web/src/components/workbench-component-policy.test.ts
rtk proxy pnpm --filter @codebridge/web build
rtk git diff --check
```

- [ ] **Step 5: Detect and commit**

Run `gitnexus_detect_changes()`, stage only WFI-4 files, and commit:

```bash
git commit -m "feat(web): render pending Flow save requests"
```

---

## Task WFI-5: Reuse command semantics and close the global Web loop

**Files:**

- Modify: `apps/web/src/components/workbench.tsx`
- Modify: `apps/web/src/lib/flow-save-command-state.ts`
- Modify: `apps/web/src/lib/flow-save-command-state.test.ts`
- Modify: `apps/web/src/components/flow-save-inbox-detail.test.tsx`
- Create or modify: `e2e/flow-save-inbox.spec.ts`

- [ ] **Step 1: Run impact analysis**

Run impact for `Workbench`, `refreshFlowCatalog`, and the existing confirm/dismiss handlers. Report MEDIUM/HIGH before editing.

- [ ] **Step 2: Write RED unit tests for global command identity**

Refactor handlers to accept explicit target identity:

```ts
confirmFlowSaveRequest(sessionId, requestId)
dismissFlowSaveRequest(sessionId, requestId)
```

Tests must prove:

- global actions work while another Session remains selected;
- Timeline actions still use their source Session;
- concurrent requests A/B hold separate action keys;
- confirm unknown retry cannot become dismiss and reuses the same key;
- dismiss unknown retry cannot become confirm and reuses the same key;
- 503 confirm keeps the item and key;
- terminal canonical refresh clears only the matching request/action;
- Session changes do not clear unrelated global commands.

Expected RED: current handlers derive target from `selectedSessionRef.current`.

- [ ] **Step 3: Implement explicit target handlers and immediate convergence**

On confirm success:

1. clear only that confirm key/state;
2. trigger a new inbox generation immediately;
3. refresh Catalog;
4. open the returned Candidate in Flows;
5. refresh source Timeline only if that Session is currently selected.

On dismiss success:

1. clear only that dismiss key/state;
2. trigger a new inbox generation immediately;
3. select the next pending request by server order or the pending-empty state;
4. refresh source Timeline only if currently selected.

Old timer responses are ignored by generation. Do not optimistically fabricate terminal events.

- [ ] **Step 4: Implement exact source navigation**

`查看来源 Session` must:

1. choose `request.agent_id` and `request.session_id` explicitly;
2. switch to Agents area only after the user clicks;
3. hydrate that Session;
4. find `[data-flow-save-request-id="<request_id>"]`;
5. `scrollIntoView` and focus the card;
6. show a non-blocking error if the Session/block disappeared, without guessing another block.

- [ ] **Step 5: Write the active-surface Playwright fixture and RED cases**

The fixture must model two different Agents/Sessions and canonical backend state. Cover:

1. Web is on Codex Session B while a Pi Session A pending request appears;
2. no automatic Agent/Session switch occurs;
3. badge and pending group discover A;
4. detail opens directly in Flows;
5. confirm sends one command, creates one Candidate, removes pending, and opens Candidate;
6. dismiss removes pending and selects next/empty;
7. delayed poll A, immediate refresh B, then late A cannot resurrect a terminal request;
8. delayed success/error from Session A cannot notify or mutate a newly selected detail B;
9. `查看来源 Session` locates the exact block;
10. full browser reload recovers the same pending/Candidate state.

Expected RED: no global group/action loop.

- [ ] **Step 6: Run GREEN**

```bash
rtk proxy pnpm vitest run \
  apps/web/src/lib/flow-save-command-state.test.ts \
  apps/web/src/components/flow-save-inbox-detail.test.tsx \
  apps/web/src/components/workbench-component-policy.test.ts
rtk proxy pnpm exec playwright test e2e/flow-save-inbox.spec.ts
rtk proxy pnpm --filter @codebridge/web build
rtk git diff --check
```

- [ ] **Step 7: Detect and commit**

Run `gitnexus_detect_changes()`, stage only WFI-5 files, and commit:

```bash
git commit -m "feat(web): close pending Flow save workflow"
```

---

## Task WFI-6: Lock Web-availability and Agent statement boundaries

**Files:**

- Modify: `apps/bridge/src/startup-surfaces.test.ts`
- Modify: `apps/bridge/src/session-runtime-api.test.ts`
- Modify: `packages/runner-host/src/server.test.ts`
- Modify only if a failing test proves a gap: `apps/bridge/src/cli.ts`
- Modify only if a failing test proves a gap: `packages/core/src/flow-save-tool.ts`

- [ ] **Step 1: Run impact analysis before any production edit**

Run impact for the CLI dispatch resolver and runner-host tool injection symbol. The current branch already gates source availability with `surfaces.web`; production edits are allowed only if a new RED test demonstrates a real missing edge.

- [ ] **Step 2: Add end-to-end contract RED/regression tests**

Cover:

- `web.enabled=false`, `feishu.enabled=true`, extractable prior Run → Runner request has no `flowSaveSourceAvailability`, no internal Flow Save MCP/custom tool, and no `FLOW_SAVE_REQUESTED`;
- `web.enabled=true` with same data → availability and tool are present;
- successful Agent tool statement says only “待确认请求已记录、尚无 Candidate”; it does not claim the current interface can confirm;
- channel configuration does not override Web availability.

If these tests are already GREEN, record them as contract-lock tests and make no production change.

- [ ] **Step 3: Run focused regression and builds**

```bash
rtk proxy pnpm vitest run \
  apps/bridge/src/startup-surfaces.test.ts \
  apps/bridge/src/session-runtime-api.test.ts \
  packages/runner-host/src/server.test.ts \
  packages/core/src/flow-save-tool.test.ts
rtk proxy pnpm --filter @codebridge/core build
rtk proxy pnpm --filter @codebridge/runner-host build
rtk proxy pnpm --filter @codebridge/bridge build
rtk git diff --check
```

- [ ] **Step 4: Detect and commit only actual changes**

If tests required code/test changes, run `gitnexus_detect_changes()` and commit:

```bash
git commit -m "test(flow): lock Web-gated save intent availability"
```

---

## Task WFI-7: Point Feishu at the exact reachable destination

**Files:**

- Modify: `packages/channel-feishu/src/session-watcher.ts`
- Modify: `packages/channel-feishu/src/session-watcher.test.ts`
- Modify: `packages/channel-feishu/src/bridge-recovery.test.ts`
- Modify: `apps/integration/session-event-contract.integration.test.ts`

- [ ] **Step 1: Run HIGH impact gate and stop for approval**

Run upstream impact for `FeishuSessionWatcher.handle`, `applyRecoveredEvent`, and the notice renderer/helper. This is a known HIGH live/recovery surface. Report callers and affected processes and wait for explicit authorization before production edits.

- [ ] **Step 2: Write RED wording and lifecycle tests**

Require exact text:

```text
已记录“存为 Flow”请求。请前往 Web → Flows → 待生成确认；尚未创建 Candidate。
```

Independently cover live, finite replay, restart recovery, duplicate requested event, foreign Run, long final body, and terminal-after-request. Assert:

- the notice remains on the existing Run card;
- no detached `sendMarkdown` message;
- no confirm/dismiss/Catalog call;
- Delivery completes once after Run terminal;
- later Web terminal events do not reopen or rewrite the completed Delivery.

Expected RED: old wording omits `Flows → 待生成`.

- [ ] **Step 3: Change only the Adapter wording**

Do not add channel buttons, polling, timers, domain APIs, or a second card.

- [ ] **Step 4: Run GREEN and build**

```bash
rtk proxy pnpm vitest run \
  packages/channel-feishu/src/session-watcher.test.ts \
  packages/channel-feishu/src/bridge-recovery.test.ts \
  apps/integration/session-event-contract.integration.test.ts
rtk proxy pnpm --filter @codebridge/channel-feishu build
rtk git diff --check
```

- [ ] **Step 5: Detect and commit**

Run `gitnexus_detect_changes()`, verify only expected live/recovery renderer flows, and commit:

```bash
git commit -m "fix(feishu): locate pending Flow save requests"
```

---

## Task WFI-8: Keep Telegram wording aligned without claiming reachability

**Files:**

- Modify: `packages/channel-telegram/src/telegram-session-watcher.ts`
- Modify: `packages/channel-telegram/src/telegram-session-watcher.test.ts`
- Modify: `packages/channel-telegram/src/telegram-bridge.test.ts`

- [ ] **Step 1: Run impact analysis**

Run upstream impact for `TelegramSessionWatcher.handle`, `run`, `openRun`, and its renderer/chunker. Stop and warn for HIGH/CRITICAL.

- [ ] **Step 2: Write RED wording tests**

Use the same exact destination wording as Feishu. Preserve existing tests for live/recovery, duplicate, foreign Run, long text sticky notice, edit fallback, and terminal-after-request zero writes.

- [ ] **Step 3: Change only wording and run GREEN**

```bash
rtk proxy pnpm vitest run \
  packages/channel-telegram/src/telegram-session-watcher.test.ts \
  packages/channel-telegram/src/telegram-bridge.test.ts
rtk proxy pnpm --filter @codebridge/channel-telegram build
rtk git diff --check
```

- [ ] **Step 4: Detect and commit**

Run `gitnexus_detect_changes()` and commit only if scope is expected:

```bash
git commit -m "fix(telegram): locate pending Flow save requests"
```

Record Telegram as implemented/tested/planned and disabled. Do not claim reachable or closed-loop until a real Bot is enabled and verified.

---

## Task WFI-V1: Adversarial verification, deployment evidence, and completion audit

**Files:**

- Create: `docs/superpowers/verifications/2026-08-26-flow-save-inbox-verification.md`
- Modify if all mandatory criteria pass: `docs/superpowers/specs/2026-08-26-flow-save-inbox-design.md` (`Status` only)

- [ ] **Step 1: Run the complete contract suite once and record first-run results**

```bash
rtk proxy pnpm vitest run \
  packages/work-items/src/index.test.ts \
  apps/bridge/src/flow-save-inbox.test.ts \
  apps/bridge/src/flow-api.test.ts \
  apps/bridge/src/flow-save-intent.test.ts \
  apps/bridge/src/flow-save-intent.integration.test.ts \
  apps/bridge/src/session-runtime-api.test.ts \
  apps/bridge/src/startup-surfaces.test.ts \
  packages/runner-host/src/server.test.ts \
  apps/web/src/lib/api.test.ts \
  apps/web/src/lib/flow-save-inbox-state.test.ts \
  apps/web/src/lib/flow-save-command-state.test.ts \
  apps/web/src/components/session-chrome.test.tsx \
  apps/web/src/components/flow-save-inbox-detail.test.tsx \
  apps/web/src/components/workbench-component-policy.test.ts \
  packages/channel-feishu/src/session-watcher.test.ts \
  packages/channel-feishu/src/bridge-recovery.test.ts \
  packages/channel-telegram/src/telegram-session-watcher.test.ts \
  packages/channel-telegram/src/telegram-bridge.test.ts \
  apps/integration/session-event-contract.integration.test.ts
```

Do not rerun a failure without recording the original command, failing test, and cause.

- [ ] **Step 2: Run active Web adversarial tests**

```bash
rtk proxy pnpm exec playwright test \
  e2e/flow-save-inbox.spec.ts \
  e2e/flow-save-intent.spec.ts \
  e2e/provider-history-overflow.spec.ts
```

Required widths: 320, 768, 1280, 1536. Required data: 100 pending items, long UUID/path/title/summary, imported item, missing Agent profile, two Sessions across two Agents, delayed poll and immediate response races. Assert document and component `scrollWidth <= clientWidth`; do not satisfy the test by clipping buttons or applying page-level horizontal hiding.

- [ ] **Step 3: Build every affected package**

```bash
rtk proxy pnpm --filter @codebridge/core build
rtk proxy pnpm --filter @codebridge/work-items build
rtk proxy pnpm --filter @codebridge/runner-host build
rtk proxy pnpm --filter @codebridge/bridge build
rtk proxy pnpm --filter @codebridge/web build
rtk proxy pnpm --filter @codebridge/channel-feishu build
rtk proxy pnpm --filter @codebridge/channel-telegram build
rtk git diff --check
```

- [ ] **Step 4: Run final GitNexus gate**

Stage only intended feature files, then run `gitnexus_detect_changes()` on staged changes. Record symbols, processes, and risk. Verify no unrelated files and no untracked generated files are staged.

- [ ] **Step 5: Build and restart the supported local deployment only with authority**

Before claiming the active deployment is fixed:

1. record Git SHA;
2. perform a full build, not restart-only;
3. restart through the supported `scripts/start.sh`/launchd path;
4. record artifact hashes/mtime;
5. record Bridge/Runner PIDs and process start times;
6. verify the process serves the new inbox endpoint and exact channel wording.

Do not infer active code from source or passing tests.

- [ ] **Step 6: Verify the real cross-surface chain**

Using a real Feishu Pi Session A while Web is displaying a different Session B:

1. trigger one explicit Save Intent;
2. confirm Feishu card says `Web → Flows → 待生成`;
3. verify Web does not switch Session automatically;
4. verify the badge/list discovers the request within 15 seconds;
5. open detail and verify source title, Agent, Session, and user request;
6. confirm exactly once;
7. verify pending disappears and exactly one Candidate opens;
8. reload Web and restart Bridge; verify terminal state remains consistent.

If confirmation would create unwanted real data, use dismiss for the active-chain check and separately verify Candidate creation in the E2E fixture. State that limitation explicitly.

- [ ] **Step 7: Re-audit the Surface Matrix and completion definition**

The verification document must report `implemented`, `reachable`, `closed-loop`, and `planned` independently for Web, Agent, Feishu, Telegram, and Bridge. It must not infer one surface from another.

Mandatory completion criteria:

1. pending request is discoverable while another Session is selected;
2. opening pending detail does not switch Session;
3. confirm-before-Catalog invariant holds;
4. confirm creates exactly one Candidate;
5. dismiss/confirm and refresh/restart converge;
6. deleted Session request is hidden with structured warning and no write;
7. Agent display name uses existing profiles with raw-ID fallback;
8. stale poll cannot overwrite immediate refresh;
9. Feishu exact destination is reachable and verified;
10. Web disabled means no tool injection/request/dead destination claim;
11. 320–1536 widths and 100 pending do not overflow;
12. Telegram remains honestly disabled/planned unless a real Bot was tested;
13. active process evidence matches the verified commit/artifacts.

- [ ] **Step 8: Commit verification evidence**

Only if the evidence is truthful and complete, update design status as appropriate, run `gitnexus_detect_changes()`, and commit:

```bash
git commit -m "docs: verify global Flow save inbox"
```

If Feishu active verification or Telegram real Bot verification remains pending, keep the design in Review/Accepted status required by project policy and list the exact pending item; do not mark the full matrix closed-loop.
