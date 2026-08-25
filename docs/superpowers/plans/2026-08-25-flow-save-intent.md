# Explicit Flow Save Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace noisy post-Run “整理为 Guide” heuristics with an explicit, persisted Save Intent that a user can request by natural language or a Turn action, confirm in Web, and convert exactly once into a Candidate Runbook.

**Architecture:** Keep extraction, user intent, and Catalog mutation as three separate layers. A Bridge-owned `FlowSaveIntentService` writes canonical Session events, resolves the exact source Run by event sequence, extracts a definition without recommending it, and performs a deterministic cross-store Candidate saga. Timeline hydration and live SSE project those events into one Web confirmation card; Agent and channel adapters only expose the request tool or render status and never write the Flow Catalog.

**Tech Stack:** TypeScript, Hono, SQLite, React 18, Tailwind CSS, Vitest/jsdom, Playwright, ACP, Pi SDK, MCP SDK, Feishu CardKit, Telegram Bot API, GitNexus.

**Canonical design:** `docs/superpowers/specs/2026-08-25-flow-save-intent-design.md`

---

## 0. Locked contracts, delivery order, and risk gates

### 0.1 Product predicates

| Concept | Question answered | Stored form | May mutate Catalog? |
|---|---|---|---|
| Extractable | Can a successful Run be converted into a reusable definition? | Pure return value from `extractRunDefinition` | No |
| Save Intent | Did the user explicitly ask to save a specific Run? | `FLOW_SAVE_*` canonical Session events | No |
| Candidate Runbook | Did the user confirm the extracted definition? | `FlowCatalogStore` Candidate plus `FLOW_CANDIDATE_CREATED` | Yes, only through confirm |

`extractRunDefinition` must never expose `saveable`, `recommended`, or presentation flags. No successful Run automatically creates a Save Intent.

### 0.2 Failure and retry semantics

| Failure | Event/state | HTTP/UI result | Recovery |
|---|---|---|---|
| Manual request source is missing/wrong Session | Create no request/event | `404 source_run_not_found` | User selects an existing source |
| Manual request source is not succeeded, is current/Flow/management-only, or is not extractable | Create no request/event | `409 source_run_not_succeeded` or `409 source_run_not_extractable` | User selects another source |
| Natural-language request has no preceding extractable Run | Tool returns `accepted: false`; create no request/event | Agent relays the fixed “请使用目标回复的 Turn 菜单” message | User selects an exact Turn |
| A previously valid source disappears/becomes invalid at confirm, or deterministic Candidate validation fails | Append `FLOW_SAVE_FAILED`; request becomes terminal `failed` | exact `source_run_*` code or `409 flow_save_definition_invalid` | User selects a source again; Bridge creates a **new** `request_id` |
| Catalog dependency absent or temporarily unavailable | Append no terminal event; request remains `requested` | `503 flow_catalog_unavailable` | Retry confirm on the same request |
| Network outcome unknown after confirm | State remains whatever canonical events say | Web shows retry | Retry with the same confirmation Idempotency-Key |
| Catalog save succeeded but terminal event append did not | Candidate exists at deterministic ID; request still appears pending | Startup reconciliation repairs it | Restart Bridge or retry confirm |
| Deterministic Candidate ID already exists with different `sourceRequestId` | Append `FLOW_SAVE_FAILED`; never overwrite | `409 flow_save_candidate_conflict` | Investigate data integrity; create a new explicit request only after repair |
| Completed request is confirmed again | No write | `200` with the existing Candidate | Reuse the existing Candidate; a new explicit save intent creates a new `request_id` |
| Dismissed/failed request is confirmed again | No write | `409 flow_save_request_already_dismissed` or `flow_save_request_state_conflict` | Create a new request only when the user explicitly asks again |

The design diagram’s `failed → retry` arrow is a UX recovery path, not mutation of the same failed request: deterministic failures are immutable evidence. Transient Catalog/transport failures never enter `failed`.

### 0.3 Identity and idempotency

```ts
type FlowSaveRequestId = `fsr_${string}`;

function createFlowSaveRequestId(): FlowSaveRequestId {
  return `fsr_${crypto.randomUUID().replaceAll("-", "")}`;
}

function candidateFlowId(requestId: FlowSaveRequestId): string {
  return `flow_save_${definitionHash({ request_id: requestId }).slice(-32)}`;
}
```

- The Bridge service is the only `request_id` generator for both natural-language and manual entries.
- Manual request/dismiss/confirm endpoints require `Idempotency-Key` headers.
- The manual request input hash is `flow-save-request:http:<session_id>:<key>`.
- The Agent input hash is `flow-save-request:tool:<run_id>:<tool_call_id>`.
- Unknown-result retries reuse the same key. A later explicit user action receives a new key.
- Confirm is domain-idempotent by immutable `request_id`: after completion, any replay returns the same Candidate with zero writes. A different transport key cannot turn the completed request into a new command.
- `request_id` is stored in event payload and target; it is not the event ID.
- Candidate identity is deterministic from `request_id`; two confirms cannot create two Flows.
- `FLOW_SAVE_REQUESTED.run_id` is the Timeline anchor Run, and payload stores both `request_turn_id` and `source_run_id`: manual entry anchors to the selected source Turn; natural-language entry anchors to the tool-calling Turn. Every terminal event copies the request’s anchor `run_id` so hydrate and live reducers update the same Turn.

### 0.4 V1 reconciliation boundary

V1 adds one startup reconciliation scan after Flow Catalog and Session stores are open:

1. Find requests whose latest canonical state is `requested`.
2. Compute the deterministic Candidate ID.
3. If that Candidate exists and `FLOW_CANDIDATE_CREATED` is absent, append the missing event.
4. If the Candidate does not exist, leave the request pending.

No timer, polling loop, new outbox table, or background infrastructure is added in V1. Confirm retries run the same reconciliation inline before attempting a save.

### 0.5 Release and 410 ordering

1. Add the new domain service and events while the old proposal endpoint remains available.
2. Remove the active Web `flowProposals` caller and automatic Guide card.
3. Add the new Timeline projection, write APIs, and Web actions.
4. Only after no active caller remains, make the old proposal and run-based Guide endpoints return 410.
5. Inject the Agent tool and enable channel messages only in the release batch that already includes the reachable Web confirmation card.

This ordering prevents an intermediate Web build from repeatedly calling a 410 endpoint and prevents Feishu/Telegram from sending a dead “前往 Web” instruction.

### 0.6 Source selection and extraction invariants

Natural-language requests resolve the latest preceding source by canonical event sequence, never timestamps:

```ts
const source = events
  .filter((event) =>
    event.sequence < requestSequence
    && event.type === "RUN_SUCCEEDED"
    && event.runId !== currentRequestRunId
  )
  .reverse()
  .map((event) => store.getRun(event.runId!))
  .find((run) => run?.sessionId === sessionId && run.executionKind === "agent");
```

The resolver must additionally reject deleted/unreadable Runs and management-only Runs. Imported successful Agent Runs remain selectable because intent is explicit, but request/card metadata must show `source_imported: true`.

`extractRunDefinition`:

- prefers the last valid structured `FLOW_PROPOSED` definition;
- otherwise derives an observed trace only after excluding CodeBridge management tools;
- requires at least two remaining meaningful tool starts for trace extraction;
- redacts concrete paths, URLs, identifiers, and raw parameters using the existing sanitizers;
- returns definition, provenance, warnings, and imported state only;
- never writes an event or Catalog record.

### 0.7 Agent adapter projection

The product contract is one internal tool, `codebridge.request_flow_save`. Current adapters expose it differently without duplicating domain rules:

- ACP agents receive a CodeBridge-owned stdio MCP server through `mcpServers` on new/load/resume.
- Pi receives the same schema/result through `customTools`, because the current Pi SDK has no programmatic external-MCP injection hook.
- Both return the same discriminated result. Bridge computes the read-only source-availability preview before dispatching the request, so a tool can reject honestly without guessing a Run or writing state:

