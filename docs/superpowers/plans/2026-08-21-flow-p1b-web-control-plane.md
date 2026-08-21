# Flow P1B Web Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the active Web Flow control-plane path: successful solidifiable Runbook Run → traceable Candidate → exact-revision Dry-run evidence → semantic review → publish or reject → version/audit history and deprecation.

**Architecture:** Keep Flow domain rules in `@codebridge/flow-catalog` and the Bridge Flow API. A Candidate derived from a successful Published Runbook Run receives a new physical `flow_id`, a stable lineage root, a parent pointer, and immutable provenance; approving it publishes the new record and deprecates the previous Published parent. Web remains a client: it renders a structured editor and review context, calls shared APIs, and never computes revisions, publication eligibility, or lineage transitions itself.

**Tech Stack:** TypeScript, Node SQLite, Hono, React 19, Tailwind CSS 4, Vitest, existing lucide-react and CodeBridge UI primitives.

**Product source:** `docs/superpowers/specs/2026-08-20-flow-three-channel-v1-final-alignment.md`

---

## 0. Locked Decisions and Boundaries

- The V1 creation path starts from a successful **Published Runbook** Run. Arbitrary Agent plans and Guide Drafts are not promotable in P1B.
- `POST /v1/flows/candidates` remains the single Candidate write use case. `run_id` enables derivation; posting an existing Candidate `flow_id` performs a structured update.
- The server computes `definitionRevision` and `planIrHash`. Web never supplies or trusts its own revision.
- A derived Candidate gets a new physical `flow_id`, `lineageRootFlowId`, `parentFlowId`, and provenance containing source Run, Session, Flow, and definition revision.
- Approving a derived Candidate deprecates its currently Published parent in the same synchronous command path, so consumption never keeps two active versions in one lineage.
- A Candidate can be approved only after a successful Runtime Run exists for its exact `flow_id + definitionRevision + planIrHash`. Candidate formal execution is already forbidden, so such evidence is necessarily a Dry-run under the existing Runtime contract.
- `git_revision` remains review audit metadata. Runtime identity remains `definitionRevision + planIrHash`.
- Web structured editing covers name, description, typed inputs, ordered steps, Capability selection, mapped adapter/risk display, approval, retry, and `success_when`. It does not add a DAG canvas, arbitrary loops, Guide creation, or free-form import.
- Existing one-shot Run, bind/unbind, Runtime approval, Feishu, and Telegram contracts are unchanged.
- Existing user-owned `AGENTS.md` and untracked files are not part of this plan.

## 1. File Map

### Domain and Bridge

- Modify `packages/flow-catalog/src/index.ts`: persist description, lineage, provenance, publication sequence, and append-only Flow history; expose history/revision lookup.
- Modify `packages/flow-catalog/src/index.test.ts`: migration-safe defaults, lineage persistence, history ordering, exact revision lookup.
- Modify `apps/bridge/src/flow-api.ts`: derive/update Candidate, expose capability mappings and review context, enforce evidence, publish/reject/deprecate.
- Modify `apps/bridge/src/flow-api.test.ts`: API contract and adversarial coverage.

### Web

- Modify `apps/web/src/lib/types.ts`: Flow provenance, history, evidence, review context, capability records.
- Modify `apps/web/src/lib/api.ts`: Candidate, review context, capability, review, and deprecate methods.
- Modify `apps/web/src/lib/api.test.ts`: exact paths and payloads.
- Create `apps/web/src/components/flow-control-panel.tsx`: structured Candidate editor, semantic Diff, provenance, evidence, audit history, review and deprecate actions.
- Create `apps/web/src/components/flow-control-panel.test.tsx`: reachable actions, disabled/error states, exact editor payload.
- Modify `apps/web/src/components/flow-detail.tsx`: host the management panel without changing existing execution semantics.
- Modify `apps/web/src/components/flow-detail.test.tsx`: management panel mounting and Candidate-only Dry-run.
- Modify `apps/web/src/components/session-timeline.tsx`: expose “存为 Candidate” only on successful solidifiable Published Runbook snapshots.
- Modify `apps/web/src/components/session-timeline.test.tsx`: visible/hidden conditions and callback Run identity.
- Modify `apps/web/src/components/workbench.tsx`: load context, create Candidate from Run, save/review/deprecate, refresh evidence after Candidate Run completion.

### Documentation

- Update this plan’s checkboxes and Surface Matrix after verification.

## 2. Task 1 — Catalog lineage, provenance, and append-only history

- [x] **Step 1: Write failing Catalog tests**

Add tests proving:

