# Provider Session History Import and Web Overflow Implementation Plan

> **Status:** Implemented and verified on 2026-08-25.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Web loop for explicitly importing Provider Session history and guarantee that long Session/Queue/message content cannot expand the Workbench beyond its viewport.

**Architecture:** Keep Bridge GET routes pure and reuse the existing `provider-history/preview` and `provider-history/import` POST contracts. Add typed Web API calls and a presentation-only import card; `Workbench` owns request identity, stale-response rejection, idempotency-key reuse, and snapshot refresh. Fix overflow at the Grid/Flex min-size chain rather than masking it with page-level clipping.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Hono, Vitest/jsdom, Playwright, GitNexus.

---

## 0. Locked Contracts and Task Map

### 0.1 Provider History error matrix

| HTTP | `error` | Meaning | Web recovery |
|---|---|---|---|
| 400 | `confirmation_and_idempotency_key_required` | Web violated the write contract | Non-retryable implementation error |
| 404 | `session_not_found` | Selected Session no longer exists | Refresh Session list; do not retry Import |
| 409 | `provider_session_not_bound` | Session has no Provider identity | Non-retryable binding error |
| 409 | `provider_history_prefix_changed` | Imported prefix no longer matches Provider history | Block Import; automatic merge is unsafe |
| 409 | `provider_history_cursor_conflict` | Import cursor changed concurrently | Re-run Preview; require a new confirmation |
| 502 | `provider_history_unavailable` | Runner/Provider could not load history | Allow retry |
| 503 | `runner_unavailable` | Bridge has no Runner history capability | Allow retry after recovery |
| network/unknown | no HTTP response | Outcome may be unknown | Retry Import with the same key |

### 0.2 Idempotency client contract

- `api.importProviderHistory(sessionId, idempotencyKey)` receives the key from its caller and sends it only in the `Idempotency-Key` header.
- `Workbench` creates a key when the user confirms Import.
- Until a known HTTP outcome arrives, retries for that confirmation reuse the same key.
- Success, a non-retryable HTTP response, Session switch, or cursor-conflict Preview clears the pending key.
- A later user confirmation creates a new key.

### 0.3 Surface Matrix planning gate

| Surface | Entry | Read path | Write path | Event consumption | Error handling | Recovery | Terminal feedback | Planned landing |
|---|---|---|---|---|---|---|---|---|
| Web | Select Provider Session | Preview + Snapshot | Confirmed Import | N/A: synchronous request/response; then Snapshot refresh | Error card | Retry Preview or same-key Import; reject stale response | Timeline + imported count | H1–H3, E1 |
| Backend | Existing routes | Runner loader | ProviderHistoryImporter | N/A: synchronous canonical event write | Exact status/code matrix | Existing idempotency | Import result + Snapshot | C1 |
| Agent/Provider | Existing Provider Session | Runner loader | None | N/A | Loader failure → 502/503 | Provider unchanged | Source history unchanged | C1 regression only |
| Feishu | No entry | None | None | N/A | N/A | N/A | N/A | Out of scope |
| Telegram | No entry | None | None | N/A | N/A | N/A | N/A | Out of scope |

### 0.4 Risk gate

Pre-plan GitNexus: `Workbench` LOW in the graph but manually MEDIUM as the active Web surface; `SessionHeader`, `SessionQueue`, and `ProviderHistoryImporter` LOW. `ProviderHistoryImporter` is not edited. If refreshed impact is HIGH/CRITICAL, stop and report before editing.

---

### Task H1: Add typed Provider History Web API contracts

**Files:**
- Modify: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/lib/api.ts`
- Test: `apps/web/src/lib/api.test.ts`

- [x] **Step 1: Write failing API contract tests**

Add tests proving Preview uses POST without a key and Import uses the caller's header key plus `{ confirm: true }`:

```ts
await api.previewProviderHistory("sess_1");
expect(fetch).toHaveBeenCalledWith(
  "/v1/sessions/sess_1/provider-history/preview",
  expect.objectContaining({ method: "POST" }),
);

await api.importProviderHistory("sess_1", "history-confirm-1");
const init = fetch.mock.calls.at(-1)?.[1] as RequestInit;
expect(new Headers(init.headers).get("Idempotency-Key"))
  .toBe("history-confirm-1");