```ts
{
  codebridge_internal_tool: "flow_save_request/v1",
  accepted: true,
  source_scope: "previous_completed_run"
}

// No preceding extractable Run:
{
  codebridge_internal_tool: "flow_save_request/v1",
  accepted: false,
  code: "no_extractable_previous_run",
  message: "找不到可提取的上一次成功任务，请在目标回复的菜单中选择‘存为 Flow’。"
}
```

The Bridge translator trusts only a successful `tool_end` with that marker and `accepted: true`, correlates its `toolCallId` to a persisted `tool_start`, validates the start input, and then creates the Save Intent. An `accepted: false` completion creates no request. The tool itself cannot select a Run ID, create a Candidate, approve, or publish.

### 0.8 Surface Matrix planning gate

| Surface | Entry | Read path | Write path | Event consumption | Error handling | Recovery | Terminal feedback | Planned landing |
|---|---|---|---|---|---|---|---|---|
| Web | Assistant Turn menu; persisted confirmation card | Snapshot hydrate + canonical SSE | request/confirm/dismiss APIs | All four `FLOW_SAVE_*` events | Typed 409/503/unknown states | same-key retry; refresh; new request after deterministic failure | pending/dismissed/failed/completed card and Candidate link | S4–S6, W1 |
| Agent | User says “把刚才流程存下来” | Internal tool schema + dispatch-time source preview | Read-only tool call; translator writes canonical event | successful correlated accepted `tool_end` only | unavailable result explains Turn-menu fallback; failed tool/end does nothing | toolCallId replay idempotency | Agent says request recorded only when accepted, never “Flow 已保存” | A1–A2 |
| Feishu | Natural-language Agent request | canonical live/replayed Session events | CardKit update only | `FLOW_SAVE_REQUESTED` only | no Catalog action in channel | existing replay/reconcile keeps the notice on the same Run card | “已记录，请前往 Web 确认” only after Web is reachable | F1 |
| Telegram | Natural-language Agent request | canonical live/replayed Session events | edit existing pending message only | `FLOW_SAVE_REQUESTED` only | no Catalog action in channel | existing replay path | same Web instruction; production remains disabled | T1 |
| Bridge/Runtime | HTTP request; translated Agent tool event | Session/Run/events + Flow Catalog | canonical events; confirmed Candidate | startup pending scan | exact code matrix §0.2 | deterministic ID + startup reconciliation | canonical events and API response | S1–S6 |

### 0.9 Mandatory GitNexus gate per task

Before editing every listed symbol, refresh a stale index and run upstream impact:

```text
gitnexus_impact({ target: "<symbol>", direction: "upstream" })
```

Report direct callers, affected processes, and risk. Stop and warn before a HIGH/CRITICAL edit. Before every commit:

```text
gitnexus_detect_changes()
```

Verify only the task’s symbols/flows changed. Preserve `AGENTS.md`, `.claude/`, `.playwright-cli/`, `.superpowers/`, `CLAUDE.md`, Vite timestamp files, unrelated Flow docs, `output/`, and `test-results/`.

### 0.10 Mandatory independent surface gate before each PR is declared ready

In addition to each task’s focused tests, run this fixed gate at every PR boundary and record the four-state result for every surface:

```bash
rtk proxy pnpm vitest run \
  apps/web/src/components/session-timeline.test.tsx \
  apps/web/src/lib/session-store.test.ts \
  packages/runner-host/src/server.test.ts \
  apps/bridge/src/session-runtime-api.test.ts \
  packages/channel-feishu/src/session-watcher.test.ts \
  packages/channel-feishu/src/bridge-recovery.test.ts \
  packages/channel-telegram/src/telegram-session-watcher.test.ts \
  packages/channel-telegram/src/telegram-bridge.test.ts \
  apps/integration/session-event-contract.integration.test.ts

rtk proxy pnpm --filter @codebridge/web build
rtk proxy pnpm --filter @codebridge/runner-host build
rtk proxy pnpm --filter @codebridge/bridge build
rtk proxy pnpm --filter @codebridge/channel-feishu build
rtk proxy pnpm --filter @codebridge/channel-telegram build
```

Before PR 3 the Agent tool is `planned`, before PR 4 the Web confirmation card is `planned`, before PR 5 the Feishu notice is `planned`, and Telegram remains production-disabled after PR 6. A passing test may upgrade `implemented`; only a verified active entry may upgrade `reachable`, and only a user-observable terminal path may upgrade `closed-loop`.

---

## PR 1 — Domain events, extraction, saga, and startup reconciliation

### Task S1: Add the canonical Save Intent event and lookup contracts

**Files:**
- Modify: `packages/work-items/src/index.ts`
- Modify: `packages/work-items/src/session-projector.ts`
- Test: `packages/work-items/src/index.test.ts`
- Test: `packages/work-items/src/session-projector.test.ts`

- [ ] **Step 1: Run impact before edits**

Run impact for `DomainEventType`, `SqliteEventStore`, and `projectSessionEvent`. `projectSessionEvent` is expected to be HIGH/CRITICAL because hydrate and live Session flows depend on it; report before proceeding.

- [ ] **Step 2: Write failing event-store tests**

Add tests proving all four event types persist, a request can be found by target, and target events return in sequence order:

```ts
const requested = store.appendEventOnce({
  workItemId: workItem.id,
  runId: run.id,
  type: "FLOW_SAVE_REQUESTED",
  actor: "user",
  target: "fsr_one",
  inputHash: "flow-save-request:http:sess_1:key_1",
  payload: {
    request_id: "fsr_one",
    session_id: "sess_1",
    request_turn_id: run.turnId,
    source_run_id: run.id,
  },
});
store.appendEvent({
  workItemId: workItem.id,
  runId: run.id,
  type: "FLOW_SAVE_DISMISSED",
  actor: "user",
  target: "fsr_one",
  payload: { request_id: "fsr_one" },
});
expect(store.listEventsByTarget("fsr_one").map((event) => event.type))
  .toEqual(["FLOW_SAVE_REQUESTED", "FLOW_SAVE_DISMISSED"]);
expect(requested.target).toBe("fsr_one");
```

- [ ] **Step 3: Run RED**

Run:

```bash
rtk proxy pnpm vitest run packages/work-items/src/index.test.ts packages/work-items/src/session-projector.test.ts
```

Expected: new event literals and `listEventsByTarget` are absent; projector rejects unknown types.

- [ ] **Step 4: Add the event literals and indexed lookup**

Extend `DomainEventType` with:

```ts
| "FLOW_SAVE_REQUESTED"
| "FLOW_SAVE_DISMISSED"
| "FLOW_CANDIDATE_CREATED"
| "FLOW_SAVE_FAILED"
```

Add an index and exact query:

```sql
CREATE INDEX IF NOT EXISTS domain_events_target_sequence
  ON domain_events (target, sequence);
```

```ts
listEventsByTarget(target: string): DomainEvent[] {
  return (this.database.prepare(`
    SELECT * FROM domain_events
    WHERE target = ?
    ORDER BY sequence ASC
  `).all(target) as SqliteRow[]).map(toDomainEvent);
}
```

Temporarily add the four events to the projector’s explicit no-op list. Timeline projection is added in S4; this prevents migration/replay from failing between commits.

- [ ] **Step 5: Run GREEN, build, and inspect scope**

```bash
rtk proxy pnpm vitest run packages/work-items/src/index.test.ts packages/work-items/src/session-projector.test.ts
rtk proxy pnpm --filter @codebridge/work-items build
rtk git diff --check
```

