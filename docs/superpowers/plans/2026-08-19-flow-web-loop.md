> 历史记录：Flow 功能已于 2026-09-23 进入完整移除；本文保留设计/验收审计，不再描述当前可用功能。当前范围见 `docs/plans/2026-09-23-remove-flow.md`。

# Flow Web Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Flow evidence chain visible after refresh — projector writes `flow_*` timeline blocks; Web renders them, with a Flow detail form (controlled values, independent submit) and Playwright e2e — per `docs/superpowers/specs/2026-08-19-flow-web-loop-design.md`.

**Architecture:** Timeline is server-authoritative. Task 1.5 changes `projectSessionEvent` (no new HTTP). Web hydrates that timeline. `applyFlowEvent` is optional live acceleration only and must merge metadata; it must not be the refresh path. FlowDetail values live in workbench; 409 does not remount; FlowDetail submit calls `sendMessage` with a synthesized message.

**Tech Stack:** TypeScript, React, Vitest, @testing-library/react, Playwright (`@playwright/test` + route mock), existing `apps/web` stack.

**Spec:** `docs/superpowers/specs/2026-08-19-flow-web-loop-design.md`
**Backend spec (already landed):** `docs/superpowers/specs/2026-08-19-flow-runtime-loop-design.md`
**Branch:** `feat_flow` (from `origin/main`). Do not commit on `main`. Do not mix with other feature branches.

**Order:** 1 → 1.5 → 2 → 3 → 4 → 5 → 6 → 7.

**Before editing `projectSessionEvent`:** run GitNexus `impact` on it (`direction: "upstream"`). If risk is HIGH/CRITICAL, stop and report; do not ignore.

---

## File map

| File | Responsibility |
| --- | --- |
| `packages/work-items/src/session-projector.ts` | Project PARAM/STEP_*/RUN_SNAPSHOT/VERIFICATION_FAILED → `flow_*` blocks (merge upsert) |
| `packages/work-items/src/session-projector.test.ts` | Projector tests (Task 1.5) |
| `apps/bridge/src/session-runtime-api.ts` | Optional: PARAM_RESOLVED `runId` from `result.run.id` |
| `apps/web/src/lib/types.ts` | `FlowRecord` full fields; `SendMessageInput.inputs/dryRun`; new block kinds |
| `apps/web/src/lib/api.ts` | `fetchFlow`; `sendMessage` inputs/dry_run; `ApiError.body` |
| `apps/web/src/lib/revision-tail.ts` (new) | Hash display: strip `sha256:` prefix, last 8 chars |
| `apps/web/src/lib/flow-run-submit.ts` (new) | Synthesize runbook message; keep submit payload construction testable |
| `apps/web/src/lib/flow-events.ts` (new) | Optional live `applyFlowEvent` (merge upsert; not refresh authority) |
| `apps/web/src/lib/session-store.ts` | Wire live apply only; RUN_* still `refresh_required` |
| `apps/web/src/components/session-timeline.tsx` | Render `flow_*` blocks |
| `apps/web/src/components/flow-detail.tsx` (new) | Controlled values + missing highlight + dry-run |
| `apps/web/src/components/workbench.tsx` | Detail panel, controlled values, independent Flow submit; published binds, candidate does not |
| `apps/web/src/components/session-chrome.tsx` | Flows panel: 「已发布」+「候选」 groups |
| `apps/web/src/components/composer.tsx` | Bound-runbook badge with hash tail; Plus 下拉只列 published |
| `e2e/flow-loop.spec.ts` + `playwright.config.ts` | Browser e2e with full mock surface |

## Event payload contracts (verified in code — do not re-derive)

```ts
STEP_STARTED:   target=stepId, payload { capability_id, risk }
STEP_RETRYING:  target=stepId, payload { attempt, next_attempt, max_attempts, delay_ms, error }
STEP_SUCCEEDED: target=stepId, payload {}
STEP_FAILED:    target=stepId, payload { error }
STEP_SKIPPED:   target=stepId, payload <skipStep payload>
PARAM_RESOLVED: payload { flow_id, flow_revision, field, candidate_value, final_value, resolution, source, resolver_version }  // run_id may be null
RUN_SNAPSHOT:   payload { flow_id, flow_revision, resolved_inputs, steps, outcome, attribution }
VERIFICATION_FAILED: payload { step_id, category, postcondition, actual, truncated }
```

`BRANCH_SELECTED` / `RUN_STARTED` / `RUN_SUCCEEDED` / `RUN_FAILED`: do **not** add new flow cards this round (`RUN_STARTED` already projects `work`).

---

### Task 1: Type sync + API (`FlowRecord`, `inputs`, `ApiError.body`, `fetchFlow`)

**Files:**
- Modify: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/api.test.ts`
- Create: `apps/web/src/lib/revision-tail.ts`
- Create: `apps/web/src/lib/revision-tail.test.ts`

- [ ] **Step 1: Failing API tests**

On `feat_flow`, three tests may **already** be in `apps/web/src/lib/api.test.ts`. If they exist, do not copy them again. If missing, append:

```ts
describe("flow API", () => {
  it("carries inputs and dry_run on sendMessage", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(receipt()));
    vi.stubGlobal("fetch", fetch);
    await api.sendMessage("sess_1", {
      message: "run", flowId: "flow_demo_echo", model: null,
      attachments: [], permissionMode: null, effort: null, idempotencyKey: "k",
      inputs: { text: "hi" }, dryRun: true,
    });
    const body = JSON.parse(String((fetch.mock.calls.at(-1)?.[1] as RequestInit).body));
    expect(body).toMatchObject({ flow_id: "flow_demo_echo", inputs: { text: "hi" }, dry_run: true });
  });

  it("exposes the response body on ApiError for missing_inputs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "missing_inputs",
      missing: [{ id: "text", type: "string", source: "user", reason: "required" }],
    }), { status: 409, headers: { "content-type": "application/json" } })));
    const error = await api.sendMessage("sess_1", {
      message: "run", flowId: "flow_demo_echo", model: null,
      attachments: [], permissionMode: null, effort: null, idempotencyKey: "k2",
    }).catch((caught) => caught) as ApiError;
    expect(error.code).toBe("missing_inputs");
    expect(error.body).toMatchObject({ missing: [{ id: "text" }] });
  });

  it("fetches a flow by id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      flow_id: "flow_demo_echo", plan_ir_hash: "sha256:plan",
    })));
    const flow = await api.fetchFlow("flow_demo_echo");
    expect(flow).toMatchObject({ flow_id: "flow_demo_echo", plan_ir_hash: "sha256:plan" });
  });
});
```

Create `apps/web/src/lib/revision-tail.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { revisionTail } from "./revision-tail";

