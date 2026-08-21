# Unified Channel Stream Projector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace channel-specific commentary/result accumulation with one deterministic projector, eliminating Feishu progress replay while keeping Telegram's primary interaction unchanged.

**Architecture:** Add a pure `ChannelStreamProjector` in `packages/router` on top of the existing presenter. It owns thinking/progress/result state and emits live/final snapshots; Feishu and Telegram retain only transport, status, retry, and delivery behavior.

**Tech Stack:** TypeScript, Vitest, `@codebridge/core` AgentEvent, existing `@codebridge/router` presenter, Feishu and Telegram adapters.

**Spec:** `docs/superpowers/specs/2026-08-21-channel-stream-projector-design.md`

---

### Task 1: Build the deterministic projector

**Files:**
- Create: `packages/router/src/channel-stream-projector.ts`
- Create: `packages/router/src/channel-stream-projector.test.ts`
- Modify: `packages/router/src/index.ts`

- [ ] **Step 1: Add failing tests for progress merge and snapshot semantics**

Cover exact duplicate, cumulative growth, prefix rollback, overlap delta, unrelated new message, related new message, truncation, final exclusion, error inclusion, determinism, and `showThinking=false`.

Core regression sequence:

```ts
const projector = createChannelStreamProjector({ showThinking: false });
projector.apply({
  type: "text_delta",
  phase: "commentary",
  messageId: "m1",
  text: "你好",
});
projector.apply({ type: "tool_start", toolCallId: "t1", name: "Read" });
projector.apply({ type: "tool_end", toolCallId: "t1", name: "Read" });
projector.apply({
  type: "text_delta",
  phase: "commentary",
  messageId: "m1",
  text: "你好，我来帮你处理",
});
projector.apply({
  type: "text_delta",
  phase: "commentary",
  messageId: "m2",
  text: "你好",
});
projector.apply({
  type: "text_delta",
  phase: "commentary",
  messageId: "m2",
  text: "你好",
});

expect(projector.snapshot().progress).toBe("你好，我来帮你处理");
```

Final contract:

```ts
projector.apply({
  type: "text_delta",
  phase: "final_answer",
  messageId: "final-1",
  text: "已处理完成",
});
expect(projector.snapshot().finalText).toBe("已处理完成");
expect(projector.snapshot().finalText).not.toContain("你好");
```

- [ ] **Step 2: Run the new test and verify RED**

```bash
pnpm vitest run packages/router/src/channel-stream-projector.test.ts
```

Expected: FAIL because the module/export does not exist.

- [ ] **Step 3: Implement the projector**

Public types:

```ts
export interface ChannelStreamSnapshot {
  thinking: string;
  progress: string;
  result: string;
  liveText: string;
  finalText: string;
}

export interface ChannelStreamProjectorOptions {
  showThinking?: boolean;
  maxProgressChars?: number;
  emptyFinalText?: string;
}

export interface ChannelStreamProjector {
  apply(event: AgentEvent): ChannelStreamSnapshot;
  snapshot(): ChannelStreamSnapshot;
}
```

Progress merge implementation:

```ts
function mergeProgressText(
  previous: string,
  next: string,
  sameMessage: boolean,
): string {
  if (!previous) return next;
  if (!next || next === previous) return previous;
  if (next.startsWith(previous)) return next;
  if (previous.startsWith(next)) return previous;
  if (!sameMessage) return next;
  for (let size = Math.min(previous.length, next.length); size > 0; size -= 1) {
    if (previous.endsWith(next.slice(0, size))) {
      return previous + next.slice(size);
    }
  }
  return previous + next;
}
```

For message changes, prefix-related values still flow through `mergeProgressText`; unrelated values pass `sameMessage=false` and replace the checkpoint. Apply `.slice(-maxProgressChars)` after merging.

Snapshot composition:

```ts
const liveSections = [
  thinking || undefined,
  progress ? `**最新进度**\n${progress}` : undefined,
  result || undefined,
].filter((value): value is string => Boolean(value));

return {
  thinking,
  progress,
  result,
  liveText: liveSections.join("\n\n---\n\n"),
  finalText: result.trim() || emptyFinalText,
};
```

- [ ] **Step 4: Export and run projector/presenter tests**

```bash
pnpm vitest run \
  packages/router/src/channel-stream-projector.test.ts \
  packages/router/src/feishu-stream-presenter.test.ts
```

Expected: PASS.

---

### Task 2: Migrate Feishu SessionWatcher cards

**Files:**
- Modify: `packages/channel-feishu/src/session-watcher.ts`
- Modify: `packages/channel-feishu/src/session-watcher.test.ts`

- [ ] **Step 1: Re-run upstream impact analysis**

```bash
npx gitnexus impact --repo CodeBridge --direction upstream --include-tests \
  'Method:packages/channel-feishu/src/session-watcher.ts:FeishuRunCard.onAgentEvent#1'
```

Expected: LOW. Stop and report if it becomes HIGH/CRITICAL.

- [ ] **Step 2: Add a failing FeishuRunCard regression**

Feed the regression sequence from Task 1, capture every `setContent(full)`, and assert the last live card before final:

```ts
expect(live).toContain("你好，我来帮你处理");
expect(live.match(/你好/g)).toHaveLength(1);
```

After finalization:

```ts
expect(contents.at(-1)).toBe("已处理完成");
```

- [ ] **Step 3: Run and verify RED**

```bash
pnpm vitest run packages/channel-feishu/src/session-watcher.test.ts
```

Expected: the new assertion shows repeated `你好` with the old accumulator.

- [ ] **Step 4: Replace FeishuRunCard buffers with projector state**