Run `gitnexus_detect_changes()`.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/work-items/src/index.ts packages/work-items/src/index.test.ts packages/work-items/src/session-projector.ts packages/work-items/src/session-projector.test.ts
rtk git commit -m "feat(flow): add save intent domain events"
```

---

### Task S2: Extract definitions without recommending them

**Files:**
- Create: `apps/bridge/src/flow-save-intent.ts`
- Create: `apps/bridge/src/flow-save-intent.test.ts`
- Modify: `apps/bridge/src/flow-api.ts`
- Modify: `apps/bridge/src/flow-api.test.ts`

- [ ] **Step 1: Run impact before edits**

Run impact for `proposalForRun`, `proposalsForSession`, `createFlowApp`, and the new exported `extractRunDefinition`. Existing analysis found the proposal helpers LOW, but refresh the result.

- [ ] **Step 2: Write failing pure extraction tests**

Cover:

```ts
expect(extractRunDefinition(successfulStructuredRun)).toMatchObject({
  kind: "structured_plan",
  provenance: { sourceRunId: "run_source" },
});
expect(extractRunDefinition(twoToolTrace)).toMatchObject({ kind: "observed_trace" });
expect(extractRunDefinition(oneToolPlusSaveTool)).toEqual({
  ok: false,
  code: "run_not_extractable",
  reason: expect.any(String),
});
expect(extractRunDefinition(importedRun)).toMatchObject({
  ok: true,
  sourceImported: true,
});
```

Also assert concrete IDs, URLs, home paths, and raw tool arguments do not appear in the definition.

- [ ] **Step 3: Run RED**

```bash
rtk proxy pnpm vitest run apps/bridge/src/flow-save-intent.test.ts apps/bridge/src/flow-api.test.ts
```

Expected: `extractRunDefinition` does not exist and old proposal tests still expect `saveable`.

- [ ] **Step 4: Implement the extraction result union**

```ts
export type ExtractRunDefinitionResult =
  | {
      ok: true;
      kind: "structured_plan" | "observed_trace";
      name: string;
      description: string | null;
      steps: Array<{ id: string; purpose: string; dependsOn: string[] }>;
      sourceFlowId: string;
      sourceDefinitionRevision: string;
      sourceImported: boolean;
      warnings: string[];
      provenance: {
        sourceRunId: string;
        sourceSessionId: string;
        sourceFlowId: string;
        sourceDefinitionRevision: string;
      };
    }
  | { ok: false; code: "run_not_succeeded" | "run_not_extractable"; reason: string };
```

Move the structured-plan, trace, name, and purpose sanitizers out of `flow-api.ts`. Exclude tool events whose end marker is `flow_save_request/v1` before counting or building steps.

- [ ] **Step 5: Make the old proposal helpers delegate temporarily**

Keep the old GET behavior alive only for the release-order window, but derive it from `extractRunDefinition`. This prevents two extraction implementations while W0 removes the caller.

```ts
const extracted = extractRunDefinition({ session, run, title, events });
return extracted.ok
  ? toLegacyProposal(extracted)
  : unavailableProposal(...);
```

- [ ] **Step 6: Run GREEN and build**

```bash
rtk proxy pnpm vitest run apps/bridge/src/flow-save-intent.test.ts apps/bridge/src/flow-api.test.ts
rtk proxy pnpm --filter @codebridge/bridge build
rtk git diff --check
```

Run `gitnexus_detect_changes()`.

- [ ] **Step 7: Commit**

```bash
rtk git add apps/bridge/src/flow-save-intent.ts apps/bridge/src/flow-save-intent.test.ts apps/bridge/src/flow-api.ts apps/bridge/src/flow-api.test.ts
rtk git commit -m "refactor(flow): separate run extraction from save intent"
```

---

### Task S3: Implement request state, deterministic Candidate saga, and startup scan

**Files:**
- Modify: `apps/bridge/src/flow-save-intent.ts`
- Modify: `apps/bridge/src/flow-save-intent.test.ts`
- Modify: `apps/bridge/src/cli.ts`
- Modify: `apps/bridge/src/flow-api.ts`
- Modify: `apps/bridge/src/flow-api.test.ts`
- Modify: `packages/flow-catalog/src/index.ts`
- Modify: `packages/flow-catalog/src/index.test.ts`
- Modify: `apps/web/src/lib/types.ts`
- Test: `apps/bridge/src/flow-save-intent.integration.test.ts`

- [ ] **Step 1: Run impact before edits**

Run impact for `FlowCatalogStore.save`, `FlowProvenance`, `SqliteEventStore.appendEventOnce`, and Bridge startup wiring in `cli.ts`. Warn before HIGH/CRITICAL changes.

- [ ] **Step 2: Write failing state-machine tests**

Lock these cases:

1. same manual key → same request;
2. same toolCallId → same request;
3. natural request selects latest preceding successful Agent Run by event sequence;
4. current request Run, Flow Run, failed Run, and management-only Run are rejected;
5. dismiss is idempotent and terminal;
6. two concurrent confirms create one deterministic Candidate and one terminal event;
7. imported explicit source is accepted and marked;
8. invalid/unextractable source at request time creates no request/event;
9. 503 leaves an existing request pending with no `FLOW_SAVE_FAILED`;
10. source disappearance or deterministic extraction failure at confirm appends `FLOW_SAVE_FAILED` once;
11. a failed request cannot be confirmed; a new request can use a new source;
12. Candidate provenance stores `sourceRequestId`, survives Catalog reopen/history reads, and is exposed as `source_request_id` by the API;
13. a deterministic ID collision with different provenance is rejected and startup reconciliation does not mark it completed.

- [ ] **Step 3: Write failing crash-window integration tests**

Simulate Catalog save followed by event append failure:

```ts
const request = service.requestManual(input, "manual-key");
events.failNextAppend("FLOW_CANDIDATE_CREATED");
await expect(service.confirm(request.requestId, "confirm-key"))
  .rejects.toThrow("injected_event_failure");
expect(catalog.get(candidateFlowId(request.requestId))?.status).toBe("candidate");

await service.reconcilePendingAtStartup();
expect(latestState(request.requestId)).toBe("completed");
expect(events.listEventsByTarget(request.requestId)
  .filter((event) => event.type === "FLOW_CANDIDATE_CREATED")).toHaveLength(1);
```

- [ ] **Step 4: Run RED**

```bash
rtk proxy pnpm vitest run apps/bridge/src/flow-save-intent.test.ts apps/bridge/src/flow-save-intent.integration.test.ts apps/bridge/src/flow-api.test.ts packages/flow-catalog/src/index.test.ts
```

- [ ] **Step 5: Implement `FlowSaveIntentService`**

```ts
export class FlowSaveIntentService {
  previewPreviousSource(input: {
    sessionId: string;
    currentRunId: string;
  }):
    | { available: true }
    | { available: false; code: "no_extractable_previous_run"; message: string };

  requestManual(input: {
    sessionId: string;
    sourceRunId: string;
    intentSummary?: string;
    nameHint?: string;
  }, idempotencyKey: string): FlowSaveRequest;

  requestFromTool(input: {
    sessionId: string;
    currentRunId: string;
    toolCallId: string;
    intentSummary?: string;
    nameHint?: string;
    sourceScope: "previous_completed_run";
  }): FlowSaveRequest;

  dismiss(requestId: string, idempotencyKey: string): FlowSaveRequestState;
  confirm(requestId: string, idempotencyKey: string): Promise<FlowSaveConfirmResult>;
  reconcilePendingAtStartup(): Promise<number>;
}
```

Request creation validates that an exact extractable source exists **before** appending `FLOW_SAVE_REQUESTED`; an invalid manual source returns the exact §0.2 error and leaves zero events. `previewPreviousSource` performs the same pure selection for dispatch-time Agent tool availability. Confirm revalidates the previously valid source and uses Candidate data derived only from the stored request plus current canonical source evidence; only a confirm-time deterministic invalidation appends `FLOW_SAVE_FAILED`.

- [ ] **Step 6: Implement deterministic Candidate materialization**

Build the same Workflow definition shape used by `POST /v1/flows/candidates`, compile it with `compileWorkflow`, and persist:

```ts
export interface FlowProvenance {
  sourceRunId: string;
  sourceSessionId: string;
  sourceFlowId: string;
  sourceDefinitionRevision: string;
  sourceRequestId?: string;
}