```ts
const source = store.save({
  flowId: "flow-source",
  name: "Source",
  description: "Published baseline",
  kind: "runbook",
  status: "published",
  source: "git",
  definitionRevision: "sha256:source",
  publicationSequence: 1,
  steps: [],
});
const candidate = store.save({
  flowId: "flow-candidate",
  name: "Candidate",
  description: "Derived definition",
  kind: "runbook",
  status: "candidate",
  source: "user_selected",
  definitionRevision: "sha256:candidate",
  lineageRootFlowId: source.flowId,
  parentFlowId: source.flowId,
  provenance: {
    sourceRunId: "run-1",
    sourceSessionId: "sess-1",
    sourceFlowId: source.flowId,
    sourceDefinitionRevision: source.definitionRevision,
  },
  steps: [],
});
expect(store.get(candidate.flowId)).toMatchObject({
  description: "Derived definition",
  lineageRootFlowId: "flow-source",
  parentFlowId: "flow-source",
  publicationSequence: 0,
});
expect(store.history(candidate.flowId)).toHaveLength(1);
expect(store.getRevision(candidate.flowId, candidate.definitionRevision)?.flowId)
  .toBe(candidate.flowId);
```

Also prove an identical re-save does not add a duplicate history entry, while a review/status transition does.

- [x] **Step 2: Run the Catalog test and confirm RED**

Run:

```bash
pnpm --filter @codebridge/flow-catalog test -- --run packages/flow-catalog/src/index.test.ts
```

Expected: type/method assertions fail because lineage/history fields and methods do not exist.

- [x] **Step 3: Add backward-compatible schema and types**

Add:

```ts
export interface FlowProvenance {
  sourceRunId: string;
  sourceSessionId: string;
  sourceFlowId: string;
  sourceDefinitionRevision: string;
}

export type FlowHistoryAction =
  | "created"
  | "definition_updated"
  | "review_approved"
  | "review_rejected"
  | "deprecated";

export interface FlowHistoryEntry {
  id: number;
  flowId: string;
  definitionRevision: string;
  action: FlowHistoryAction;
  snapshot: FlowRecord;
  createdAt: string;
}
```

Extend `FlowRecord` with `description`, `lineageRootFlowId`, `parentFlowId`, `provenance`, and `publicationSequence`. Add nullable/defaulted columns to `flows`, create `flow_history`, and decode legacy rows with `lineageRootFlowId = flowId`, `publicationSequence = status === "published" ? 1 : 0`, and null provenance/parent/description.

- [x] **Step 4: Append only meaningful snapshots and expose lookup**

Implement:

```ts
history(flowId: string): FlowHistoryEntry[]
getRevision(flowId: string, definitionRevision: string): FlowRecord | undefined
listLineage(lineageRootFlowId: string): FlowRecord[]
```

`save` appends a snapshot only when a business field changed. The inferred history action is based on transition: create, approve, reject, deprecate, otherwise definition update.

- [x] **Step 5: Run Catalog tests and confirm GREEN**

Run the Task 1 command and expect all Flow Catalog tests to pass.

## 3. Task 2 — Run-derived Candidate and review context API

- [x] **Step 1: Write failing Bridge tests**

Create fixtures with a Session, WorkItem, persisted workflow Plan, and succeeded Run. Assert:

```ts
POST /v1/flows/candidates
{ "session_id": "sess-1", "run_id": "run-1" }
```

returns `201`, creates a new Candidate, clones source inputs/steps/description, and records exact provenance. Add negative cases for missing event store, cross-Session Run, non-succeeded Run, Agent-generated Plan, missing source Flow, non-Published source, and plan revision/hash drift.

Add tests for:

```text
GET /v1/capabilities
GET /v1/flows/:flow_id/review-context
```

Review context must contain `flow`, `base`, `diff`, `provenance`, `evidence`, and `history`.

- [x] **Step 2: Run focused Bridge tests and confirm RED**

Run:

```bash
pnpm --filter @codebridge/bridge test -- --run apps/bridge/src/flow-api.test.ts
```

Expected: new routes/fields and `run_id` derivation fail.

- [x] **Step 3: Refactor Candidate compilation into one server-owned helper**

Create a local helper in `flow-api.ts` that receives canonical name/description/inputs/steps, compiles the Workflow, calculates both hashes, converts compiled steps, and saves a Candidate while preserving existing lineage/provenance on structured edits.

Do not duplicate candidate hash/compile logic between run-derived and manually supplied payloads.

- [x] **Step 4: Implement solidifiable Run validation**

The derivation path must validate, in order:

```text
Session exists
→ Run exists and run.sessionId === Session.id
→ Run.status === succeeded
→ persisted Plan exists and source === workflow
→ source Catalog record exists and is Published Runbook
→ Plan definitionRevision and planIrHash match source
→ clone source into new Candidate with provenance
```

Return stable error codes such as `run_not_found`, `run_not_succeeded`, and `run_not_solidifiable` without writing the Catalog.

- [x] **Step 5: Expose capabilities and semantic review context**