Create one projector in the constructor. `queueRender` reads:

```ts
const snapshot = this.projector.snapshot();
const body = this.showLiveStatus ? snapshot.liveText : snapshot.finalText;
```

The 10-minute notice reads `snapshot.progress`. `onAgentEvent` keeps permission/status handling, calls `projector.apply(event)`, and queues one full snapshot. Remove `thinkingContent`, `progressContent`, `progressMessageId`, and `resultBuffer`.

- [ ] **Step 5: Migrate resumed cards**

Store a projector per resumed run. Replayed `AGENT_EVENT` calls `projector.apply`. Live recovery uses `snapshot.liveText`; terminal recovery uses `snapshot.finalText`.

- [ ] **Step 6: Run SessionWatcher tests**

```bash
pnpm vitest run packages/channel-feishu/src/session-watcher.test.ts
```

Expected: PASS.

---

### Task 3: Migrate Feishu legacy streaming

**Files:**
- Modify: `packages/channel-feishu/src/bridge.ts`
- Modify: `packages/channel-feishu/src/bridge-stream.test.ts`

- [ ] **Step 1: Re-run upstream impact analysis**

```bash
npx gitnexus impact --repo CodeBridge --direction upstream --include-tests \
  'Method:packages/channel-feishu/src/bridge.ts:FeishuBridge.streamAgentReply#6'
```

Expected: LOW. Stop and report if it becomes HIGH/CRITICAL.

- [ ] **Step 2: Add a failing legacy regression test**

Use the same commentary/tool/final sequence. Pause before final and assert the current rendered card contains one `你好` and the longest checkpoint; after release assert exact final `已处理完成`.

- [ ] **Step 3: Run and verify RED**

```bash
pnpm vitest run packages/channel-feishu/src/bridge-stream.test.ts
```

- [ ] **Step 4: Replace legacy buffers with one projector**

`consumeAgent` applies every non-permission event to the projector. Card rendering uses `snapshot.liveText`; terminal and fallback use `snapshot.finalText`. Keep activity status, coalescing writes, permission messages, card failure and ordinary-message fallback unchanged.

- [ ] **Step 5: Run Feishu tests**

```bash
pnpm vitest run \
  packages/channel-feishu/src/bridge-stream.test.ts \
  packages/channel-feishu/src/session-watcher.test.ts \
  packages/channel-feishu/src/coalescing-card-writer.test.ts
```

Expected: PASS.

---

### Task 4: Migrate Telegram without adding live edits

**Files:**
- Modify: `packages/channel-telegram/src/telegram-session-watcher.ts`
- Modify: `packages/channel-telegram/src/telegram-session-watcher.test.ts`
- Modify: `packages/channel-telegram/src/telegram-bridge.ts`
- Modify: `packages/channel-telegram/src/telegram-bridge.test.ts`

- [ ] **Step 1: Run upstream impact analysis**

```bash
npx gitnexus impact --repo CodeBridge --direction upstream --include-tests \
  'Method:packages/channel-telegram/src/telegram-session-watcher.ts:TelegramRunRenderer.onAgentEvent#1'
npx gitnexus impact --repo CodeBridge --direction upstream --include-tests \
  'Method:packages/channel-telegram/src/telegram-bridge.ts:TelegramBridge.runLegacyAgent#3'
```

Stop and report HIGH/CRITICAL risk.

- [ ] **Step 2: Add Telegram contract tests**

Primary watcher:

```ts
expect(api.sendMessage).toHaveBeenCalledTimes(1); // placeholder only during run
expect(api.editMessage).toHaveBeenCalledWith(chatId, messageId, "已处理完成");
```

Legacy path: commentary/tool events are excluded from the terminal message; result/error remain.

- [ ] **Step 3: Replace Telegram accumulation**

`TelegramRunRenderer` owns a projector and calls `apply`. `finalize` uses `snapshot.finalText`. `runLegacyAgent` does the same. Do not call `editMessage` per event.

- [ ] **Step 4: Run Telegram tests**

```bash
pnpm vitest run \
  packages/channel-telegram/src/telegram-session-watcher.test.ts \
  packages/channel-telegram/src/telegram-bridge.test.ts
```

Expected: PASS.

---

### Task 5: Verify scope and integration

**Files:**
- Verify all files changed in Tasks 1–4

- [ ] **Step 1: Scan for duplicate channel accumulators**

```bash
rg 'progressContent \+ part\.text|resultBuffer \+=|output \+= part\.text' \
  packages/channel-feishu/src packages/channel-telegram/src
```

Expected: no production matches for stream projection accumulation.

- [ ] **Step 2: Run focused suite**

```bash
pnpm vitest run \
  packages/router/src/channel-stream-projector.test.ts \
  packages/router/src/feishu-stream-presenter.test.ts \
  packages/channel-feishu/src/session-watcher.test.ts \
  packages/channel-feishu/src/bridge-stream.test.ts \
  packages/channel-feishu/src/coalescing-card-writer.test.ts \
  packages/channel-telegram/src/telegram-session-watcher.test.ts \
  packages/channel-telegram/src/telegram-bridge.test.ts
```

- [ ] **Step 3: Run repository validation**

```bash
pnpm test
pnpm lint
pnpm build
```

- [ ] **Step 4: Run GitNexus change detection**

```bash
npx gitnexus detect-changes --scope unstaged --repo CodeBridge
```

Confirm only stream projection, Feishu, Telegram, and their tests are affected.

- [ ] **Step 5: Review diff and commit only after user approval**

```bash
git diff --check
git status --short
```

Do not stage unrelated untracked files.