const candidateId = candidateFlowId(request.requestId);
catalog.save({
  flowId: candidateId,
  name: request.nameHint || extracted.name,
  description: extracted.description,
  kind: "runbook",
  status: "candidate",
  source: "agent_generated",
  definitionRevision,
  planIrHash,
  inputs: plan.inputs,
  reviewStatus: "pending",
  gitRevision: null,
  validationIssues: extracted.warnings,
  steps,
  lineageRootFlowId: candidateId,
  parentFlowId: null,
  provenance: {
    ...extracted.provenance,
    sourceRequestId: request.requestId,
  },
  publicationSequence: 0,
});
```

Append `FLOW_CANDIDATE_CREATED` with `request_id`, `flow_id`, `definition_revision`, and `source_run_id` using input hash `flow-save-candidate:<request_id>`.

Before save/reconciliation, if `catalog.get(candidateId)` exists, require `existing.provenance?.sourceRequestId === request.requestId`; otherwise append one failed event with `flow_save_candidate_conflict` and never overwrite the record.

Extend `toApiProvenance` and the Web `FlowProvenance` type with optional `source_request_id`; keep existing provenance fields unchanged.

- [ ] **Step 7: Wire only a startup reconciliation scan**

After constructing the service and before channel connections:

```ts
await flowSaveIntents.reconcilePendingAtStartup().catch((error) => {
  console.error("Flow save intent reconciliation failed:", error);
});
```

Do not add this call to the existing 15-second recovery interval.

- [ ] **Step 8: Run GREEN, build, and inspect scope**

```bash
rtk proxy pnpm vitest run apps/bridge/src/flow-save-intent.test.ts apps/bridge/src/flow-save-intent.integration.test.ts apps/bridge/src/flow-api.test.ts packages/flow-catalog/src/index.test.ts
rtk proxy pnpm --filter @codebridge/flow-catalog build
rtk proxy pnpm --filter @codebridge/bridge build
rtk git diff --check
```

Run `gitnexus_detect_changes()`.

- [ ] **Step 9: Commit**

```bash
rtk git add apps/bridge/src/flow-save-intent.ts apps/bridge/src/flow-save-intent.test.ts apps/bridge/src/flow-save-intent.integration.test.ts apps/bridge/src/cli.ts apps/bridge/src/flow-api.ts apps/bridge/src/flow-api.test.ts packages/flow-catalog/src/index.ts packages/flow-catalog/src/index.test.ts apps/web/src/lib/types.ts
rtk git commit -m "feat(flow): persist and reconcile save intents"
```

---

## PR 2 — Remove the noisy caller, project Timeline state, add write APIs, retire old routes

### Task W0: Remove automatic proposal fetch and Guide cards before returning 410

**Files:**
- Modify: `apps/web/src/components/workbench.tsx`
- Modify: `apps/web/src/components/session-timeline.tsx`
- Modify: `apps/web/src/components/session-timeline.test.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/api.test.ts`
- Modify: `apps/web/src/lib/types.ts`
- Test: `apps/web/src/components/workbench-component-policy.test.ts`

- [ ] **Step 1: Run impact before edits**

Run impact for `Workbench` and `SessionTimeline`. The graph previously rated them LOW, but treat `Workbench` as at least MEDIUM because it is the active Web surface.

- [ ] **Step 2: Replace the tests that lock the bug**

Delete tests expecting a persistent “可整理为 Guide” card. Add policy/component assertions:

```ts
expect(host.textContent).not.toContain("可整理为 Guide");
expect(host.textContent).not.toContain("整理为 Guide");
expect(source).not.toContain("api.flowProposals(");
expect(source).not.toContain("flowProposals={");
```

Keep Web Flow-control-plane “新建 Guide 草稿” tests unchanged; freeform Guide drafting is not this feature.

- [ ] **Step 3: Run RED**

```bash
rtk proxy pnpm vitest run apps/web/src/components/session-timeline.test.tsx apps/web/src/components/workbench-component-policy.test.ts apps/web/src/lib/api.test.ts
```

Expected: the automatic card and fetch still exist.

- [ ] **Step 4: Remove only the active legacy consumption path**

Remove:

- `FlowProposal` Web type;
- `api.flowProposals` and run-based `api.saveGuide`;
- `flowProposals`/`savingGuideRunId` state and fetch;
- `createGuideFromRun`;
- `SessionTimeline` proposal props and automatic card.

Keep `api.createGuide({ flow })`, Guide management UI, Candidate Dry-run, Flow recommendation, and Flow-batch UI.

- [ ] **Step 5: Run GREEN and browser smoke**

```bash
rtk proxy pnpm vitest run apps/web/src/components/session-timeline.test.tsx apps/web/src/components/workbench-component-policy.test.ts apps/web/src/lib/api.test.ts
rtk proxy pnpm --filter @codebridge/web build
rtk proxy pnpm exec playwright test e2e/provider-history-overflow.spec.ts --grep "overflow"
rtk git diff --check
```

Run `gitnexus_detect_changes()`.

- [ ] **Step 6: Commit**

```bash
rtk git add apps/web/src/components/workbench.tsx apps/web/src/components/session-timeline.tsx apps/web/src/components/session-timeline.test.tsx apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts apps/web/src/lib/types.ts apps/web/src/components/workbench-component-policy.test.ts
rtk git commit -m "fix(web): remove automatic Guide save suggestions"
```

---

### Task S4: Project Save Intent into hydrate and live Timeline paths

**Files:**
- Modify: `packages/work-items/src/session-projector.ts`
- Modify: `packages/work-items/src/session-projector.test.ts`
- Modify: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/lib/flow-events.ts`
- Modify: `apps/web/src/lib/flow-events.test.ts`
- Modify: `apps/web/src/lib/session-store.ts`
- Modify: `apps/web/src/lib/session-store.test.ts`

- [ ] **Step 1: Run impact before edits**

Run impact for `projectSessionEvent`, `applyFlowEvent`, and `SessionViewStore.apply`. Warn before the expected HIGH/CRITICAL projector blast radius.

- [ ] **Step 2: Write failing hydrate and live tests**

Both paths must produce the same block:

```ts
expect(block).toMatchObject({
  block_id: "flow_save:fsr_one",
  kind: "flow_save_request",
  status: "pending",
  metadata: {
    request_id: "fsr_one",
    source_run_id: "run_source",
    source_imported: false,
  },
});
```

Then replay dismissed, failed, and candidate-created events; assert the same block ID updates instead of adding blocks. Assert an out-of-order older event cannot regress completed state.

- [ ] **Step 3: Run RED**

```bash
rtk proxy pnpm vitest run packages/work-items/src/session-projector.test.ts apps/web/src/lib/flow-events.test.ts apps/web/src/lib/session-store.test.ts
```

- [ ] **Step 4: Add the Timeline kind and shared event reducer**

Extend `TimelineBlockView.kind` with `"flow_save_request"`.

Add a pure reducer that maps:

```ts
const statusByType = {
  FLOW_SAVE_REQUESTED: "pending",
  FLOW_SAVE_DISMISSED: "dismissed",
  FLOW_CANDIDATE_CREATED: "completed",
  FLOW_SAVE_FAILED: "failed",
} as const;
```

Persistent projector and Web live reducer use block ID `flow_save:<request_id>` and merge metadata. Do not add these event types to `isFlowProjectionEvent`; Save Intent is not Flow execution.

- [ ] **Step 5: Apply Save Intent before the Flow execution gate**

```ts
const saveIntentApplied = applyFlowSaveIntentEvent(
  current.snapshot.timeline.turns,
  event,
);
if (saveIntentApplied !== current.snapshot.timeline.turns) {
  // update snapshot and last_event_sequence, then notify
}
```

Unknown/non-Save events continue through the existing Flow/Agent paths.

- [ ] **Step 6: Run GREEN, build, and inspect scope**