expect(JSON.parse(String(init.body))).toEqual({ confirm: true });
```

- [x] **Step 2: Run RED**

Run `rtk proxy pnpm vitest run apps/web/src/lib/api.test.ts`.

Expected: missing methods/types.

- [x] **Step 3: Add exact response types**

```ts
export interface ProviderHistoryPreview {
  providerSessionId: string;
  importedPosition: number;
  providerPosition: number;
  importableEvents: number;
  nextDigest: string;
}

export interface ProviderHistoryImportResult {
  importedEvents: number;
  importedTurns: number;
  lastEventSequence: number;
}
```

- [x] **Step 4: Add caller-owned API methods**

```ts
previewProviderHistory: (sessionId: string) =>
  request<ProviderHistoryPreview>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/provider-history/preview`,
    { method: "POST" },
  ),
importProviderHistory: (sessionId: string, idempotencyKey: string) =>
  request<ProviderHistoryImportResult>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/provider-history/import`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ confirm: true }),
    },
  ),
```

The API layer must not generate the key or put it in the body.

- [x] **Step 5: Run GREEN and build**

Run:

```bash
rtk proxy pnpm vitest run apps/web/src/lib/api.test.ts
rtk proxy pnpm --filter @codebridge/web build
```

- [x] **Step 6: Commit**

```bash
rtk git add apps/web/src/lib/types.ts apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts
rtk git commit -m "feat(web): add provider history API contracts"
```

---

### Task H2: Build a presentation-only Provider History card

**Files:**
- Create: `apps/web/src/components/provider-history-import-card.tsx`
- Create: `apps/web/src/components/provider-history-import-card.test.tsx`

- [x] **Step 1: Write failing state and error tests**

Cover `previewing`, `available`, `importing`, `imported`, `empty`, and `error`. Assert available has only `导入历史`; importing disables it; Preview error has `重试检查`; unknown Import outcome has `重试导入`; prefix drift has no retry; imported shows event and turn counts.

- [x] **Step 2: Run RED**

Run `rtk proxy pnpm vitest run apps/web/src/components/provider-history-import-card.test.tsx`.

- [x] **Step 3: Implement a closed state union**

```ts
export type ProviderHistoryImportState =
  | { kind: "idle" }
  | { kind: "previewing"; sessionId: string }
  | { kind: "available"; sessionId: string; preview: ProviderHistoryPreview }
  | { kind: "importing"; sessionId: string; preview: ProviderHistoryPreview }
  | { kind: "imported"; sessionId: string; result: ProviderHistoryImportResult }
  | { kind: "empty"; sessionId: string }
  | {
      kind: "error";
      sessionId: string;
      code: string;
      message: string;
      retry: "preview" | "import" | null;
    };
```

The card accepts state plus action callbacks and must not import `api`, `sessionViewStore`, or `crypto`.

- [x] **Step 4: Add a pure error mapper**

```ts
export function providerHistoryErrorPresentation(
  error: unknown,
  phase: "preview" | "import",
): Pick<Extract<ProviderHistoryImportState, { kind: "error" }>,
  "code" | "message" | "retry">;
```

Map §0.1 exactly. Network/unknown Import errors retry Import; cursor conflict retries Preview; prefix drift, missing binding/Session, and invalid confirmation are non-retryable.

- [x] **Step 5: Run GREEN and commit**

```bash
rtk proxy pnpm vitest run apps/web/src/components/provider-history-import-card.test.tsx
rtk git add apps/web/src/components/provider-history-import-card.tsx apps/web/src/components/provider-history-import-card.test.tsx
rtk git commit -m "feat(web): add provider history import card"
```

---

### Task H3: Wire Preview, confirmed Import, stale rejection, and refresh

**Files:**
- Modify: `apps/web/src/components/workbench.tsx`
- Modify: `apps/web/src/components/workbench-component-policy.test.ts`
- Test: `e2e/provider-history-overflow.spec.ts`

- [x] **Step 1: Write failing policy tests**

Require `ProviderHistoryImportCard`, `api.previewProviderHistory`, `api.importProviderHistory`, `pendingHistoryImportKey`, and `providerHistoryRequestVersion`. Also assert GET/openSession remain pure reads.

- [x] **Step 2: Write failing browser race and retry tests**

Mock Sessions A/B. Delay A Preview, switch to B, return B empty, then release A with 401; A's card must not appear over B. For Import, abort the first request after recording its key, click `重试导入`, return success, and assert both requests used the same key.

- [x] **Step 3: Run RED**

```bash
rtk proxy pnpm vitest run apps/web/src/components/workbench-component-policy.test.ts
rtk proxy pnpm exec playwright test e2e/provider-history-overflow.spec.ts --grep "history"
```

- [x] **Step 4: Add request and key state**

```ts
const [providerHistory, setProviderHistory] =
  useState<ProviderHistoryImportState>({ kind: "idle" });
