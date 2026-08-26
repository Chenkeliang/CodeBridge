# Flow Navigation Context Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Flows a real Web workspace that opens the newest Candidate belonging to the active Session without losing the Session context or leaking a previously selected Flow.

**Architecture:** Add one pure selector for provenance-aware Candidate selection, then make `Workbench` route its main surface by `area` before considering `selectedSession`. The global Flows entry performs contextual automatic selection; explicit Candidate actions continue to use the requested `flow_id` and switch areas only after review-context succeeds.

**Tech Stack:** React 19, TypeScript, Vitest/jsdom, Playwright, GitNexus.

---

## 0. Locked decisions

- Entering Flows always re-evaluates the active Session and may replace a previously explicit Flow selection. Within the Flow workspace, explicit list clicks remain authoritative until the user leaves and re-enters Flows.
- `provenance === null` and non-Candidate definitions never participate in automatic selection; they remain visible and explicitly openable.
- The global Flows entry immediately switches `area` and shows a neutral loading/empty surface while context loads. Session-card “打开并预演” stays in the Session until its requested review-context succeeds.
- Candidate identity comes only from `flow_id`; no title matching or inference is allowed.
- No Catalog, event, Agent, Feishu, or Telegram production file changes are permitted.

## 1. File map

- Create `apps/web/src/lib/flow-navigation.ts`: pure, deterministic Session-to-Candidate selection.
- Create `apps/web/src/lib/flow-navigation.test.ts`: provenance-null, status, ordering, and tie-break contracts.
- Modify `apps/web/src/components/workbench.tsx`: area entry, `openFlow` success transition, and area-first main routing.
- Modify `e2e/flow-save-inbox.spec.ts`: active Web regression with two Sessions and unrelated/related Candidates.

### Task 1: Add deterministic contextual Candidate selection

**Files:**
- Create: `apps/web/src/lib/flow-navigation.ts`
- Create: `apps/web/src/lib/flow-navigation.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Create tests with a minimal `FlowRecord` factory and these assertions:

```ts
import { describe, expect, it } from "vitest";
import type { FlowRecord } from "./types";
import { latestCandidateForSession } from "./flow-navigation";