```bash
rtk proxy pnpm vitest run packages/work-items/src/session-projector.test.ts apps/web/src/lib/flow-events.test.ts apps/web/src/lib/session-store.test.ts
rtk proxy pnpm --filter @codebridge/work-items build
rtk proxy pnpm --filter @codebridge/web build
rtk git diff --check
```

Run `gitnexus_detect_changes()`.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/work-items/src/session-projector.ts packages/work-items/src/session-projector.test.ts apps/web/src/lib/types.ts apps/web/src/lib/flow-events.ts apps/web/src/lib/flow-events.test.ts apps/web/src/lib/session-store.ts apps/web/src/lib/session-store.test.ts
rtk git commit -m "feat(flow): project save intent timeline state"
```

---

### Task S5: Add the three write APIs with exact status codes

**Files:**
- Modify: `apps/bridge/src/flow-api.ts`
- Modify: `apps/bridge/src/flow-api.test.ts`
- Modify: `apps/bridge/src/cli.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/api.test.ts`
- Modify: `apps/web/src/lib/types.ts`

- [ ] **Step 1: Run impact before edits**

Run impact for `createFlowApp` and `FlowSaveIntentService` public methods.

- [ ] **Step 2: Write failing Bridge API tests**

Cover:

```text
POST /v1/sessions/:session_id/flow-save-requests
POST /v1/flow-save-requests/:request_id/confirm
POST /v1/flow-save-requests/:request_id/dismiss
```

Require bearer auth and `Idempotency-Key`. Assert:

- missing key/body → 400;
- missing Session/request/source → 404;
- wrong/missing Session or source → exact 404; current/Flow/management/unextractable source → `409 source_run_not_extractable`; non-succeeded source → `409 source_run_not_succeeded`;
- repeated request/confirm/dismiss → identical domain outcome;
- transient Catalog failure → 503 and pending state;
- confirm success → 201 with Candidate and request state;
- already completed confirm → 200 with the existing Candidate for any replay of that immutable `request_id`; the `Idempotency-Key` header remains required for transport retry discipline but does not create a second confirm command;
- dismissed confirm → `409 flow_save_request_already_dismissed`; other stale transitions → `409 flow_save_request_state_conflict`.

- [ ] **Step 3: Write failing Web API contract tests**

```ts
await api.requestFlowSave("sess_1", "run_1", "request-key");
await api.confirmFlowSave("fsr_one", "confirm-key");
await api.dismissFlowSave("fsr_one", "dismiss-key");

for (const call of fetch.mock.calls.slice(-3)) {
  expect(new Headers((call[1] as RequestInit).headers).get("Idempotency-Key"))
    .toMatch(/-key$/);
}
```

- [ ] **Step 4: Run RED**

```bash
rtk proxy pnpm vitest run apps/bridge/src/flow-api.test.ts apps/web/src/lib/api.test.ts
```

- [ ] **Step 5: Register routes as thin adapters**

Routes validate transport fields and call the service; they do not duplicate source selection, state transitions, extraction, or Candidate construction.

```ts
const key = c.req.header("idempotency-key")?.trim();
if (!key) return c.json({ error: "idempotency_key_required" }, 400);
```

Map service errors with one function:

```ts
function flowSaveHttpError(error: FlowSaveIntentError) {
  return {
    status: error.code === "flow_catalog_unavailable" ? 503
      : error.code === "flow_save_request_not_found"
        || error.code === "source_run_not_found" ? 404
      : 409,
    body: { error: error.code, ...error.details },
  } as const;
}
```

- [ ] **Step 6: Add caller-owned Web methods and types**

The API layer receives keys from Workbench; it never generates them:

```ts
requestFlowSave(sessionId, sourceRunId, key)
confirmFlowSave(requestId, key)
dismissFlowSave(requestId, key)
```

- [ ] **Step 7: Run GREEN and build**

```bash
rtk proxy pnpm vitest run apps/bridge/src/flow-api.test.ts apps/web/src/lib/api.test.ts
rtk proxy pnpm --filter @codebridge/bridge build
rtk proxy pnpm --filter @codebridge/web build
rtk git diff --check
```

Run `gitnexus_detect_changes()`.

- [ ] **Step 8: Commit**

```bash
rtk git add apps/bridge/src/flow-api.ts apps/bridge/src/flow-api.test.ts apps/bridge/src/cli.ts apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts apps/web/src/lib/types.ts
rtk git commit -m "feat(flow): add save intent write APIs"
```

---

### Task S6: Retire proposal and run-based Guide write paths with 410

**Files:**
- Modify: `apps/bridge/src/flow-api.ts`
- Modify: `apps/bridge/src/flow-api.test.ts`
- Modify: `apps/bridge/src/channel-ingress.ts`
- Modify: `apps/bridge/src/channel-ingress.test.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/router/src/channel-flow-controller.ts`
- Modify: `packages/router/src/channel-flow-controller.test.ts`
- Modify: `packages/channel-feishu/src/bridge.ts`
- Modify: `packages/channel-telegram/src/telegram-bridge.ts`

- [ ] **Step 1: Run impact before edits**

Run impact for `createFlowApp`, `ChannelSessionIngress.saveLatestGuide`, and `handleChannelFlowCommand`.

- [ ] **Step 2: Write failing deprecation tests**

Assert:

```ts
expect(await getFlowProposals()).toMatchObject({
  status: 410,
  body: { error: "flow_proposals_deprecated" },
});
expect(await postRunBasedGuide()).toMatchObject({
  status: 410,
  body: { error: "run_guide_save_deprecated" },
});
expect(await postBodyFlowGuideDraft()).toMatchObject({ status: 201 });
```

Channel `/flow guide save` must answer that explicit Save Intent/Web confirmation replaces the command; it must not call `saveLatestGuide` or write Catalog.

- [ ] **Step 3: Run RED**

```bash
rtk proxy pnpm vitest run apps/bridge/src/flow-api.test.ts apps/bridge/src/channel-ingress.test.ts packages/router/src/channel-flow-controller.test.ts
```

- [ ] **Step 4: Return hard 410 responses and delete write plumbing**

Keep `POST /v1/flows/guides` with `{ flow }` for Web Guide drafts. Any run/session body returns 410 without reading the Run.

Remove `saveLatestGuide` from core/router/channel ingress interfaces and both channel adapters. Do not leave a compatibility call returning an empty list or fake success.

- [ ] **Step 5: Run GREEN and repository search**

```bash
rtk proxy pnpm vitest run apps/bridge/src/flow-api.test.ts apps/bridge/src/channel-ingress.test.ts packages/router/src/channel-flow-controller.test.ts packages/channel-feishu/src/bridge-lifecycle.test.ts packages/channel-telegram/src/telegram-bridge.test.ts
rtk rg -n "flowProposals|saveLatestGuide|run_guide_save" apps packages
rtk proxy pnpm --filter @codebridge/core build
rtk proxy pnpm --filter @codebridge/router build
rtk proxy pnpm --filter @codebridge/bridge build
rtk git diff --check
```

Expected search results are only deprecation route/tests and design/history docs.

Run `gitnexus_detect_changes()`.

- [ ] **Step 6: Commit**

```bash
rtk git add apps/bridge/src/flow-api.ts apps/bridge/src/flow-api.test.ts apps/bridge/src/channel-ingress.ts apps/bridge/src/channel-ingress.test.ts packages/core/src/types.ts packages/router/src/channel-flow-controller.ts packages/router/src/channel-flow-controller.test.ts packages/channel-feishu/src/bridge.ts packages/channel-telegram/src/telegram-bridge.ts
rtk git commit -m "refactor(flow): retire implicit run save paths"
```

---

## PR 3 — Internal Agent tool and canonical event translator

### Task A1: Expose one read-only internal tool to ACP and Pi

**Files:**
- Create: `packages/core/src/flow-save-tool.ts`
- Create: `packages/core/src/flow-save-tool.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `apps/bridge/src/cli.ts`
- Test: `apps/bridge/src/session-runtime-api.test.ts`
- Create: `packages/runner-host/src/flow-save-mcp-server.ts`
- Create: `packages/runner-host/src/flow-save-mcp-server.test.ts`
- Modify: `packages/runner-host/src/cli.ts`
- Modify: `packages/runner-host/src/server.ts`
- Modify: `packages/runner-host/src/server.test.ts`
- Create: `packages/backends/src/pi-flow-save-tool.ts`
- Create: `packages/backends/src/pi-flow-save-tool.test.ts`
- Modify: `packages/backends/src/pi-session-runner.ts`
- Modify: `packages/backends/src/pi-session-runner.test.ts`
- Modify: `packages/backends/src/acp/acp-active-session.ts`
- Modify: `packages/backends/src/acp/acp-active-session.test.ts`

