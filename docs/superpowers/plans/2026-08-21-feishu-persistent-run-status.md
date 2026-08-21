# Feishu Persistent Run Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Feishu run-status header visible from card creation through a frozen, accurately classified terminal state.

**Architecture:** Extract the duplicated Feishu run-status model, activity reducer, terminal transition, and renderer into one adapter-local pure module. SessionWatcher, delivery recovery, and legacy streaming keep their existing transport and delivery ownership, but compose every live and terminal card from the shared status renderer plus `ChannelStreamProjector` text.

**Tech Stack:** TypeScript, Vitest, `@codebridge/core` AgentEvent and ChannelSessionEvent, existing Feishu coalescing card writer.

**Spec:** `docs/superpowers/specs/2026-08-21-feishu-persistent-run-status-design.md`

---

### Task 1: Add the pure Feishu run-status lifecycle

**Files:**
- Create: `packages/channel-feishu/src/run-status.ts`
- Create: `packages/channel-feishu/src/run-status.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Cover running rendering, quiet rendering, terminal titles, frozen elapsed time, first-terminal-wins, and activity rejection after terminal:

```ts
const status = createFeishuRunStatus(1_000);
recordFeishuRunActivity(
  status,
  { type: "tool_start", toolCallId: "t1", name: "Read" },
  2_000,
);
expect(renderFeishuRunStatus(status, 3_000)).toContain("🟢 **执行中**");
expect(renderFeishuRunStatus(status, 3_000)).toContain("当前阶段：工具执行：Read");

finishFeishuRunStatus(status, "succeeded", 5_000);
expect(renderFeishuRunStatus(status, 99_000)).toContain("✅ **已完成** · 总耗时 4 秒");
expect(renderFeishuRunStatus(status, 99_000)).toContain("最终阶段：工具执行：Read");
```

For idempotency:

```ts
finishFeishuRunStatus(status, "failed", 8_000);
expect(status.state).toBe("succeeded");
expect(status.endedAt).toBe(5_000);
```

- [ ] **Step 2: Run the new test and verify RED**

```bash
pnpm vitest run packages/channel-feishu/src/run-status.test.ts
```

Expected: FAIL because `run-status.ts` does not exist.

- [ ] **Step 3: Implement the pure lifecycle module**

Define:

```ts
export type FeishuRunState =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface FeishuRunStatus {
  startedAt: number;
  lastActivityAt: number;
  phase: string;
  state: FeishuRunState;
  endedAt?: number;
}

export function createFeishuRunStatus(now = Date.now()): FeishuRunStatus;
export function recordFeishuRunActivity(
  status: FeishuRunStatus,
  event: AgentEvent,
  now?: number,
): boolean;
export function finishFeishuRunStatus(
  status: FeishuRunStatus,
  state: Exclude<FeishuRunState, "running">,
  now?: number,
): boolean;
export function renderFeishuRunStatus(
  status: FeishuRunStatus,
  now?: number,
): string;
```

`finishFeishuRunStatus` returns `false` without mutation when `status.state !== "running"`. Terminal rendering uses `endedAt` for elapsed time and never renders “最近确认活动”. Running rendering preserves the existing quiet threshold and latest phase.

- [ ] **Step 4: Run lifecycle tests**

```bash
pnpm vitest run packages/channel-feishu/src/run-status.test.ts
```

Expected: PASS.

---

### Task 2: Keep status through SessionWatcher and delivery recovery

**Files:**
- Modify: `packages/channel-feishu/src/session-watcher.ts`
- Modify: `packages/channel-feishu/src/session-watcher.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis before editing**

```bash
npx gitnexus impact --repo CodeBridge --direction upstream --include-tests \
  'Class:packages/channel-feishu/src/session-watcher.ts:FeishuRunCard'
npx gitnexus impact --repo CodeBridge --direction upstream --include-tests \
  'Class:packages/channel-feishu/src/session-watcher.ts:FeishuSessionWatcher'
```

Report HIGH/CRITICAL scope before continuing.

- [ ] **Step 2: Add failing main-path terminal tests**

Capture `setContent` writes and drive `RUN_SUCCEEDED`, `RUN_FAILED`, `RUN_CANCELLED`, and `RUN_INTERRUPTED`. Assert the final card contains the correct terminal title and `finalText`:

```ts
expect(contents.at(-1)).toContain("✅ **已完成**");
expect(contents.at(-1)).toContain("最终答案");
expect(contents.at(-1)).not.toContain("🟢 **执行中**");
```

Add an assertion after each live commentary/tool write that the card still contains `🟢 **执行中**` or `🟠 **任务连接保持**`.

- [ ] **Step 3: Add failing recovery terminal tests**

For a resumed delivery, replay a final answer then `RUN_SUCCEEDED`. Assert `updateCard(surfaceMessageId, ...)` includes `✅ **已完成**` and the answer, and that `completeDelivery` occurs only after the successful update.

- [ ] **Step 4: Run tests and verify RED**