const providerHistoryRequestVersion = useRef(0);
const pendingHistoryImportKey = useRef<{
  sessionId: string;
  key: string;
} | null>(null);
```

Every request captures `sessionId` and the incremented version. Before applying a response:

```ts
if (
  selectedSessionRef.current !== sessionId
  || providerHistoryRequestVersion.current !== requestVersion
) return;
```

Session switch increments the version, clears the key, and resets state.

- [x] **Step 5: Preview every selected Provider-backed Session**

Do not require `task_record_id === null`; partially imported Provider histories may grow. Resolve results as:

- events > 0 → available;
- events = 0 + empty Timeline → empty;
- events = 0 + existing Timeline → idle;
- error → mapped error.

Non-Provider Sessions perform no Preview.

- [x] **Step 6: Implement same-key unknown retry**

```ts
const pending = pendingHistoryImportKey.current;
const key = pending?.sessionId === sessionId
  ? pending.key
  : crypto.randomUUID();
pendingHistoryImportKey.current = { sessionId, key };
```

Unknown/network failure retains the key. Success and known non-retryable HTTP errors clear it. Cursor conflict clears it and re-runs Preview before a new confirmation.

- [x] **Step 7: Refresh both Web stores after success**

```ts
const snapshot = await api.openSession(sessionId);
if (selectedSessionRef.current !== sessionId) return;
sessionViewStore.hydrate(snapshot);
setSessions((current) => current.map((item) =>
  item.session_id === snapshot.session.session_id
    ? snapshot.session
    : item,
));
setProviderHistory({ kind: "imported", sessionId, result });
```

Web must not synthesize Timeline blocks.

- [x] **Step 8: Mount the card**

- Empty Timeline + previewing/available/importing/empty/error → card replaces generic empty state.
- Existing Timeline + available/importing/error/imported → compact card above Timeline.
- Existing Timeline + empty/idle → no card.
- Imported state shows `已导入 N 条历史记录` and imported turn count.

- [x] **Step 9: Run GREEN and commit**

```bash
rtk proxy pnpm vitest run apps/web/src/components/workbench-component-policy.test.ts apps/web/src/components/provider-history-import-card.test.tsx apps/web/src/lib/api.test.ts
rtk proxy pnpm exec playwright test e2e/provider-history-overflow.spec.ts --grep "history"
rtk git add apps/web/src/components/workbench.tsx apps/web/src/components/workbench-component-policy.test.ts e2e/provider-history-overflow.spec.ts
rtk git commit -m "feat(web): close provider history import loop"
```

---

### Task O1: Fix the min-size chain and preserve operations

**Files:**
- Modify: `apps/web/src/components/workbench.tsx`
- Modify: `apps/web/src/components/session-chrome.tsx`
- Modify: `apps/web/src/components/session-queue.tsx`
- Modify: `apps/web/src/components/conversation.tsx`
- Modify: `apps/web/src/components/session-chrome.test.tsx`
- Modify: `apps/web/src/components/session-queue.test.tsx`
- Modify: `apps/web/src/components/workbench-component-policy.test.ts`
- Test: `e2e/provider-history-overflow.spec.ts`

- [x] **Step 1: Write failing component invariants**

Require Header variable region `min-w-0 flex-1 overflow-hidden`, action region `shrink-0`, Footer grid `min-w-0`, Queue row `grid-cols-[auto_minmax(0,1fr)_auto]`, message `line-clamp-2 [overflow-wrap:anywhere]`, and user bubble `[overflow-wrap:anywhere]`. Assert the cancel button remains rendered. Do not use page-level `overflow-x-hidden` as the fix.

- [x] **Step 2: Add hostile browser fixtures and run RED**

Return a 10,000-character title, 100 Queue Turns, 10,000-character Chinese/English/continuous tokens, URL/JSON/Markdown/code, and a 10,000-character user message. At 320/768/1280/1536 widths assert:

```ts
const metrics = await page.evaluate(() => ({
  clientWidth: document.documentElement.clientWidth,
  scrollWidth: document.documentElement.scrollWidth,
}));
expect(metrics.scrollWidth).toBe(metrics.clientWidth);
await expect(page.getByRole("button", { name: "Session 操作" }))
  .toBeInViewport();