- [ ] **Step 1: Run impact before edits**

Run impact for `RunContext`, `RunnerHost.executeRunInner`, `createNativePiSession`, and `openActiveSession`. These are active Agent launch paths; stop before HIGH/CRITICAL edits and report the affected processes.

- [ ] **Step 2: Write failing shared-schema tests**

Validate only:

```ts
{
  source_scope: "previous_completed_run",
  intent_summary?: string <= 240 chars,
  name_hint?: string <= 80 chars,
}
```

Reject arbitrary `run_id`, `session_id`, Candidate fields, and extra properties. Assert the tool description says to call only after explicit user save intent and that it never claims the Flow is already saved.

- [ ] **Step 3: Write failing adapter tests**

- Bridge `resolveRequest` uses `previewPreviousSource` and adds a read-only `flowSaveSourceAvailability` snapshot to `RunRequest`/`RunContext`; it contains no source Run ID.
- ACP new/load/resume receives exactly one stdio server named `codebridge-internal` in addition to any future caller-owned MCP list; availability is passed as MCP-process env.
- Pi `createAgentSession` receives the custom tool closed over the same availability snapshot.
- Both available calls return the exact accepted `flow_save_request/v1` marker; both unavailable calls return `accepted: false` plus the fixed Turn-menu message.
- Tool execution never performs HTTP, Catalog, SQLite, file, or shell writes.

- [ ] **Step 4: Run RED**

```bash
rtk proxy pnpm vitest run packages/core/src/flow-save-tool.test.ts packages/runner-host/src/flow-save-mcp-server.test.ts packages/runner-host/src/server.test.ts packages/backends/src/pi-flow-save-tool.test.ts packages/backends/src/pi-session-runner.test.ts packages/backends/src/acp/acp-active-session.test.ts apps/bridge/src/session-runtime-api.test.ts
```

- [ ] **Step 5: Add the shared contract**

```ts
export const FLOW_SAVE_TOOL_MARKER = "flow_save_request/v1" as const;
export const FLOW_SAVE_TOOL_NAME = "codebridge.request_flow_save" as const;

export interface RequestFlowSaveInput {
  source_scope: "previous_completed_run";
  intent_summary?: string;
  name_hint?: string;
}

export interface RequestFlowSaveOutput {
  codebridge_internal_tool: typeof FLOW_SAVE_TOOL_MARKER;
  accepted: boolean;
  source_scope: "previous_completed_run";
  code?: "no_extractable_previous_run";
  message?: string;
}
```

- [ ] **Step 6: Implement the stdio MCP and Pi projection**

The MCP executable registers one tool and writes protocol frames only to stdout. Logs go to stderr. Runner passes an absolute Node executable, built script path, and non-sensitive availability env through ACP `mcpServers` for new/load/resume.

Pi uses a `ToolDefinition` with the same schema/output and `customTools: [createPiFlowSaveTool(ctx.flowSaveSourceAvailability)]`.

- [ ] **Step 7: Run GREEN, builds, and scope check**

```bash
rtk proxy pnpm vitest run packages/core/src/flow-save-tool.test.ts packages/runner-host/src/flow-save-mcp-server.test.ts packages/runner-host/src/server.test.ts packages/backends/src/pi-flow-save-tool.test.ts packages/backends/src/pi-session-runner.test.ts packages/backends/src/acp/acp-active-session.test.ts apps/bridge/src/session-runtime-api.test.ts
rtk proxy pnpm --filter @codebridge/core build
rtk proxy pnpm --filter @codebridge/backends build
rtk proxy pnpm --filter @codebridge/runner-host build
rtk git diff --check
```

Run `gitnexus_detect_changes()`.

- [ ] **Step 8: Commit**

```bash
rtk git add packages/core/src/flow-save-tool.ts packages/core/src/flow-save-tool.test.ts packages/core/src/index.ts packages/core/src/types.ts apps/bridge/src/cli.ts apps/bridge/src/session-runtime-api.test.ts packages/runner-host/src/flow-save-mcp-server.ts packages/runner-host/src/flow-save-mcp-server.test.ts packages/runner-host/src/cli.ts packages/runner-host/src/server.ts packages/runner-host/src/server.test.ts packages/backends/src/pi-flow-save-tool.ts packages/backends/src/pi-flow-save-tool.test.ts packages/backends/src/pi-session-runner.ts packages/backends/src/pi-session-runner.test.ts packages/backends/src/acp/acp-active-session.ts packages/backends/src/acp/acp-active-session.test.ts
rtk git commit -m "feat(agent): expose Flow save request tool"
```

---

### Task A2: Translate only successful correlated tool completion into Save Intent

**Files:**
- Create: `apps/bridge/src/flow-save-tool-translator.ts`
- Create: `apps/bridge/src/flow-save-tool-translator.test.ts`
- Modify: `apps/bridge/src/cli.ts`
- Test: `apps/bridge/src/session-runtime-api.test.ts`

- [ ] **Step 1: Run impact before edits**

Run impact for the Bridge `RunExecutor` `onEvent` callback wiring and `FlowSaveIntentService.requestFromTool`. Do not change `RunExecutor.persistAgentEvent`; the canonical Agent event must already be committed before translation.

- [ ] **Step 2: Write failing translator tests**

Cover:

- tool start only → no request;
- failed tool end → no request;
- successful end without marker → no request;
- successful marker with `accepted: false` → no request, and the Agent receives the fixed Turn-menu fallback from tool output;
- marker without persisted matching start/toolCallId → no request and warning;
- successful marker + correlated valid start → one request;
- repeated end/replayed provider event → same request;
- arbitrary `run_id` in tool input → validation failure/no request;
- current Run never becomes its own source;
- translator failure does not change the main Agent Run to failed.

- [ ] **Step 3: Run RED**

```bash
rtk proxy pnpm vitest run apps/bridge/src/flow-save-tool-translator.test.ts apps/bridge/src/session-runtime-api.test.ts
```

- [ ] **Step 4: Implement persisted correlation**

```ts
translate(run: Run, event: AgentEvent): FlowSaveRequest | null {
  if (!isSuccessfulFlowSaveToolEnd(event)) return null;
  const start = [...this.events.listEvents(run.workItemId)].reverse().find((candidate) =>
    candidate.runId === run.id
    && isMatchingFlowSaveToolStart(candidate, event.toolCallId)
  );
  if (!start) return null;
  const input = parseRequestFlowSaveInput(agentEvent(start).input);
  return this.intents.requestFromTool({
    sessionId: run.sessionId!,
    currentRunId: run.id,
    toolCallId: event.toolCallId!,
    ...input,
  });
}
```

Use persisted events, not an in-memory start map, so Bridge restart between start and end cannot corrupt correlation.

- [ ] **Step 5: Wire the translator after existing Session identity handling**

The `onEvent` callback keeps the current `session` event behavior, then invokes the translator for candidate tool ends. Catch/log infrastructure errors without rewriting Agent result events or claiming success to channels.

- [ ] **Step 6: Run GREEN and build**

```bash
rtk proxy pnpm vitest run apps/bridge/src/flow-save-tool-translator.test.ts apps/bridge/src/session-runtime-api.test.ts
rtk proxy pnpm --filter @codebridge/bridge build
rtk git diff --check
```