describe("revisionTail", () => {
  it("strips sha256: and returns the last 8 characters", () => {
    expect(revisionTail("sha256:abcdef0123456789")).toBe("23456789");
  });
  it("returns empty for nullish", () => {
    expect(revisionTail(null)).toBe("");
    expect(revisionTail(undefined)).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/web/src/lib/api.test.ts apps/web/src/lib/revision-tail.test.ts`
Expected: FAIL — `inputs`/`dry_run` missing; `ApiError.body` undefined; `fetchFlow` not defined; `revision-tail` module missing.

- [ ] **Step 3: Implement types + hash helper**

`apps/web/src/lib/revision-tail.ts`:

```ts
export function revisionTail(value: string | null | undefined): string {
  if (!value) return "";
  const colon = value.lastIndexOf(":");
  const hex = colon >= 0 ? value.slice(colon + 1) : value;
  return hex.slice(-8);
}
```

In `apps/web/src/lib/types.ts`:

```ts
export interface FlowInputRecord {
  id: string;
  type: string;
  source: string;
  required: boolean;
  default?: unknown;
  description?: string | null;
}

export interface FlowStepRecord {
  id: string;
  capability: string | null;
  purpose: string | null;
  depends_on: string[];
  mode: string | null;
  approval: "none" | "required";
  branches: Array<{ when: string; next: string }>;
  retry: { max_attempts: number; delay_ms: number } | null;
  success_when: string | null;
}

export interface FlowRecord {
  flow_id: string;
  name: string | null;
  kind: "ephemeral" | "guide" | "runbook";
  status: "draft" | "candidate" | "published" | "deprecated";
  source: string;
  definition_revision: string;
  plan_ir_hash: string | null;
  inputs: FlowInputRecord[];
  steps: FlowStepRecord[];
  review_status: string | null;
  validation_issues: string[];
}
```

Existing `FlowRecord` call sites (`composer.test.tsx` fixture) must add `plan_ir_hash`, `inputs: []`, `steps: []`, `review_status`, `validation_issues` so TypeScript passes.

Extend `TimelineBlockView["kind"]` with `"flow_param" | "flow_step" | "flow_run" | "flow_failure"`.

```ts
export interface SendMessageInput {
  message: string;
  flowId: string | null;
  model: string | null;
  attachments: MessageAttachmentInput[];
  permissionMode: string | null;
  effort: string | null;
  idempotencyKey: string;
  inputs?: Record<string, unknown>;
  dryRun?: boolean;
}
```

- [ ] **Step 4: Implement api**

`ApiError` gains `body`:

```ts
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body: ErrorPayload = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ErrorPayload = {
  error?: string;
  detail?: string;
  details?: string;
  message?: string;
  issues?: string[];
  missing?: Array<{ id: string; type: string; source: string; reason: string }>;
} | null;
```

In `request<T>`, `throw new ApiError(response.status, payload?.error ?? "http_error", message, payload);`

`sendMessage` JSON body adds `inputs: input.inputs`, `dry_run: input.dryRun === true`.

```ts
async function fetchFlow(id: string): Promise<FlowRecord> {
  return request<FlowRecord>("/v1/flows/" + encodeURIComponent(id));
}
```

Export `fetchFlow` on `api`.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run apps/web/src/lib/api.test.ts apps/web/src/lib/revision-tail.test.ts apps/web/src/components/composer.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts \
  apps/web/src/lib/revision-tail.ts apps/web/src/lib/revision-tail.test.ts \
  apps/web/src/components/composer.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): sync FlowRecord types and send inputs on message

EOF
)"
```

---

### Task 1.5: Projector writes `flow_*` timeline blocks

**Files:**
- Modify: `packages/work-items/src/session-projector.ts`
- Modify: `packages/work-items/src/session-projector.test.ts`
- Modify (optional, preferred): `apps/bridge/src/session-runtime-api.ts` (`appendParamResolvedEvents` pass `runId`)

This is the refresh-safe evidence chain. Do this before any Web reducer.

- [ ] **Step 1: Write failing tests**

Append to `packages/work-items/src/session-projector.test.ts`:

```ts
  it("projects STEP_* onto one flow_step block and keeps capability_id after success", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "STEP_STARTED",
      actor: "system",
      target: "echo",
      payload: { capability_id: "demo.echo", risk: "read_only" },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "STEP_SUCCEEDED",
      actor: "system",
      target: "echo",
    });
    const block = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!.blocks
      .find((entry) => entry.kind === "flow_step");
    expect(block).toMatchObject({
      kind: "flow_step",
      status: "passed",
      metadata: expect.objectContaining({
        step_id: "echo",
        capability_id: "demo.echo",
      }),
    });
    store.close();
  });

  it("projects PARAM_RESOLVED, RUN_SNAPSHOT, and VERIFICATION_FAILED", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    store.appendEvent({
      workItemId: item.id,
      type: "PARAM_RESOLVED",
      actor: "user",
      target: "text",
      payload: {
        field: "text",
        final_value: "hi",
        resolution: "confirmed",
        source: "user",
      },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "VERIFICATION_FAILED",
      actor: "adapter",
      target: "concat",
      payload: {
        step_id: "concat",
        category: "verification",
        postcondition: "output.result exists",
        actual: null,
        truncated: false,
      },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "RUN_SNAPSHOT",
      actor: "system",
      payload: {
        flow_id: "flow_demo_echo",
        outcome: "succeeded",
        resolved_inputs: [{ field: "text", value: "hi" }],
        steps: [{
          step_id: "echo",
          capability_id: "demo.echo",
          output_ref: "artifact://a1",
          verification_status: "passed",
        }],
      },
    });
    const kinds = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!.blocks
      .map((block) => block.kind);
    expect(kinds).toEqual(expect.arrayContaining([
      "flow_param",
      "flow_failure",
      "flow_run",
    ]));
    const failure = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!.blocks
      .find((block) => block.kind === "flow_failure");
    expect(failure?.metadata).toMatchObject({
      category: "verification",
      truncated: false,
    });
    store.close();
  });
```

The existing test `"advances the cursor for known no-op event types"` still appends `STEP_STARTED`. After this task that event creates a block — cursor must still advance and `RUN_SUCCEEDED` must still succeed. Do not remove that test; if it starts expecting zero flow blocks, only loosen the assertion, do not put `STEP_STARTED` back into the no-op list.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/work-items/src/session-projector.test.ts`
Expected: FAIL — no `flow_step` / `flow_param` / `flow_run` / `flow_failure` blocks.

- [ ] **Step 3: Implement projector**

Move these types **out** of the no-op list in `projectSessionEvent` and handle them:

- `STEP_STARTED` `STEP_RETRYING` `STEP_SUCCEEDED` `STEP_FAILED` `STEP_SKIPPED`
- `PARAM_RESOLVED`
- `VERIFICATION_FAILED`
- `RUN_SNAPSHOT`

Leave `BRANCH_SELECTED` in the no-op list.

Add helpers (same file). Reuse `updateToolBlock`'s merge UPDATE pattern — do **not** call `ensureBlock` then return on existing (that drops later metadata).

```ts
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function resolveFlowTurn(
  database: DatabaseSync,
  sessionId: string,
  event: DomainEvent,
): { turnId: string; runId: string } | undefined {
  if (event.runId) {
    const turn = findTimelineTurn(database, event.runId);
    if (!turn) return undefined;
    return { turnId: String(turn.turn_id), runId: event.runId };
  }
  const latest = database
    .prepare(
      `SELECT turn_id, run_id FROM session_timeline_turns
       WHERE session_id = ?
       ORDER BY timeline_index DESC
       LIMIT 1`,
    )
    .get(sessionId) as { turn_id?: string; run_id?: string } | undefined;
  if (!latest?.turn_id || !latest.run_id) return undefined;
  return { turnId: String(latest.turn_id), runId: String(latest.run_id) };
}

function upsertFlowBlock(
  database: DatabaseSync,
  sessionId: string,
  event: DomainEvent,
  blockId: string,
  kind: string,
  status: string,
  metadata: Record<string, unknown>,
): void {
  const turn = resolveFlowTurn(database, sessionId, event);
  if (!turn) return;
  const existing = database
    .prepare(
      `SELECT metadata_json FROM session_timeline_blocks WHERE block_id = ?`,
    )
    .get(blockId) as { metadata_json?: string } | undefined;
  if (existing) {
    const current = JSON.parse(existing.metadata_json ?? "{}") as Record<string, unknown>;
    database
      .prepare(
        `UPDATE session_timeline_blocks
         SET status = ?, metadata_json = ?
         WHERE block_id = ?`,
      )
      .run(
        status,
        JSON.stringify(boundMetadata({ ...current, ...metadata })),
        blockId,
      );
    return;
  }
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(block_index), -1) + 1 AS next_index
       FROM session_timeline_blocks
       WHERE turn_id = ?`,
    )
    .get(turn.turnId) as { next_index?: number } | undefined;
  database
    .prepare(
      `INSERT INTO session_timeline_blocks (
        block_id, session_id, turn_id, run_id, block_index, kind, status,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      blockId,
      sessionId,
      turn.turnId,
      turn.runId,
      Number(row?.next_index ?? 0),
      kind,
      status,
      JSON.stringify(boundMetadata({
        started_at: event.occurredAt,
        ...metadata,
      })),
    );
}
```

Switch cases (payload = `asRecord(event.payload)`, `target = String(event.target ?? "")`):

```ts
case "STEP_STARTED": {
  upsertFlowBlock(database, sessionId, event, `flow_step:${event.runId ?? "run"}:${target}`, "flow_step", "running", {
    step_id: target,
    capability_id: payload.capability_id ?? null,
    risk: payload.risk ?? null,
  });
  break;
}
case "STEP_RETRYING": {
  upsertFlowBlock(database, sessionId, event, `flow_step:${event.runId ?? "run"}:${target}`, "flow_step", "retrying", {
    step_id: target,
    attempt: payload.attempt ?? null,
    max_attempts: payload.max_attempts ?? null,
    error: payload.error ?? null,
  });
  break;
}
case "STEP_SUCCEEDED": {
  upsertFlowBlock(database, sessionId, event, `flow_step:${event.runId ?? "run"}:${target}`, "flow_step", "passed", {
    step_id: target,
    ended_at: event.occurredAt,
  });
  break;
}
case "STEP_FAILED": {
  upsertFlowBlock(database, sessionId, event, `flow_step:${event.runId ?? "run"}:${target}`, "flow_step", "failed", {
    step_id: target,
    error: payload.error ?? null,
    ended_at: event.occurredAt,
  });
  break;
}
case "STEP_SKIPPED": {
  upsertFlowBlock(database, sessionId, event, `flow_step:${event.runId ?? "run"}:${target}`, "flow_step", "skipped", {
    step_id: target,
  });
  break;
}
case "PARAM_RESOLVED": {
  const field = typeof payload.field === "string" ? payload.field : target || "?";
  upsertFlowBlock(database, sessionId, event, `flow_param:${event.runId ?? "session"}:${field}`, "flow_param", "confirmed", {
    field,
    candidate_value: payload.candidate_value ?? null,
    final_value: payload.final_value ?? null,
    resolution: payload.resolution ?? "confirmed",
    source: payload.source ?? "user",
    flow_revision: payload.flow_revision ?? null,
  });
  break;
}
case "RUN_SNAPSHOT": {
  const outcome = payload.outcome === "failed" ? "failed" : "succeeded";
  upsertFlowBlock(database, sessionId, event, `flow_run:${event.runId ?? "run"}:snapshot`, "flow_run", outcome, {
    flow_id: payload.flow_id ?? null,
    flow_revision: payload.flow_revision ?? null,
    outcome,
    resolved_inputs: payload.resolved_inputs ?? [],
    steps: payload.steps ?? [],
    attribution: payload.attribution ?? null,
  });
  break;
}
case "VERIFICATION_FAILED": {
  const stepId = typeof payload.step_id === "string" ? payload.step_id : target;
  upsertFlowBlock(database, sessionId, event, `flow_failure:${event.runId ?? "run"}:${stepId}`, "flow_failure", "failed", {
    step_id: stepId,
    category: payload.category ?? "verification",
    postcondition: payload.postcondition ?? null,
    truncated: payload.truncated === true,
  });
  break;
}
```

If no turn exists yet, `upsertFlowBlock` returns without throwing — cursor still advances. Do not use `requireRunId` for `PARAM_RESOLVED`.

Optional: in `appendParamResolvedEvents`, add `runId` when the caller has a run. Signature becomes `(..., runId?: string)` and `appendEvent({ ..., runId })`. Call site after `submitTurn` passes `result.run?.id`. This is not a new route.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/work-items/src/session-projector.test.ts packages/work-items/src/session-runtime.test.ts apps/bridge/src/session-runtime-api.test.ts`
Expected: PASS. After changing `@codebridge/work-items`, run `pnpm --filter @codebridge/work-items build` before Bridge tests (Bridge imports `dist/`).

- [ ] **Step 5: Commit**

```bash
git add packages/work-items/src/session-projector.ts \
  packages/work-items/src/session-projector.test.ts \
  apps/bridge/src/session-runtime-api.ts
git commit -m "$(cat <<'EOF'
feat(work-items): project flow events into timeline blocks

EOF
)"
```

---

### Task 2: Optional live `applyFlowEvent` (not refresh authority)

**Files:**
- Create: `apps/web/src/lib/flow-events.ts`
- Create: `apps/web/src/lib/flow-events.test.ts`
- Modify: `apps/web/src/lib/session-store.ts`

Live-only. `upsertBlock` **must merge** existing metadata. Default branch returns the same array reference so `RUN_STARTED`/`RUN_SUCCEEDED` still `refresh_required` → hydrate projector timeline.

- [ ] **Step 1: Write failing tests**

`apps/web/src/lib/flow-events.test.ts` — same cases as the previous plan draft, **plus**:

```ts
  it("merges STEP_SUCCEEDED onto the started block without dropping capability_id", () => {
    let turns = [turn("run_1")];
    turns = applyFlowEvent(turns, event({
      type: "STEP_STARTED", target: "echo",
      payload: { capability_id: "demo.echo", risk: "read_only" },
    }));
    turns = applyFlowEvent(turns, event({ type: "STEP_SUCCEEDED", target: "echo" }));
    expect(turns[0]!.blocks.at(-1)).toMatchObject({
      kind: "flow_step",
      status: "passed",
      metadata: { step_id: "echo", capability_id: "demo.echo" },
    });
  });
```

Keep: PARAM with `run_id: null` on latest turn; RUN_SNAPSHOT; VERIFICATION_FAILED; unknown types return the same array reference.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/web/src/lib/flow-events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `flow-events.ts`**

Copy the previous reducer, but `upsertBlock` merges:

```ts
function upsertBlock(
  turns: TimelineTurnView[],
  runId: string | null,
  block: TimelineBlockView,
): TimelineTurnView[] {
  const turnIndex = findTurn(turns, runId);
  if (turnIndex < 0) return turns;
  const nextTurns = [...turns];
  const turn = nextTurns[turnIndex]!;
  const existing = turn.blocks.findIndex((candidate) => candidate.block_id === block.block_id);
  const blocks = [...turn.blocks];
  if (existing >= 0) {
    const current = blocks[existing]!;
    blocks[existing] = {
      ...block,
      metadata: { ...current.metadata, ...block.metadata },
      segments: block.segments.length ? block.segments : current.segments,
    };
  } else {
    blocks.push(block);
  }
  nextTurns[turnIndex] = { ...turn, blocks };
  return nextTurns;
}
```

`STEP_SUCCEEDED` / `STEP_RETRYING` / `STEP_FAILED` still call `upsertBlock` with the **same** `block_id` as `STEP_STARTED`.

- [ ] **Step 4: Wire `session-store.ts`**

After the `extractAgentEvent` text/thought branch, before the fall-through `refresh_required`:

```ts
const applied = applyFlowEvent(current.snapshot.timeline.turns, event);
if (applied !== current.snapshot.timeline.turns) {
  this.entries.set(sessionId, {
    snapshot: {
      ...current.snapshot,
      runtime: { ...current.snapshot.runtime, last_event_sequence: event.sequence },
      timeline: { ...current.snapshot.timeline, turns: applied },
    },
    status: "ready",
  });
  this.notify(sessionId);
  return "applied";
}
```

Do not change the fall-through. `RUN_SUCCEEDED` must still `refresh_required` so hydrate loads projector blocks (authority).

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run apps/web/src/lib/flow-events.test.ts apps/web/src/lib/session-store.test.ts`
Expected: PASS. Existing store test that `RUN_STARTED` is `refresh_required` must still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/flow-events.ts apps/web/src/lib/flow-events.test.ts apps/web/src/lib/session-store.ts
git commit -m "$(cat <<'EOF'
feat(web): live-apply flow events without replacing hydrate authority

EOF
)"
```

---

### Task 3: Render `flow_*` blocks in timeline

**Files:**
- Modify: `apps/web/src/components/session-timeline.tsx`
- Create: `apps/web/src/components/session-timeline.test.tsx`

`isProcessKind` stays `thought | work | tool` only — `flow_*` render as singles.

- [ ] **Step 1: Write failing test**

`apps/web/src/components/session-timeline.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionTimeline } from "./session-timeline";
import type { TimelineTurnView } from "@/lib/types";

const baseTurn: TimelineTurnView = {
  timeline_index: 0, turn_id: "run_1", run_id: "run_1", status: "running", blocks: [],
};

function block(overrides: Partial<TimelineTurnView["blocks"][number]>): TimelineTurnView["blocks"][number] {
  return {
    block_id: "b", block_index: 0, kind: "flow_step", status: "running",
    metadata: {}, segments: [], next_segment_cursor: null, ...overrides,
  };
}

const props = {
  activeRunId: null, hasEarlier: false, loadingEarlier: false,
  onLoadEarlier: () => {}, loadingBlockId: null, onLoadSegments: () => {},
};

describe("SessionTimeline flow blocks", () => {
  it("renders a passed flow_step with capability id", () => {
    render(<SessionTimeline {...props} turns={[{ ...baseTurn, blocks: [block({
      kind: "flow_step", status: "passed",
      metadata: { step_id: "echo", capability_id: "demo.echo" },
    })] }]} />);
    expect(screen.getByText("demo.echo")).toBeTruthy();
  });

  it("renders a verification failure with category and truncated mark", () => {
    render(<SessionTimeline {...props} turns={[{ ...baseTurn, blocks: [block({
      kind: "flow_failure", status: "failed",
      metadata: { step_id: "concat", category: "verification", truncated: true },
    })] }]} />);
    expect(screen.getByText(/verification/)).toBeTruthy();
    expect(screen.getByText(/已截断/)).toBeTruthy();
  });

  it("renders a run snapshot with step count and output_ref", () => {
    render(<SessionTimeline {...props} turns={[{ ...baseTurn, blocks: [block({
      kind: "flow_run", status: "succeeded",
      metadata: {
        flow_id: "flow_demo_echo",
        flow_revision: "sha256:abcdef0123456789",
        steps: [
          { step_id: "echo", capability_id: "demo.echo", output_ref: "artifact://a1", verification_status: "passed" },
          { step_id: "concat", capability_id: "demo.concat", output_ref: "artifact://a2", verification_status: "passed" },
        ],
      },
    })] }]} />);
    expect(screen.getByText(/2 \/ 2/)).toBeTruthy();
    expect(screen.getByText("artifact://a1")).toBeTruthy();
  });
});
```

Use `revisionTail` for the revision line (`23456789`, not `sha256:a`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/web/src/components/session-timeline.test.tsx`
Expected: FAIL — no `flow_*` branch.

- [ ] **Step 3: Implement `FlowBlock`**

In `TimelineBlock`, before the `ProcessBlock` fall-through:

```tsx
if (block.kind === "flow_param" || block.kind === "flow_step" || block.kind === "flow_run" || block.kind === "flow_failure") {
  return <FlowBlock block={block} />;
}
```

Implement `FlowBlock` as in the previous draft (step / param / failure / snapshot cards). Snapshot revision text: `revisionTail(String(meta.flow_revision ?? ""))`. Do not render attribution. Show `output_ref` as text only.

Update `blockLabel` so the union is exhaustive (`flow_step` → "流程步骤", `flow_param` → "参数", `flow_run` → "Run 快照", `flow_failure` → "验证失败").

Imports: `Workflow`, `X` from `lucide-react`; `revisionTail`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/web/src/components/session-timeline.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/session-timeline.tsx apps/web/src/components/session-timeline.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): render flow step, param, snapshot and failure blocks

EOF
)"
```

---

### Task 4: `FlowDetail` — controlled values, missing highlight, dry-run

**Files:**
- Create: `apps/web/src/components/flow-detail.tsx`
- Create: `apps/web/src/components/flow-detail.test.tsx`

Values are **controlled**. Parent owns the map. 409 must not remount away the filled map.

- [ ] **Step 1: Write failing tests**

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { FlowDetail } from "./flow-detail";
import type { FlowRecord } from "@/lib/types";

const echoFlow: FlowRecord = {
  flow_id: "flow_demo_echo", name: "Demo Echo", kind: "runbook", status: "published",
  source: "user_selected", definition_revision: "sha256:def", plan_ir_hash: "sha256:plan",
  review_status: "approved", validation_issues: [],
  inputs: [{ id: "text", type: "string", source: "user", required: true }],
  steps: [
    { id: "echo", capability: "demo.echo", purpose: null, depends_on: [], mode: "read_only", approval: "none", branches: [], retry: null, success_when: "output.text exists" },
    { id: "concat", capability: "demo.concat", purpose: null, depends_on: ["echo"], mode: "read_only", approval: "none", branches: [], retry: null, success_when: "output.result exists" },
  ],
};

describe("FlowDetail", () => {
  it("renders inputs and steps from the flow", () => {
    render(<FlowDetail flow={echoFlow} values={{}} missing={[]} onValues={() => {}} onSubmit={() => {}} onClose={() => {}} />);
    expect(screen.getByLabelText(/text/)).toBeTruthy();
    expect(screen.getByText("demo.echo")).toBeTruthy();
    expect(screen.getByText(/output\.text exists/)).toBeTruthy();
  });

  it("shows a parent-provided value", () => {
    render(<FlowDetail flow={echoFlow} values={{ text: "hi" }} missing={[]} onValues={() => {}} onSubmit={() => {}} onClose={() => {}} />);
    expect((screen.getByLabelText(/text/) as HTMLInputElement).value).toBe("hi");
  });

  it("submits with structured inputs and dryRun false", () => {
    const onSubmit = vi.fn();
    render(<FlowDetail flow={echoFlow} values={{ text: "hello" }} missing={[]} onValues={() => {}} onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /运行/ }));
    expect(onSubmit).toHaveBeenCalledWith({ text: "hello" }, false);
  });

  it("keeps filled values when missing is applied by the parent", () => {
    function Harness() {
      const [values, setValues] = useState<Record<string, unknown>>({ text: "kept" });
      const [missing, setMissing] = useState<Array<{ id: string; type: string; source: string; reason: string }>>([]);
      return <>
        <button type="button" onClick={() => setMissing([{ id: "text", type: "string", source: "user", reason: "required" }])}>fail</button>
        <FlowDetail flow={echoFlow} values={values} missing={missing} onValues={setValues} onSubmit={() => {}} onClose={() => {}} />
      </>;
    }
    render(<Harness />);
    fireEvent.click(screen.getByText("fail"));
    expect((screen.getByLabelText(/text/) as HTMLInputElement).value).toBe("kept");
    expect(screen.getByText(/缺少必填参数/)).toBeTruthy();
  });

  it("shows a dry-run button for candidate flows", () => {
    render(<FlowDetail flow={{ ...echoFlow, status: "candidate" }} values={{}} missing={[]} onValues={() => {}} onSubmit={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /dry-run|预演/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/web/src/components/flow-detail.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

No internal `useState` for values. Header shows `revisionTail(flow.definition_revision)` and `revisionTail(flow.plan_ir_hash)`.

```tsx
export function FlowDetail(props: {
  flow: FlowRecord;
  values: Record<string, unknown>;
  missing: Array<{ id: string; type: string; source: string; reason: string }>;
  onValues: (values: Record<string, unknown>) => void;
  onSubmit: (values: Record<string, unknown>, dryRun: boolean) => void;
  onClose: () => void;
}) {
  const missingIds = new Set(props.missing.map((entry) => entry.id));
  // ... header, steps list ...
  // input value={String(props.values[input.id] ?? "")}
  // onChange → props.onValues({ ...props.values, [input.id]: event.target.value })
  // 运行 → props.onSubmit(props.values, false)
  // candidate Dry-run 预演 → props.onSubmit(props.values, true)
}
```

Do not disable 「运行」 solely because a required key is missing — server 409 is the source of truth (empty string is a filled key). Prefill defaults in the **parent** when opening a flow, not inside FlowDetail.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/web/src/components/flow-detail.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/flow-detail.tsx apps/web/src/components/flow-detail.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): Flow detail panel with controlled parameter form

EOF
)"
```

---

### Task 5: Wire workbench + composer

**Files:**
- Create: `apps/web/src/lib/flow-run-submit.ts`
- Create: `apps/web/src/lib/flow-run-submit.test.ts`
- Modify: `apps/web/src/components/workbench.tsx`
- Modify: `apps/web/src/components/composer.tsx`
- Modify: `apps/web/src/components/session-chrome.tsx` (「已发布」+「候选」两组)
- Modify: `apps/web/src/components/session-chrome.test.tsx` (if present; else add coverage there)
- Modify: `apps/web/src/components/composer-controls.tsx` (Plus Flow 下拉只列 published)
- Modify: `apps/web/src/components/composer.test.tsx`

P0-2: FlowDetail submit is **not** `submit()` which bails on empty draft.
P0-3: never `setDetailFlow(await fetchFlow())` on 409.

- [ ] **Step 1: Write failing tests**

`apps/web/src/lib/flow-run-submit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { flowRunMessage, defaultsFromFlow } from "./flow-run-submit";
import type { FlowRecord } from "./types";

const flow: FlowRecord = {
  flow_id: "flow_demo_echo", name: "Demo Echo", kind: "runbook", status: "published",
  source: "user", definition_revision: "sha256:def", plan_ir_hash: "sha256:abcdef0123456789",
  review_status: "approved", validation_issues: [],
  inputs: [{ id: "text", type: "string", source: "user", required: true, default: "hi" }],
  steps: [],
};

describe("flowRunMessage", () => {
  it("uses a non-empty draft", () => {
    expect(flowRunMessage("  go  ", flow)).toBe("go");
  });
  it("synthesizes a message when the composer draft is empty", () => {
    expect(flowRunMessage("   ", flow)).toBe("运行 Demo Echo");
  });
});

describe("defaultsFromFlow", () => {
  it("copies defined defaults", () => {
    expect(defaultsFromFlow(flow)).toEqual({ text: "hi" });
  });
});
```

In `composer.test.tsx`, add a case with `flowId: "flow_demo_echo"` and a runbook whose `plan_ir_hash` is `sha256:abcdef0123456789`. Expect badge text to include `23456789` (`revisionTail`) and `runbook`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/web/src/lib/flow-run-submit.test.ts apps/web/src/components/composer.test.tsx`
Expected: FAIL — helper missing; no badge.

- [ ] **Step 3: Implement helper + composer badge**

`apps/web/src/lib/flow-run-submit.ts`:

```ts
import type { FlowRecord } from "./types";

export function flowRunMessage(draft: string, flow: FlowRecord): string {
  const text = draft.trim();
  return text || `运行 ${flow.name || flow.flow_id}`;
}

export function defaultsFromFlow(flow: FlowRecord): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const input of flow.inputs) {
    if (input.default !== undefined) values[input.id] = input.default;
  }
  return values;
}
```

Composer badge (submit area):

```tsx
{boundFlow && (
  <div className="flex items-center gap-2 rounded-md border border-line bg-surface-tint px-2.5 py-1.5 font-mono text-xs text-muted">
    <Workflow className="size-3.5" />
    <span>{boundFlow.name || boundFlow.flow_id}</span>
    <span className="text-faint">{boundFlow.kind}</span>
    {boundFlow.plan_ir_hash && (
      <span className="text-faint">{revisionTail(boundFlow.plan_ir_hash)}</span>
    )}
  </div>
)}
```

`boundFlow = flows.find((flow) => flow.flow_id === flowId)`.

- [ ] **Step 4: Wire workbench + sidebar groups**

In `session-chrome.tsx` Flows panel, split `flows` into two groups (do not mix):

```tsx
const published = flows.filter((flow) => flow.status === "published");
const candidates = flows.filter((flow) => flow.status === "candidate");
```

Render 「已发布」 then 「候选」. Each row still `onClick={() => onFlow(flow.flow_id)}`. Empty published copy stays 「暂无已发布 Flow」; candidate group omitted when `candidates.length === 0`. Header subtitle: published 数量，不要把 candidate 算进「已发布定义」。

In `composer-controls.tsx`, the existing Plus Flow `<Select>` lists `flows.filter((flow) => flow.status === "published")` only. Do not add a new composer picker.

In `workbench.tsx`, `openFlow` (used by sidebar `onFlow`):

```ts
async function openFlow(id: string) {
  setArea("agents");
  setMissingInputs([]);
  const flow = await api.fetchFlow(id);
  setDetailFlow(flow);
  setParamValues(defaultsFromFlow(flow));
  if (flow.status === "published") setFlowId(id);
  // candidate: do not setFlowId — bind is "this session's executable contract"
}
```

`runFlow` always sends `flowId: flow.flow_id` on the **message body** (so candidate dry-run works without session bind).

Render above the timeline when `detailFlow` is set:

```tsx
<FlowDetail
  flow={detailFlow}
  values={paramValues}
  missing={missingInputs}
  onValues={setParamValues}
  onClose={() => { setDetailFlow(null); setMissingInputs([]); }}
  onSubmit={(values, dryRun) => { void runFlow(detailFlow, values, dryRun); }}
/>
```

`runFlow` is a **new** function, not `submit()`:

```ts
async function runFlow(flow: FlowRecord, values: Record<string, unknown>, dryRun: boolean) {
  if (sending) return;
  setParamValues(values);
  setMissingInputs([]);
  setSending(true);
  setError(null);
  let sessionId = selectedSessionId;
  // same session-create guard as submit(), but do not require draft.trim()
  const message = flowRunMessage(draft, flow);
  const idempotencyKey = crypto.randomUUID();
  const result = await submitSessionMessage({
    send: api.sendMessage,
    lookup: api.submission,
    sessionId,
    idempotencyKey,
    input: {
      message,
      flowId: flow.flow_id,
      model: model || null,
      attachments,
      permissionMode: permissionMode || null,
      effort: effort || null,
      inputs: values,
      dryRun,
    },
  });
  if (result.kind === "rejected" && result.error.code === "missing_inputs" && Array.isArray(result.error.body?.missing)) {
    setMissingInputs(result.error.body.missing);
    setSending(false);
    return; // keep detailFlow + paramValues
  }
  if (result.kind === "rejected" || result.kind === "unknown") {
    setError(messageOf(result.kind === "rejected" ? result.error : result.idempotencyKey));
    setSending(false);
    return;
  }
  await sessionConnection.refresh(sessionId);
  setSending(false);
}
```

Composer `onSubmit` still calls existing `submit()` (unbound / typed chat). Bound **published** runbook **can** also send from composer; if so, include `inputs: flowId ? paramValues : undefined`. Empty composer + click composer send still no-ops; empty composer + FlowDetail 「运行」 must send.

Do **not** `setDetailFlow(null)` before/on 409. Closing the panel is only `onClose`. Do not `setFlowId` when opening a candidate.

Keep the state declarations next to other workbench state:

```ts
const [detailFlow, setDetailFlow] = useState<FlowRecord | null>(null);
const [paramValues, setParamValues] = useState<Record<string, unknown>>({});
const [missingInputs, setMissingInputs] = useState<Array<{
  id: string; type: string; source: string; reason: string;
}>>([]);
```

Sidebar `onFlow={openFlow}`. Composer `onFlow` stays `setFlowId` only (bind published from Plus 下拉).

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run apps/web/src/lib/flow-run-submit.test.ts apps/web/src/components/composer.test.tsx apps/web/src/components/workbench-component-policy.test.ts apps/web/src/components/session-chrome.test.tsx`
Expected: PASS. If policy test fails on a hex color or native `<select>`, fix tokens; native `<input>` in FlowDetail is allowed.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/flow-run-submit.ts apps/web/src/lib/flow-run-submit.test.ts \
  apps/web/src/components/workbench.tsx apps/web/src/components/composer.tsx \
  apps/web/src/components/composer-controls.tsx \
  apps/web/src/components/session-chrome.tsx apps/web/src/components/composer.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): submit runbooks from FlowDetail without a composer draft

EOF
)"
```

---

### Task 6: Playwright e2e (mock API, no real backend)

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/flow-loop.spec.ts`
- Modify: root `package.json` / `pnpm-lock.yaml` (`pnpm add -Dw @playwright/test`)

Vite `base` is `/workbench/`. `page.goto("/workbench/")`.

**SSE:** do **not** pass a `ReadableStream` to `route.fulfill`. Use `page.route` + **string body** of already-completed SSE (runbook wait=true: events exist before 202) **or** Playwright CDP. Preferred: POST handler records the body; `GET .../events?live=true` and `GET /v1/sessions/:id` both return the **same projected timeline** (no live STEP drip). That matches A.

- [ ] **Step 1: Config**

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://127.0.0.1:5173" },
  webServer: {
    command: "pnpm --filter @codebridge/web dev -- --port 5173 --strictPort",
    url: "http://127.0.0.1:5173/workbench/",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
```

- [ ] **Step 2: Spec**

`e2e/flow-loop.spec.ts` must mock **all** of:

| Request | Response |
| --- | --- |
| `GET /workbench/config.json` | `{ token: "test" }` |
| `GET /v1/agents` | one healthy agent (`codex`) |
| `GET /v1/sessions` (list) | one session `sess_1`, `flow_id: null` |
| `GET /v1/sessions/sess_1` | snapshot: runtime ready; timeline starts empty, **after a successful POST** includes user_message + flow_step×2 + flow_run |
| `GET /v1/sessions/sess_1/events*` | SSE **string**: `: keep-alive\n\n` only (timeline comes from hydrate) |
| `GET /v1/flows` | published `flow_demo_echo` + candidate `flow_demo_echo_cand` |
| `GET /v1/flows/flow_demo_echo` | full published record (`text` required, two demo steps) |
| `GET /v1/flows/flow_demo_echo_cand` | same steps, `status: "candidate"` |
| `POST /v1/sessions/sess_1/messages` | no `inputs.text` → 409 `missing_inputs`; else 202. If `dry_run: true`, 202 without requiring a snapshot card |
| `GET /v1/sessions/sess_1/options` and `.../commands` | `[]` |

Keep a mutable `lastMessage: Record<string, unknown>` and `timelineTurns` in the test closure. Successful POST sets `timelineTurns` to the projected blocks (capability ids `demo.echo` / `demo.concat`, snapshot `2 / 2`, `output_ref: artifact://a1`). Next `openSession`/`GET sess_1` returns that timeline — this is A.

Assertions:

1. `page.goto("/workbench/")` → open Flows area → click published echo → detail shows `text` and `demo.echo`.
2. Click 「运行」 with empty text → `缺少必填参数`. Fill `text=hi`, 「运行」 → timeline shows `demo.echo`, `demo.concat`, `Run 快照`, `2 / 2`, `artifact://a1`. Composer can stay empty.
3. Open Flows → 「候选」→ `flow_demo_echo_cand` → Dry-run visible, no 「运行」; click Dry-run → last POST `dry_run === true` and `flow_id === "flow_demo_echo_cand"`; session snapshot `flow_id` stays null.

- [ ] **Step 3: Run e2e**

Run: `pnpm exec playwright test e2e/flow-loop.spec.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add playwright.config.ts e2e/flow-loop.spec.ts package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
test(web): browser e2e for the flow loop with mocked API

EOF
)"
```

---

### Task 7: Full regression + spec landed

**Files:**
- Modify: `docs/superpowers/specs/2026-08-19-flow-web-loop-design.md`

- [ ] **Step 1: Run suites**

```bash
pnpm --filter @codebridge/work-items build
pnpm vitest run apps/web packages/flow-catalog packages/policy packages/run-executor packages/work-items \
  apps/bridge/src/flow-api.test.ts apps/bridge/src/flow-compile.test.ts \
  apps/bridge/src/session-runtime-api.test.ts apps/bridge/src/session-api.test.ts
pnpm exec playwright test e2e/flow-loop.spec.ts
```

Expected: PASS.

- [ ] **Step 2: Spec status**

Set spec `Status: Landed`. Add a one-line note under §0: projector kinds + Playwright path.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-19-flow-web-loop-design.md
git commit -m "$(cat <<'EOF'
docs: mark flow web loop spec as landed

EOF
)"
```

---

## Spec coverage

| Spec | Task |
| --- | --- |
| Projector `flow_*` (A, refresh-safe) | 1.5 |
| FlowRecord / fetchFlow / inputs / ApiError.body / revisionTail | 1 |
| Live applyFlowEvent merge (non-authority) | 2 |
| Render four cards + VF truncated + output_ref text | 3 |
| Controlled FlowDetail + dry-run | 4 |
| Independent submit, 409 no remount, sidebar 已发布+候选（候选不绑定）, badge hash | 5 |
| Playwright + candidate dry-run | 6 |
| Regression + docs | 7 |
| attribution / artifact fetch / BRANCH / RUN_STARTED cards | §5 — no task |

## Self-review

- Authority is projector hydrate, not `receive`+reducer.
- No new HTTP routes. `projectSessionEvent` is in scope.
- P0-2: `runFlow` + `flowRunMessage`; composer empty is allowed.
- P0-3: controlled `paramValues`; 409 only sets `missingInputs`.
- P1: merge upsert in projector and live reducer; Playwright mocks config/agents/sessions/openSession; SSE is a string, not `ReadableStream`; hash is `revisionTail`.
- P2 demoted in spec §5; candidate dry-run is T6 assertion 3; `FlowInput.source` is `string`.
- Candidate entry is sidebar 「候选」; opening it does not `setFlowId`. Composer Plus 下拉只列 published.
- `feat_flow` may already contain three `api.test.ts` cases — do not duplicate.