await expect(page.getByRole("button", { name: /取消排队消息/ }).first())
  .toBeInViewport();
await expect(page.getByRole("textbox", { name: "消息" }))
  .toBeInViewport();
```

- [x] **Step 3: Fix Header shrink behavior**

Use a `flex-1 overflow-hidden` left region, `min-w-0 flex-1` text region with a title attribute, and `shrink-0` run/menu region. Status and menu never become shrink targets.

- [x] **Step 4: Fix Footer and Queue min-content expansion**

Add `min-w-0` to the Footer inner grid. Queue uses:

```tsx
<section className="min-w-0 overflow-hidden rounded-lg ...">
  <ol className="min-w-0 divide-y ...">
    <li className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 ...">
      <span>...</span>
      <span
        className="line-clamp-2 min-w-0 [overflow-wrap:anywhere] ..."
        title={turn.message.text}
      >{turn.message.text}</span>
      <Button ...>取消</Button>
    </li>
  </ol>
</section>
```

- [x] **Step 5: Fix user content locally**

Use `min-w-0 max-w-[72%] [overflow-wrap:anywhere]` on user bubbles. Leave Markdown tables and Tool outputs in their existing local scroll containers.

- [x] **Step 6: Run GREEN and commit**

```bash
rtk proxy pnpm vitest run apps/web/src/components/session-chrome.test.tsx apps/web/src/components/session-queue.test.tsx apps/web/src/components/workbench-component-policy.test.ts
rtk proxy pnpm exec playwright test e2e/provider-history-overflow.spec.ts --grep "overflow"
rtk git add apps/web/src/components/workbench.tsx apps/web/src/components/session-chrome.tsx apps/web/src/components/session-queue.tsx apps/web/src/components/conversation.tsx apps/web/src/components/session-chrome.test.tsx apps/web/src/components/session-queue.test.tsx apps/web/src/components/workbench-component-policy.test.ts e2e/provider-history-overflow.spec.ts
rtk git commit -m "fix(web): contain long session and queue content"
```

---

### Task C1: Lock existing Bridge errors and persistence

**Files:**
- Modify: `apps/bridge/src/session-api.test.ts`
- Re-run: `apps/bridge/src/session-history-import.test.ts`

- [x] **Step 1: Add table-driven route error tests**

Verify §0.1 status/code pairs for missing confirmation/key, missing Session, missing Provider binding, prefix change, unavailable history, and absent Runner. Assert cursor conflict at the importer/store layer if the HTTP fixture would require production internals.

- [x] **Step 2: Strengthen the success test**

After Import, GET the Session snapshot and assert `task_record_id`, a Timeline turn, user and assistant blocks. Repeat Import with the same key and assert the result is identical and Timeline length does not increase.

- [x] **Step 3: Run and commit**

```bash
rtk proxy pnpm vitest run apps/bridge/src/session-api.test.ts apps/bridge/src/session-history-import.test.ts
rtk git add apps/bridge/src/session-api.test.ts
rtk git commit -m "test(bridge): lock provider history import contract"
```

---

### Task E1: Complete the active-surface adversarial suite

**Files:**
- Finalize: `e2e/provider-history-overflow.spec.ts`
- Modify only if required: `playwright.config.ts`

- [x] **Step 1: Complete history cases**

Cover Preview 0 with empty/existing Timeline, Preview 401 with no pre-click Import, confirmed Import, Preview failure, same-key unknown retry, prefix drift, and delayed A/B race.

- [x] **Step 2: Complete overflow cases**

Run every hostile content fixture at 320/768/1280/1536. Measure document width and Header/Queue/Composer bounding boxes.

- [x] **Step 3: Run three times plus Flow regression**

```bash
rtk proxy pnpm exec playwright test e2e/provider-history-overflow.spec.ts --repeat-each=3
rtk proxy pnpm exec playwright test e2e/flow-loop.spec.ts
```

- [x] **Step 4: Commit remaining E1 changes if any**

```bash
rtk git add e2e/provider-history-overflow.spec.ts playwright.config.ts
rtk git commit -m "test(web): add adversarial history and overflow coverage"
```

Skip if H3/O1 already committed every E1 line.

---

### Task V1: Full verification and completion gate

**Files:**
- Update: `docs/superpowers/specs/2026-08-25-session-history-import-overflow-design.md`
- Update: `docs/superpowers/plans/2026-08-25-session-history-import-overflow.md`

- [x] **Step 1: Run focused tests and builds**

```bash
rtk proxy pnpm vitest run apps/web/src/lib/api.test.ts apps/web/src/components/provider-history-import-card.test.tsx apps/web/src/components/session-chrome.test.tsx apps/web/src/components/session-queue.test.tsx apps/web/src/components/workbench-component-policy.test.ts apps/bridge/src/session-api.test.ts apps/bridge/src/session-history-import.test.ts
rtk proxy pnpm --filter @codebridge/web build
rtk proxy pnpm --filter @codebridge/bridge build
```

- [x] **Step 2: Run browser suites**

```bash
rtk proxy pnpm exec playwright test e2e/provider-history-overflow.spec.ts --repeat-each=3
rtk proxy pnpm exec playwright test e2e/flow-loop.spec.ts
```

- [x] **Step 3: Reconcile Surface Matrix**

Web becomes `implemented + reachable + closed-loop` only after browser verification. Backend becomes closed-loop through route/persistence tests. Agent remains read-only; Feishu/Telegram remain non-goals; event consumption remains explicit `N/A`.

- [x] **Step 4: Verify the real Session without writing it**

Against the active local Bridge, Preview `sess_6c9d9dbc38314d32a3b957c9cebcb84a` and assert 401 importable events. In active Web, select it and assert the 401-event confirmation card. Do not click Import on the real Session during automation; the user-facing confirmation remains the write boundary.

- [x] **Step 5: Build/restart local CodeBridge and verify health**

```bash
rtk bash scripts/start.sh restart
rtk bash scripts/start.sh status
```

- [x] **Step 6: GitNexus completion gate**

```bash
rtk proxy npx gitnexus detect-changes --scope compare --base-ref main --repo CodeBridge
rtk git diff --check main...HEAD
rtk git status --short --branch
```

Only H1–H3/O1/C1/E1/V1 files and expected Web/API flows may appear. User-owned `AGENTS.md` and untracked files stay outside commits.

- [x] **Step 7: Mark documents implemented and commit**

Set design status to `Implemented and verified`, check completed plan boxes, then:

```bash
rtk git add docs/superpowers/specs/2026-08-25-session-history-import-overflow-design.md docs/superpowers/plans/2026-08-25-session-history-import-overflow.md
rtk git commit -m "docs: record provider history and overflow verification"
```

- [x] **Step 8: Final report**

Report branch/commits, exact idempotency and errors, imported-count feedback, four viewport widths, test/build/Playwright totals, active 401-event Preview, final Surface Matrix, and remaining non-goals.

## Verification record（2026-08-25）

- H1–H3、O1、C1、E1 均按 TDD 独立提交；出现的有效 RED 包括缺少 Web API、未挂载状态卡、并发双击重复请求和旧 Flow 浏览器夹具漂移。
- Provider History 对抗套件三轮 30/30 通过；Flow 浏览器回归 1/1 通过。
- 聚焦 Vitest 7 个文件、157 个用例全部通过；`@codebridge/web` 与 `@codebridge/bridge` 构建通过。
- launchd 管理的 Bridge/Runner 已重启；重启后真实 Preview 仍返回 401 条可导入事件。
- 活跃 Web 对目标 Session 展示 401 条确认卡；320px 实测页面宽度无溢出，确认按钮可见且未点击。
- 最终 Surface Matrix 以设计稿 §6 为准；飞书、Telegram 历史导入仍为明确非目标。