Run `gitnexus_detect_changes()`.

- [ ] **Step 7: Commit**

```bash
rtk git add apps/bridge/src/flow-save-tool-translator.ts apps/bridge/src/flow-save-tool-translator.test.ts apps/bridge/src/cli.ts apps/bridge/src/session-runtime-api.test.ts
rtk git commit -m "feat(flow): translate Agent save intent events"
```

---

## PR 4 — Web Turn action and persisted confirmation card

### Task W1: Complete the Web Save Intent interaction

**Files:**
- Create: `apps/web/src/components/flow-save-request-card.tsx`
- Create: `apps/web/src/components/flow-save-request-card.test.tsx`
- Modify: `apps/web/src/components/session-timeline.tsx`
- Modify: `apps/web/src/components/session-timeline.test.tsx`
- Modify: `apps/web/src/components/workbench.tsx`
- Modify: `apps/web/src/components/workbench-component-policy.test.ts`
- Test: `e2e/flow-save-intent.spec.ts`

- [ ] **Step 1: Run impact before edits**

Run impact for `SessionTimeline` and `Workbench`; report the active-surface risk.

- [ ] **Step 2: Write failing pure card tests**

State/action matrix:

| Status | Required UI | Allowed actions |
|---|---|---|
| pending | source summary; imported warning when applicable | `保存为 Candidate`, `忽略` |
| confirming | disabled actions + spinner | none |
| completed | Candidate name/ID | `打开 Candidate` |
| dismissed | “已忽略” | none |
| failed | exact reason; “从 Turn 菜单重新选择来源” | none on old request |
| transient local error | error text | retry confirm with same key |

The card is presentation-only: it receives callbacks and never imports `api`, `crypto`, or stores.

- [ ] **Step 3: Write failing Turn-menu and Workbench tests**

Assert every eligible succeeded Agent Assistant Turn has an accessible `Turn 操作` menu containing `存为 Flow`. Running/failed/cancelled Turns, Flow Runtime Runs, user-only Turns, approval/permission-only Turns, and a source Run that already has a pending/completed request do not show the action. Imported Turns are allowed and receive the warning after request creation.

Assert Workbench:

- creates request key on click;
- reuses same confirm key after unknown outcome;
- clears key on known success/terminal response/Session switch;
- creates a new request key for a later explicit action;
- never synthesizes Timeline blocks locally;
- opens the returned Candidate detail but does not bind it.

- [ ] **Step 4: Write failing Playwright closed-loop tests**

Use deterministic Bridge fixtures:

1. successful Agent Run → Turn menu → `存为 Flow` → persisted requested card;
2. refresh page → card remains;
3. confirm → one Candidate → card completed → Candidate opens;
4. Candidate Dry-run remains available and does not bind Session;
5. dismiss → refresh → still dismissed;
6. imported source → warning shown;
7. unknown confirm response → same-key retry;
8. 503 → pending card remains;
9. deterministic failed source → failed card, no retry on same request;
10. long names/reasons at 320/768/1280/1536 widths do not overflow.
11. delayed response from Session A after switching to Session B does not create/update B’s request card.

- [ ] **Step 5: Run RED**

```bash
rtk proxy pnpm vitest run apps/web/src/components/flow-save-request-card.test.tsx apps/web/src/components/session-timeline.test.tsx apps/web/src/components/workbench-component-policy.test.ts
rtk proxy pnpm exec playwright test e2e/flow-save-intent.spec.ts
```

- [ ] **Step 6: Implement the pure card and Turn menu**

Render `flow_save_request` in `TimelineBlock`. Add a per-Turn action component with local open state and callback `onRequestFlowSave(runId)`; do not restore a constant post-Run banner.

- [ ] **Step 7: Implement caller-owned command keys**

```ts
const flowSaveCommand = useRef<{
  sessionId: string;
  requestId?: string;
  phase: "request" | "confirm" | "dismiss";
  key: string;
} | null>(null);
```

Create with `crypto.randomUUID()` at the user action boundary. Reuse only for unknown-outcome retry of that command. Snapshot/SSE remains the only source of card state.

- [ ] **Step 8: Run GREEN, browser tests, and build**

```bash
rtk proxy pnpm vitest run apps/web/src/components/flow-save-request-card.test.tsx apps/web/src/components/session-timeline.test.tsx apps/web/src/components/workbench-component-policy.test.ts apps/web/src/lib/session-store.test.ts
rtk proxy pnpm exec playwright test e2e/flow-save-intent.spec.ts
rtk proxy pnpm --filter @codebridge/web build
rtk git diff --check
```

Run `gitnexus_detect_changes()`.

- [ ] **Step 9: Commit**

```bash
rtk git add apps/web/src/components/flow-save-request-card.tsx apps/web/src/components/flow-save-request-card.test.tsx apps/web/src/components/session-timeline.tsx apps/web/src/components/session-timeline.test.tsx apps/web/src/components/workbench.tsx apps/web/src/components/workbench-component-policy.test.ts e2e/flow-save-intent.spec.ts
rtk git commit -m "feat(web): confirm explicit Flow save intents"
```

---

## PR 5 — Feishu status projection after Web is reachable

### Task F1: Show the Save Intent request on the existing Feishu Run card

**Files:**
- Modify: `packages/channel-feishu/src/session-watcher.ts`
- Modify: `packages/channel-feishu/src/session-watcher.test.ts`
- Modify: `packages/channel-feishu/src/bridge-recovery.test.ts`
- Test: `apps/integration/session-event-contract.integration.test.ts`

- [ ] **Step 1: Verify the Web destination first**

Run the W1 Playwright confirm/dismiss tests against the built Web app. If the card is not reachable, stop; do not add “前往 Web”.

- [ ] **Step 2: Run impact before edits**

Run impact for `FeishuSessionWatcher.handle` and recovery/replay methods. Warn before HIGH/CRITICAL changes.

- [ ] **Step 3: Write failing live/replay tests**

Assert `FLOW_SAVE_REQUESTED` adds a short footer to the same Run card:

```text
已记录“存为 Flow”请求。请前往 Web 确认；尚未创建 Candidate。
```

Replaying the same request event before Delivery completion updates the same CardKit card and never sends a detached duplicate message. Later Web dismiss/confirm does not keep the finished channel Delivery open and does not add a second cross-channel subscription; Web owns the request terminal state.

- [ ] **Step 4: Run RED**

```bash
rtk proxy pnpm vitest run packages/channel-feishu/src/session-watcher.test.ts packages/channel-feishu/src/bridge-recovery.test.ts apps/integration/session-event-contract.integration.test.ts
```

- [ ] **Step 5: Implement adapter-only presentation state**

Store the request notice in the in-memory/replayed Run-card projection and compose it into the existing card content through Run terminal rendering. Do not call request/confirm/dismiss APIs, wait for later Web terminal events, or add a second timer/detached status surface.

- [ ] **Step 6: Run GREEN and build**

```bash
rtk proxy pnpm vitest run packages/channel-feishu/src/session-watcher.test.ts packages/channel-feishu/src/bridge-recovery.test.ts apps/integration/session-event-contract.integration.test.ts
rtk proxy pnpm --filter @codebridge/channel-feishu build
rtk git diff --check
```