```bash
pnpm vitest run packages/channel-feishu/src/session-watcher.test.ts
```

Expected: FAIL because `finalize()` currently removes the status header.

- [ ] **Step 5: Migrate SessionWatcher to the shared status module**

Remove the local `FeishuLiveStatus`, `recordLiveActivity`, and `renderLiveStatus`. `FeishuRunCard` owns a `FeishuRunStatus`; live writes always compose:

```ts
const statusText = renderFeishuRunStatus(this.runStatus);
const body = this.runStatus.state === "running"
  ? this.projector.snapshot().liveText
  : this.projector.snapshot().finalText;
```

Change terminal handling to:

```ts
await card.finalize(terminalStateForSessionEvent(event.type));
```

`finalize` calls `finishFeishuRunStatus`, stops timers, enqueues “terminal status + finalText”, flushes, then clears the pending stream.

- [ ] **Step 6: Migrate resumed cards**

Store `runStatus` beside the projector. On terminal domain events, call `finishFeishuRunStatus` before `updateCard`; compose terminal status and final text; preserve existing update-then-complete delivery ordering.

- [ ] **Step 7: Run SessionWatcher tests**

```bash
pnpm vitest run packages/channel-feishu/src/session-watcher.test.ts packages/channel-feishu/src/run-status.test.ts
```

Expected: PASS.

---

### Task 3: Keep status through legacy streaming and fallback

**Files:**
- Modify: `packages/channel-feishu/src/bridge.ts`
- Modify: `packages/channel-feishu/src/bridge-stream.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis before editing**

```bash
npx gitnexus impact --repo CodeBridge --direction upstream --include-tests \
  'Method:packages/channel-feishu/src/bridge.ts:FeishuBridge.streamAgentReply#6'
```

Report HIGH/CRITICAL scope before continuing.

- [ ] **Step 2: Add failing legacy terminal tests**

Verify:

```ts
done(0)          -> "✅ **已完成**"
done(non-zero)   -> "❌ **已失败**"
ordinary throw  -> "❌ **已失败**"
AbortError       -> "⏹ **已停止**"
```

Every final card must include the projected final answer/error. The existing commentary replay regression must remain unchanged.

- [ ] **Step 3: Run the tests and verify RED**

```bash
pnpm vitest run packages/channel-feishu/src/bridge-stream.test.ts
```

Expected: FAIL because the legacy final write currently removes the status block.

- [ ] **Step 4: Migrate legacy status handling**

Remove the duplicate local status type/reducer/renderer. Create one `FeishuRunStatus` per stream. While consuming events:

```ts
recordFeishuRunActivity(runStatus, event);
if (event.type === "done") {
  finishFeishuRunStatus(
    runStatus,
    event.exitCode === 0 ? "succeeded" : "failed",
  );
}
```

Map `AbortError` to `cancelled`, other thrown errors to `failed`, and normal exhaustion without `done` to `succeeded`. Always compose the final card and ordinary-message fallback from `renderFeishuRunStatus(runStatus)` plus `projector.snapshot().finalText`.

- [ ] **Step 5: Run focused Feishu tests**

```bash
pnpm vitest run \
  packages/channel-feishu/src/run-status.test.ts \
  packages/channel-feishu/src/session-watcher.test.ts \
  packages/channel-feishu/src/bridge-stream.test.ts \
  packages/channel-feishu/src/coalescing-card-writer.test.ts
```

Expected: PASS.

---

### Task 4: Validate, deploy locally, and inspect scope

**Files:**
- Modify only if validation exposes a scoped defect in the files above.

- [ ] **Step 1: Run static and repository validation**

```bash
pnpm build
pnpm test
git diff --check
```

Expected: build and tests PASS; diff check emits no output. Run `pnpm lint` and report any pre-existing Web-only failure separately from this change.

- [ ] **Step 2: Verify no terminal path drops the status**

```bash
rg -n 'showLiveStatus = false|statusText.*""|finalText' \
  packages/channel-feishu/src/bridge.ts \
  packages/channel-feishu/src/session-watcher.ts
```

Expected: no terminal branch suppresses the status renderer; final text is composed under terminal status.

- [ ] **Step 3: Run GitNexus change detection**

```bash
npx gitnexus detect-changes --scope unstaged --repo CodeBridge
```

Confirm affected processes remain limited to Feishu presentation/streaming plus the already-pending shared projector migration. Warn before any new HIGH/CRITICAL process expansion.

- [ ] **Step 4: Rebuild and restart local launchd services**

```bash
pnpm build
bash scripts/start.sh restart
bash scripts/start.sh status
```

Verify `/Users/keliang/.codebridge/bridge.log` contains `[ws] ws client ready` and `已连接飞书 bot` after restart.

- [ ] **Step 5: Leave implementation uncommitted for user verification**

Do not stage unrelated existing files or generated artifacts. Report the exact scoped file list and wait for the user to test the Feishu card before committing implementation.