`GET /v1/capabilities` returns registered capability `id`, `adapter`, `risk`, `description`, and `side_effects`. Review context compares the Candidate against the exact parent revision from provenance/history, with current-row fallback when the revision still matches.

Semantic Diff is structured:

```ts
type FlowSemanticDiff = {
  nameChanged: boolean;
  descriptionChanged: boolean;
  inputs: { added: string[]; removed: string[]; changed: string[] };
  steps: { added: string[]; removed: string[]; changed: string[]; reordered: boolean };
};
```

- [x] **Step 6: Run focused tests and confirm GREEN**

Run the Task 2 command and expect all Flow API tests to pass.

## 4. Task 3 — Exact-revision evidence, review, publish, reject, and deprecate

- [x] **Step 1: Write failing review/evidence tests**

Assert a Candidate approval without a succeeded exact-revision Run returns:

```json
{
  "error": "flow_not_publishable",
  "issues": ["successful dry-run evidence required"]
}
```

Create a succeeded Candidate Run with a matching persisted Plan and assert approval succeeds, increments publication sequence, and deprecates the Published parent. A Run with different revision/hash must not count.

Assert reject keeps Candidate status, sets `review_status = rejected`, and does not deprecate the parent. Assert structured Candidate edit resets review status to pending and clears stale git revision. Assert `POST /v1/flows/:id/deprecate` accepts only Published Runbooks.

- [x] **Step 2: Run focused tests and confirm RED**

Use the Task 2 Bridge test command.

- [x] **Step 3: Implement evidence lookup as a read model**

Use existing `SqliteEventStore.listWorkItems()`, `listRuns(workItemId)`, and `getPlanForRun(runId)`. Evidence matches only when:

```text
run.status === succeeded
plan.source === workflow
plan.workflowId === candidate.flowId
plan.definitionRevision === candidate.definitionRevision
plan.planIrHash === candidate.planIrHash
```

Return Run/Session IDs, status, revision/hash, and timestamps. Do not alter Runtime or duplicate frozen-plan logic.

- [x] **Step 4: Enforce review and lineage transition in the Bridge**

Approval checks static publish issues plus exact evidence. It then assigns the next lineage publication sequence, publishes the Candidate, and deprecates a currently Published parent. Rejection is non-destructive. Deprecation is explicit and auditable.

- [x] **Step 5: Run Bridge and Catalog tests and confirm GREEN**

Run:

```bash
pnpm --filter @codebridge/flow-catalog test
pnpm --filter @codebridge/bridge test -- --run apps/bridge/src/flow-api.test.ts apps/bridge/src/session-runtime-api.test.ts
```

## 5. Task 4 — Web contracts and active control panel

- [x] **Step 1: Write failing Web API tests**

Lock the exact calls:

```ts
api.createCandidate(sessionId, runId)
api.saveCandidate(sessionId, flow)
api.flowReviewContext(flowId)
api.flowCapabilities()
api.reviewFlow(flowId, "approve", gitRevision)
api.reviewFlow(flowId, "reject")
api.deprecateFlow(flowId)
```

Verify snake_case JSON and encoded URL paths.

- [x] **Step 2: Add Web types and API methods, then confirm API tests GREEN**

Extend `FlowRecord` with the new server fields and define `FlowReviewContext`, `FlowEvidence`, `FlowHistoryEntry`, `FlowSemanticDiff`, and `FlowCapability`.

- [x] **Step 3: Write failing `FlowControlPanel` tests**

Test:

- Candidate editor emits a complete structured definition.
- Capability selection displays server-owned adapter/risk mapping.
- Approve is disabled without evidence or git revision.
- Reject remains available.
- Provenance, Diff, evidence, and history are visible.
- Published Flow offers deprecate; Deprecated is read-only.
- Busy/error states prevent duplicate writes and leave recovery actions available.

- [x] **Step 4: Implement `FlowControlPanel`**

Use the existing neutral Workbench system: one bordered management surface, a responsive `md:grid-cols-[minmax(0,1fr)_280px]` definition/evidence split, labels above controls, monospace for revisions, and existing `Button` primitives. No new dependency, modal framework, motion engine, card grid, or visual theme.

Candidate editing uses ordered rows with explicit up/down controls rather than a DAG canvas. All destructive/review actions require an explicit button click; deprecation uses a browser confirmation.

- [x] **Step 5: Mount the panel through `FlowDetail` and confirm component tests GREEN**

`FlowDetail` remains the execution owner. It renders the management panel only when management props/context are present, so existing consumption-only behavior and tests remain valid.

## 6. Task 5 — Timeline and Workbench closure

- [x] **Step 1: Write failing Timeline tests**

A succeeded `flow_run` whose `flow_id` is in `solidifiableFlowIds` renders “存为 Candidate”; clicking passes the exact `run_id`. Failed runs, Candidate runs, Agent runs, and unknown flows do not render the action.