Run `gitnexus_detect_changes()`.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/channel-feishu/src/session-watcher.ts packages/channel-feishu/src/session-watcher.test.ts packages/channel-feishu/src/bridge-recovery.test.ts apps/integration/session-event-contract.integration.test.ts
rtk git commit -m "feat(feishu): surface Flow save intent status"
```

---

## PR 6 — Telegram contract and independent acceptance

### Task T1: Project the Save Intent request into the existing Telegram pending message

**Files:**
- Modify: `packages/channel-telegram/src/telegram-session-watcher.ts`
- Modify: `packages/channel-telegram/src/telegram-session-watcher.test.ts`
- Modify: `packages/channel-telegram/src/telegram-bridge.test.ts`

- [ ] **Step 1: Run impact before edits**

Run impact for `TelegramSessionWatcher.handle` and recovery replay. Telegram remains production-disabled; do not claim reachable/closed-loop from tests alone.

- [ ] **Step 2: Write failing live/recovery tests**

Use the same requested notice as Feishu. Assert the existing pending message is edited, the notice survives that Run’s terminal edit, no new message is sent, duplicate replay is idempotent, and no Catalog/write API is called. Later Web terminal events are not a Telegram responsibility.

- [ ] **Step 3: Run RED**

```bash
rtk proxy pnpm vitest run packages/channel-telegram/src/telegram-session-watcher.test.ts packages/channel-telegram/src/telegram-bridge.test.ts
```

- [ ] **Step 4: Implement the adapter projection**

Consume canonical `FLOW_SAVE_REQUESTED` and compose the notice into the same pending/terminal Telegram message. Domain state and error codes remain in Bridge.

- [ ] **Step 5: Run GREEN and build**

```bash
rtk proxy pnpm vitest run packages/channel-telegram/src/telegram-session-watcher.test.ts packages/channel-telegram/src/telegram-bridge.test.ts
rtk proxy pnpm --filter @codebridge/channel-telegram build
rtk git diff --check
```

Run `gitnexus_detect_changes()`.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/channel-telegram/src/telegram-session-watcher.ts packages/channel-telegram/src/telegram-session-watcher.test.ts packages/channel-telegram/src/telegram-bridge.test.ts
rtk git commit -m "feat(telegram): surface Flow save intent status"
```

Record in release notes: Telegram implementation is tested but not active; complete real-bot verification when the channel is enabled.

---

## PR 7 — Adversarial verification, Surface Matrix closure, and deployment

### Task V1: Run cross-layer adversarial verification

**Files:**
- Modify: `docs/superpowers/specs/2026-08-25-flow-save-intent-design.md` (status only after all gates pass)
- Create: `docs/superpowers/specs/2026-08-25-flow-save-intent-verification.md`

- [ ] **Step 1: Run domain and crash adversarial suites**

```bash
rtk proxy pnpm vitest run \
  apps/bridge/src/flow-save-intent.test.ts \
  apps/bridge/src/flow-save-intent.integration.test.ts \
  apps/bridge/src/flow-save-tool-translator.test.ts \
  apps/bridge/src/flow-api.test.ts \
  packages/work-items/src/session-projector.test.ts
```

Verify concurrent confirm, replay, crash between stores, startup repair, source deletion, imported source, management-tool filtering, and no automatic request after ordinary successful Runs.

- [ ] **Step 2: Run Agent adapter suites**

```bash
rtk proxy pnpm vitest run \
  packages/core/src/flow-save-tool.test.ts \
  packages/runner-host/src/flow-save-mcp-server.test.ts \
  packages/runner-host/src/server.test.ts \
  packages/backends/src/pi-flow-save-tool.test.ts \
  packages/backends/src/pi-session-runner.test.ts \
  packages/backends/src/acp/acp-active-session.test.ts
```

Verify ACP new/load/resume and Pi both expose the tool; LLM/provider text without a real tool event cannot create a request.

- [ ] **Step 3: Run every active presentation surface independently**

```bash
rtk proxy pnpm vitest run \
  apps/web/src/components/flow-save-request-card.test.tsx \
  apps/web/src/components/session-timeline.test.tsx \
  apps/web/src/lib/session-store.test.ts \
  packages/channel-feishu/src/session-watcher.test.ts \
  packages/channel-feishu/src/bridge-recovery.test.ts \
  packages/channel-telegram/src/telegram-session-watcher.test.ts \
  packages/channel-telegram/src/telegram-bridge.test.ts \
  apps/integration/session-event-contract.integration.test.ts
```

- [ ] **Step 4: Exercise the real local Agent decision boundary**

Build/restart Runner, Bridge, and Web with the normal project scripts. In a real Web Session:

1. complete an extractable business task;
2. send “请把刚才这套流程存为 Flow”；
3. verify the real ACP/Pi Agent calls the internal tool, one request card appears, and Catalog remains unchanged before confirm;
4. in a fresh ordinary task send “把查询结果保存成文件”；
5. verify no Flow Save Intent is created;
6. repeat the explicit request after a Session with no prior extractable Run and verify the Agent returns the exact Turn-menu fallback with no request event.

Record Session IDs and canonical event sequences in verification evidence, but do not make them test dependencies.

- [ ] **Step 5: Run Web closed-loop and overflow tests**

```bash
rtk proxy pnpm exec playwright test e2e/flow-save-intent.spec.ts e2e/provider-history-overflow.spec.ts
```

At 320, 768, 1280, and 1536 widths assert:

```ts
expect(await page.evaluate(() => document.documentElement.scrollWidth))
  .toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
```

Buttons must remain reachable; do not pass by clipping the page or hiding errors.

- [ ] **Step 6: Run builds and full affected regression**

```bash
rtk proxy pnpm --filter @codebridge/core build
rtk proxy pnpm --filter @codebridge/work-items build
rtk proxy pnpm --filter @codebridge/backends build
rtk proxy pnpm --filter @codebridge/runner-host build
rtk proxy pnpm --filter @codebridge/router build
rtk proxy pnpm --filter @codebridge/bridge build
rtk proxy pnpm --filter @codebridge/web build
rtk proxy pnpm --filter @codebridge/channel-feishu build
rtk proxy pnpm --filter @codebridge/channel-telegram build
rtk git diff --check
```

- [ ] **Step 7: Re-run the completion Surface Matrix**

Record `implemented`, `reachable`, `closed-loop`, and `planned` independently:

- Web must be closed-loop through confirm/dismiss/Candidate open.
- Agent must be reachable for ACP and Pi through a real tool event fixture.
- Feishu may be marked reachable only after active Bridge/CardKit request-notice verification; Candidate confirmation remains closed-loop only in Web.
- Telegram must remain `implemented + planned`, not reachable/closed-loop, until enabled.

- [ ] **Step 8: Run final GitNexus and dirty-tree audit**

Run `gitnexus_detect_changes()` and verify every affected flow is expected. Then:

```bash
rtk git status --short
rtk git diff --stat origin/main...HEAD
rtk git log --oneline origin/main..HEAD
```

Do not stage the preserved user files listed in §0.9.

- [ ] **Step 9: Write verification evidence and mark accepted implementation**

The verification document records exact commands, test counts, active process build/version, Surface Matrix, known Telegram limitation, and any remaining risks. Change the design status only if all non-Telegram gates pass.

- [ ] **Step 10: Commit verification**

```bash
rtk git add docs/superpowers/specs/2026-08-25-flow-save-intent-design.md docs/superpowers/specs/2026-08-25-flow-save-intent-verification.md
rtk git commit -m "docs: verify explicit Flow save intent"
```

---

## Completion definition

The feature is complete only when all statements are true:

1. An ordinary successful Agent Run creates no Save Intent and no automatic Guide card.
2. A user can explicitly select a succeeded Assistant Turn and obtain one persisted confirmation card.
3. A real ACP/Pi internal tool call produces the same request path without choosing arbitrary IDs.
4. Refresh/restart/replay preserves one request and one card state.
5. Confirm creates exactly one Candidate Runbook with provenance, never binds it, and opens existing Dry-run/review flows.
6. Dismiss and deterministic failure are immutable; repeated user intent creates a new request.
7. Catalog 503/unknown transport outcomes do not lie by marking the request failed.
8. Startup reconciliation closes the Catalog-saved/event-missing crash window without a timer.
9. Old proposal and run-based Guide paths return 410 only after active Web callers are gone.
10. Feishu never claims “前往 Web” before the Web card is reachable; Telegram remains honestly marked disabled.
11. Agent, channel, and Web adapters contain no duplicate Flow state machine or Catalog write.
12. Contract tests, active-surface tests, builds, GitNexus detect-changes, and the final Surface Matrix all pass.