function flow(
  flowId: string,
  status: FlowRecord["status"],
  sessionId: string | null,
  updatedAt: string,
): FlowRecord {
  return {
    flow_id: flowId,
    name: flowId,
    description: null,
    kind: "runbook",
    status,
    source: "agent_generated",
    definition_revision: `revision_${flowId}`,
    plan_ir_hash: null,
    inputs: [],
    steps: [],
    review_status: "pending",
    git_revision: null,
    validation_issues: [],
    lineage_root_flow_id: flowId,
    parent_flow_id: null,
    provenance: sessionId ? {
      source_run_id: `run_${flowId}`,
      source_session_id: sessionId,
      source_flow_id: `source_${flowId}`,
      source_definition_revision: `source_revision_${flowId}`,
    } : null,
    publication_sequence: 0,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

describe("latestCandidateForSession", () => {
  it("selects only Candidates whose provenance belongs to the Session", () => {
    const result = latestCandidateForSession([
      flow("foreign", "candidate", "sess_b", "2026-08-26T05:00:00.000Z"),
      flow("related", "candidate", "sess_a", "2026-08-26T04:00:00.000Z"),
      flow("published", "published", "sess_a", "2026-08-26T06:00:00.000Z"),
      flow("manual", "candidate", null, "2026-08-26T07:00:00.000Z"),
    ], "sess_a");
    expect(result?.flow_id).toBe("related");
  });

  it("uses updated_at descending and flow_id ascending as a stable tie-break", () => {
    expect(latestCandidateForSession([
      flow("flow_b", "candidate", "sess_a", "2026-08-26T04:00:00.000Z"),
      flow("flow_a", "candidate", "sess_a", "2026-08-26T04:00:00.000Z"),
      flow("older", "candidate", "sess_a", "2026-08-26T03:00:00.000Z"),
    ], "sess_a")?.flow_id).toBe("flow_a");
  });

  it("returns null without a Session or a related Candidate", () => {
    expect(latestCandidateForSession([], null)).toBeNull();
    expect(latestCandidateForSession([
      flow("foreign", "candidate", "sess_b", "2026-08-26T04:00:00.000Z"),
    ], "sess_a")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and preserve RED evidence**

Run:

```bash
pnpm vitest run apps/web/src/lib/flow-navigation.test.ts
```

Expected: FAIL because `./flow-navigation` does not exist.

- [ ] **Step 3: Implement the minimal selector**

Create:

```ts
import type { FlowRecord } from "./types";

export function latestCandidateForSession(
  flows: readonly FlowRecord[],
  sessionId: string | null,
): FlowRecord | null {
  if (!sessionId) return null;
  return flows
    .filter((flow) =>
      flow.status === "candidate"
      && flow.provenance?.source_session_id === sessionId
    )
    .sort((left, right) => {
      const byUpdatedAt = right.updated_at.localeCompare(left.updated_at);
      return byUpdatedAt || left.flow_id.localeCompare(right.flow_id);
    })[0] ?? null;
}
```

- [ ] **Step 4: Run GREEN and build the Web type graph**

Run:

```bash
pnpm vitest run apps/web/src/lib/flow-navigation.test.ts
pnpm --filter @codebridge/web build
```

Expected: all selector tests PASS; Web build exits 0.

- [ ] **Step 5: Run staged GitNexus detection and commit Task 1**

Stage only the two Task 1 files, then run:

```bash
npx gitnexus detect-changes -r '/Users/keliang/projects/CodeBridge-wt-flow-navigation' --scope staged
git diff --cached --check
git commit -m "fix(web): select the Session Flow Candidate deterministically"
```

Expected: no existing execution process changes; only the new selector and its test.

### Task 2: Route the Flow workspace independently from the Session

**Files:**
- Modify: `apps/web/src/components/workbench.tsx:1-25, 678-711, 849-867, 1870-2055`
- Modify: `e2e/flow-save-inbox.spec.ts:1-285, 360-430`

- [ ] **Step 1: Run mandatory upstream impact before editing `Workbench`**

Run:

```bash
npx gitnexus impact -r '/Users/keliang/projects/CodeBridge-wt-flow-navigation' Workbench --direction upstream
```

Record direct callers, affected processes, and risk. If the result is HIGH or CRITICAL, stop and report before editing. LOW/MEDIUM may continue.

- [ ] **Step 2: Extend the E2E fixture and write failing navigation tests**

In `e2e/flow-save-inbox.spec.ts`:

1. Add a second Candidate whose provenance points to `sess_b` and whose `updated_at` is newer than the related Candidate:

```ts
const foreignCandidate = {
  ...candidate,
  flow_id: "flow_channel_package",
  name: "channel-package-build-compare",
  definition_revision: "sha256:foreign",
  lineage_root_flow_id: "flow_channel_package",
  provenance: {
    ...candidate.provenance,
    source_run_id: "run_source_b",
    source_session_id: "sess_b",
    source_flow_id: "flow_ephemeral_b",
    source_definition_revision: "sha256:source_b",
    source_request_id: "fsr_b",
  },
  updated_at: "2026-08-26T05:00:00.000Z",
};
```

2. Extend the fixture input and state exactly as follows:

```ts
async function installFixture(page: Page, options: {
  pending?: PendingRequest[];
  initialFlows?: Array<typeof candidate>;
  confirmUnknownOnce?: boolean;
  confirmUnavailableOnce?: boolean;
  dismissUnknownOnce?: boolean;
  delaySecondInbox?: boolean;
  delayConfirmFailure?: boolean;
  delayConfirmSuccess?: boolean;
} = {}) {
  const sessionA = session("sess_a", "pi", "Pi Session A");
  const sessionB = session("sess_b", "codex", "Codex Session B");
  const state = {
    pending: [...(options.pending ?? [pendingRequest("fsr_a", "sess_a", "pi", sessionA.title)])],
    flows: [...(options.initialFlows ?? [])],
    terminals: new Map<string, "completed" | "dismissed">(),
  };
```

Keep the existing remainder of `installFixture` unchanged.

3. Replace the single-flow review-context route with an exact-ID route:

```ts
await page.route(/\/v1\/flows\/([^/]+)\/review-context$/, (route) => {
  const flowId = new URL(route.request().url()).pathname.split("/").at(-2)!;
  const flow = state.flows.find((entry) => entry.flow_id === flowId);
  if (!flow) {
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "flow_not_found" }),
    });
  }
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      flow,
      base: null,
      provenance: flow.provenance,
      evidence: [],
      history: [],
      diff: {
        name_changed: false,
        description_changed: false,
        inputs: { added: [], removed: [], changed: [] },
        steps: { added: [], removed: [], changed: [], reordered: false },
      },
    }),
  });
});
```

4. Add tests:

```ts
test("Flows opens the newest Candidate for the active Session and restores that Session", async ({ page }) => {
  await installFixture(page, { initialFlows: [foreignCandidate, candidate] });
  await page.goto("/workbench/");
  await page.getByRole("button", { name: "Pi" }).click();
  await expect(page.getByRole("region", { name: "Session conversation" })).toBeVisible();

  await page.getByRole("button", { name: /^Flows/ }).click();
  await expect(page.getByRole("region", { name: "Flow 管理" })).toBeVisible();
  await expect(page.getByRole("heading", { name: candidate.name })).toBeVisible();
  await expect(page.getByRole("region", { name: "Session conversation" })).toHaveCount(0);
  await expect(page.getByText(foreignCandidate.name, { exact: true }).first()).not.toHaveClass(/border-line/);

  await page.getByRole("button", { name: "Pi" }).click();
  await expect(page.getByRole("region", { name: "Session conversation" })).toBeVisible();
  await expect(page.getByText("Pi Session A", { exact: true }).first()).toBeVisible();
});

test("re-entering Flows clears a stale unrelated selection when the Session has no Candidate", async ({ page }) => {
  await installFixture(page, { initialFlows: [foreignCandidate] });
  await page.goto("/workbench/");
  await page.getByRole("button", { name: /^Flows/ }).click();
  await expect(page.getByRole("heading", { name: foreignCandidate.name })).toBeVisible();

  await page.getByRole("button", { name: "Pi" }).click();
  await page.getByRole("button", { name: /^Flows/ }).click();
  await expect(page.getByRole("region", { name: "Flow 选择" })).toContainText("从左侧选择 Flow 或待生成请求");
  await expect(page.getByRole("region", { name: "Session conversation" })).toHaveCount(0);
});
```

Also tighten the existing completed-card/confirm tests so successful Candidate opening asserts `area=flows` through visible `Flow 管理`, while a delayed/failed `openFlow` remains in `Session conversation` until success.

- [ ] **Step 3: Run the E2E tests and preserve RED evidence**

Run:

```bash
pnpm playwright test e2e/flow-save-inbox.spec.ts e2e/flow-save-intent.spec.ts --grep "Flows|Candidate detail|review failure|Turn action persists"
```

Expected failures before implementation:

- main still contains `Session conversation` after Flows is pressed;
- unrelated `detailFlow` remains selected;
- `Flow 管理` is absent while a Session remains selected.

- [ ] **Step 4: Add the contextual area entry**

Import `latestCandidateForSession` and replace the rail's raw `setArea` callback with:

```ts
function enterArea(nextArea: PanelArea): void {
  if (nextArea !== "flows") {
    setArea(nextArea);
    return;
  }
  const expectedSessionId = selectedSessionRef.current;
  setArea("flows");
  selectPendingFlowSaveRequest(null);
  setDetailFlow(null);
  setFlowReviewContext(null);
  setFlowControlError(null);
  setMissingInputs([]);
  const related = latestCandidateForSession(flows, expectedSessionId);
  if (related) void openFlow(related.flow_id, expectedSessionId);
}
```

Pass `onArea={enterArea}` to `AgentRail`.

- [ ] **Step 5: Make explicit Flow opening switch only after success**

At the end of the successful branch of `openFlow`, after the expected-Session checks and state writes, add:

```ts
setArea("flows");
```

Do not set the area before `api.flowReviewContext(id)` resolves. This preserves the existing no-cross-Session and failed-open behavior for “打开并预演”.

- [ ] **Step 6: Route the main surface by area**

Make `SessionHeader` render only for `area === "agents"`.

Replace the current Flow-detail conditions with one area-first branch:

```tsx
) : area === "flows" ? (
  selectedPendingFlowSaveRequest && selectedPendingFlowSaveAgentName ? (
    <section aria-label="Flow 待生成详情" className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-7">
      <FlowSaveInboxDetail
        actionState={flowSaveActionStates[selectedPendingFlowSaveRequest.request_id] ?? null}
        agentName={selectedPendingFlowSaveAgentName}
        onConfirm={(requestId) => { void confirmFlowSaveRequest(selectedPendingFlowSaveRequest.session_id, requestId); }}
        onDismiss={(requestId) => { void dismissFlowSaveRequest(selectedPendingFlowSaveRequest.session_id, requestId); }}
        onOpenSourceSession={() => { void locateFlowSaveSource(selectedPendingFlowSaveRequest); }}
        request={selectedPendingFlowSaveRequest}
      />
    </section>
  ) : detailFlow ? (
    <section aria-label="Flow 管理" className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
      <div className="mx-auto w-full max-w-[880px]">{flowDetailSurface}</div>
    </section>
  ) : (
    <section aria-label="Flow 选择" className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
      <p className="text-xs text-muted">从左侧选择 Flow 或待生成请求</p>
    </section>
  )
) : !selectedSession ? (
```

Remove the in-conversation `{flowDetailSurface}` insertion so a Flow detail has one active renderer only.

- [ ] **Step 7: Run GREEN, Web regression, and build**

Run:

```bash
pnpm vitest run \
  apps/web/src/lib/flow-navigation.test.ts \
  apps/web/src/components/session-chrome.test.tsx \
  apps/web/src/components/workbench-component-policy.test.ts
pnpm playwright test e2e/flow-save-inbox.spec.ts e2e/flow-save-intent.spec.ts
pnpm --filter @codebridge/web build
git diff --check
```

Expected: all commands exit 0; existing inbox, confirm/dismiss, delayed response, overflow, and Session restoration cases remain green.

- [ ] **Step 8: Detect changed flows and commit Task 2**

Stage only `workbench.tsx` and the two E2E/test files changed by this task, then run:

```bash
npx gitnexus detect-changes -r '/Users/keliang/projects/CodeBridge-wt-flow-navigation' --scope staged
git diff --cached --check
git commit -m "fix(web): open contextual Candidates from the Flow workspace"
```

Expected impact: Web `Workbench` routing/openFlow processes only. Any Backend, Agent, Feishu, Telegram, Catalog, or event process is out of scope and must stop the task.

### Task 3: Active-surface adversarial verification

**Files:**
- No production file changes.
- Append verification evidence to the implementation handoff; do not modify the accepted design unless a contract changes.

- [ ] **Step 1: Build and run a supported local Web artifact**

Run the repository's supported full build/restart path only if the user authorizes deployment. Otherwise use a fresh Playwright webServer from the branch and label the result test-surface, not active deployment.

- [ ] **Step 2: Verify the real warehouse dataset when deployment is authorized**

Using the active Workbench data:

- Session: `sess_32d50957660d465f9af535b07e605f5f`;
- related Candidate: `flow_save_497fd225fbde4d6297b1707e64752646`;
- unrelated Candidate: `flow_save_bec75c00530fa7c848d8eeafe8722074`.

Assert:

1. click Pi warehouse Session;
2. click Flows;
3. `Flow 管理` is visible and Session conversation is absent;
4. related warehouse Candidate is selected;
5. `channel-package-build-compare` is not selected;
6. click Pi and confirm the original warehouse Session is restored.

- [ ] **Step 3: Final verification before completion**

Run:

```bash
pnpm vitest run apps/web/src/lib/flow-navigation.test.ts apps/web/src/components/session-chrome.test.tsx apps/web/src/components/workbench-component-policy.test.ts
pnpm playwright test e2e/flow-save-inbox.spec.ts e2e/flow-save-intent.spec.ts
pnpm --filter @codebridge/web build
git diff --check
git status --short
```

Report exact test/file counts and distinguish implemented, test-reachable, active-reachable, and closed-loop. Telegram remains disabled.
