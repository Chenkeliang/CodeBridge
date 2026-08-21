# Flow P0A Adversarial Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that malformed, stale, or forged Flow invocations cannot execute the wrong Flow, fall back to Agent, mutate Session binding, or create untraceable Candidates.

**Architecture:** Keep Flow eligibility in the existing catalog policy and invocation resolver. Add deterministic table-driven tests at the pure resolver boundary, then endpoint tests at the Bridge trust boundaries. For every discovered defect, preserve the failing request as a regression test and make the smallest contract-preserving fix.

**Tech Stack:** TypeScript, Hono, Vitest, SQLite, GitNexus.

**Status:** Completed on 2026-08-21. Red/green regressions fixed incomplete bindings, Candidate provenance/collision writes, and repeated-Flow Plan identity reuse. Final build, 1025 tests, lint, static scans, and GitNexus detection passed.

---

### Task 1: Attack invocation resolution and stale binding states

**Files:**
- Modify: `apps/bridge/src/flow-invocation.test.ts`
- Modify only if a red test proves a defect: `apps/bridge/src/flow-invocation.ts`

- [ ] Add a table covering unknown Flow IDs, incomplete historical bindings, explicit null with a stale revision, Guide dry-run/live, Candidate live, and revision mismatch.
- [ ] Assert every rejected invocation returns a typed 4xx result and never returns `none`; `none` is reserved for genuine non-Flow messages.
- [ ] Run `pnpm vitest run apps/bridge/src/flow-invocation.test.ts` and record the red cases.
- [ ] Before editing `resolveFlowInvocation`, run `npx gitnexus impact resolveFlowInvocation --direction upstream --repo CodeBridge`; warn before proceeding if risk is HIGH or CRITICAL.
- [ ] Implement only the validation required by the red cases and rerun the focused test.

### Task 2: Attack Runtime side effects and binding isolation

**Files:**
- Modify: `apps/bridge/src/session-runtime-api.test.ts`
- Modify: `apps/bridge/src/session-api.test.ts`
- Modify only if red tests prove defects: `apps/bridge/src/session-runtime-api.ts`
- Modify only if red tests prove defects: `apps/bridge/src/session-api.ts`

- [ ] Add endpoint tests proving `flow_id: null` clears both `flowId` and `flowDefinitionRevision` on successful Web messages.
- [ ] Add endpoint tests proving Guide, Candidate live, missing Flow, plan drift, missing input, and revision mismatch do not create a Run/Turn and do not alter the existing binding.
- [ ] Add a migrated dirty-binding case (`flowId` present, revision absent): Web must return a typed 409 instead of silently dispatching Agent; Channel absent must still ignore historical binding and dispatch ordinary Agent.
- [ ] Add an idempotency replay case proving one-shot Flow A never replaces bound Flow B.
- [ ] Run the two focused suites, capture every red case, and perform GitNexus upstream impact before editing either route function.
- [ ] Make the minimum shared-resolver/route fix and rerun the focused suites.

### Task 3: Attack Flow write APIs and provenance

**Files:**
- Modify: `apps/bridge/src/flow-api.test.ts`
- Modify only if red tests prove defects: `apps/bridge/src/flow-api.ts`

- [ ] Prove unauthorized, invalid view, Candidate/Guide apply, malformed review, and nonexistent Session requests leave Catalog and Session state unchanged.
- [ ] Add a Candidate request with a nonexistent `session_id`; it must return `404 session_not_found` before `catalog.save`, so an untraceable Candidate cannot be created.
- [ ] Reject Candidate writes that reuse a Guide, Draft, Published, or Deprecated `flow_id`; permit an existing Candidate to be updated idempotently. This protects the current Published record without defining the P1 lineage model.
- [ ] Run `pnpm vitest run apps/bridge/src/flow-api.test.ts`, then run GitNexus upstream impact on `createFlowApp` before any implementation edit.
- [ ] Move Session validation and flow-ID collision validation before Candidate compilation/save, then rerun the focused suite.

### Task 4: Attack Channel trust-boundary contracts

**Files:**
- Modify: `apps/bridge/src/channel-ingress.test.ts`
- Modify: `apps/bridge/src/session-api.test.ts`
- Modify only if red tests prove defects: `apps/bridge/src/channel-ingress.ts`
- Modify only if red tests prove defects: `apps/bridge/src/session-api.ts`

- [ ] Test missing ID/revision pairs, blank values, mismatched actor channel, unknown channel name, absent fields with a historical binding, and direct Web attempts to spoof channel actor metadata.
- [ ] Assert Channel adapters always request `view=consume`, always send ID/revision as a pair, and never gain Session binding through message submission.
- [ ] Assert trusted Channel origin is established by the internal origin token, not by request body actor data.
- [ ] Run the focused Channel/Session suites; use GitNexus impact before any production edit and apply only red-test fixes.

### Task 5: Final verification and handoff

**Files:**
- No planned production files beyond defects proven above.

- [ ] Run all focused adversarial suites.
- [ ] Run `pnpm build`, `pnpm test`, and `pnpm lint`.
- [ ] Run the Flow policy, binding-write, and ID/revision static scans from the accepted P0A plan.
- [ ] Run `npx gitnexus detect-changes --repo CodeBridge --scope unstaged` and `git diff --check`.
- [ ] Report fixed defects, deferred product decisions, residual risks, and whether P0A is ready for the next item. Do not commit unless the user asks.