- [x] **Step 2: Implement Timeline action and confirm GREEN**

Thread `runId`, eligible Flow IDs, busy Run ID, and callback through `SessionTimeline → TimelineBlock → FlowBlock` without changing event projection.

- [x] **Step 3: Wire Workbench use cases**

Workbench must:

- pass currently Published Runbook IDs to Timeline;
- call `createCandidate(selectedSessionId, runId)` and open the returned Candidate;
- fetch capabilities once with Flow lists;
- fetch review context whenever a manageable Flow is opened;
- save structured Candidate edits and replace stale local revisions with the server response;
- keep existing Candidate Dry-run behavior;
- refresh review context after an exact Candidate `RUN_SNAPSHOT` reaches terminal state;
- approve/reject/deprecate, refresh manage/consume lists, and show precise notices/errors;
- never write Session binding during any management action.

- [x] **Step 4: Run focused Web tests**

Run:

```bash
pnpm --filter @codebridge/web test -- --run \
  apps/web/src/lib/api.test.ts \
  apps/web/src/components/flow-control-panel.test.tsx \
  apps/web/src/components/flow-detail.test.tsx \
  apps/web/src/components/session-timeline.test.tsx
```

Expected: all focused tests pass.

## 7. Task 6 — Adversarial and full verification

- [x] **Step 1: Run adversarial Flow matrix**

Verify:

- a cross-Session or failed Run cannot create a Candidate;
- arbitrary Agent plans cannot be promoted;
- Candidate edits cannot overwrite Published/Deprecated records;
- candidate live run/bind remains forbidden;
- approval without exact successful evidence fails;
- stale evidence cannot approve a new revision;
- reject does not publish or deprecate;
- approval leaves one Published record in the lineage;
- Deprecated cannot run, bind, dry-run, review, or deprecate again;
- all writes remain idempotent at the UI busy-state boundary and server conflict boundary.

- [x] **Step 2: Run full verification**

Run fresh:

```bash
pnpm test
pnpm lint
pnpm build
```

Expected: zero test failures, zero lint errors, and successful build. Existing lint warnings must be reported separately and not described as errors.

- [x] **Step 3: Re-run the End-to-End Surface Matrix**

| Surface | Entry | Read path | Write path | Event consumption | Error/recovery | Terminal feedback | State | Planned landing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Web control plane | Manage Flow directory + succeeded Run snapshot | manage list, detail, context, capabilities, history/evidence | Candidate save, review, deprecate | Session SSE + review-context refresh | inline API error, retry, reject, re-edit | Candidate revision, evidence, published/deprecated state | must be closed-loop | P1B |
| Web consumption | Published directory/detail | consume list | one-shot messages, apply/unbind | Session SSE/timeline | existing revision mismatch and unbind | existing result/approval blocks | unchanged closed-loop | P0A/P0B |
| Agent | ordinary conversation only | no Flow management | no Catalog/review write | Agent events | no silent Flow fallback | Agent response | intentionally out of management scope | P2 recommendation only |
| Feishu | `/flow` controller | consume list/detail | explicit one-shot Flow invocation, Runtime approval | watcher | shared controller errors/cancel | structured result cards | unchanged closed-loop | P1A |
| Telegram | `/flow` controller | consume list/detail | explicit one-shot Flow invocation, Runtime approval | watcher | shared controller errors/cancel | structured result messages | code closed-loop; runtime disabled until configured | P1A |

No surface may claim Flow Definition Review unless it reaches the active Web control panel and terminal publication/rejection state.

- [x] **Step 4: Detect GitNexus changes before commit**

Stage only P1B files, then run:

```bash
npx gitnexus detect-changes --repo CodeBridge --scope staged
```

Review affected symbols/flows. Warn before proceeding if GitNexus reports HIGH or CRITICAL risk.

- [x] **Step 5: Commit and restart**

Commit only the verified P1B files:

```bash
git commit -m "feat(flow): close Web P1B control plane"
```

Restart Bridge/Runner with the repository’s existing process script, confirm ports `19790/19789`, Web HTTP 200, and configured channel connectivity.

## 8. Plan Self-Review

- Spec coverage: maps every P1 Web requirement to Tasks 1–6; Guide creation and automated conversational saving remain P2 by Accepted spec.
- Placeholder scan: no TBD/TODO or unspecified implementation action remains.
- Type consistency: `definitionRevision`, `planIrHash`, lineage/provenance, review context, and API snake_case names remain server-owned and consistent across tasks.
- Risk containment: no Runtime execution or channel-domain logic changes; evidence reads existing frozen Plan/Run records.
- Product boundary: no DAG editor, Flow ACL, semver, Agent Catalog writes, or per-channel management state machine.
