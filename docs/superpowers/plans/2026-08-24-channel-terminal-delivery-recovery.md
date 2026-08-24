# Channel Terminal Delivery Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover a terminal Feishu card from persisted Session events and complete Delivery without depending on a future Core SSE terminal event or rerunning the Agent/Flow.

**Architecture:** Add one optional finite-history read method to the shared channel ingress, backed by the existing non-live Session events endpoint. During terminal Delivery reconciliation, replay only the target Run into the existing Agent/Flow projectors, patch the original card, and complete Delivery only after the replay is confirmed and the patch succeeds.

**Tech Stack:** TypeScript, Hono, SQLite-backed Session event log, Vitest, existing Feishu watcher and channel projectors.

---

## 0. Locked invariants

- Runtime Run is the task-status fact source; persisted Session events are the result fact source.
- Live SSE is a latency mechanism, not a recovery dependency.
- Never submit, rerun, retry, or mutate the business Flow while recovering a Delivery.
- `Delivery completed` requires terminal Run + confirmed persisted replay + successful terminal card patch.
- “本次无输出” is legal only after persisted replay succeeds and yields no Agent or structured Flow output.
- Telegram remains disabled; it only inherits the additive shared ingress type.
- Do not stage or modify unrelated dirty workspace files.

## 1. File map

- Modify `packages/core/src/types.ts`: add optional finite event replay to `ChannelSessionIngress`.
- Modify `apps/bridge/src/channel-ingress.ts`: call the existing non-live events endpoint and return a finite array.
- Modify `apps/bridge/src/channel-ingress.test.ts`: lock the non-live URL, cursor, parsing, and error behavior.
- Modify `packages/channel-feishu/src/session-watcher.ts`: hydrate terminal projectors from durable events and complete during reconciliation.
- Modify `packages/channel-feishu/src/session-watcher.test.ts`: reproduce restart, missing replay, true empty, structured Flow, write failure, and idempotency cases.
- Modify `docs/superpowers/specs/2026-08-24-channel-terminal-delivery-recovery-design.md`: mark the approved design Accepted.

## 2. Task 1 — Add finite persisted event replay

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `apps/bridge/src/channel-ingress.ts`
- Test: `apps/bridge/src/channel-ingress.test.ts`

- [ ] **Step 1: Write the failing ingress tests**

Add a test whose Hono route returns two finite SSE records and assert:

```ts
const events = await ingress.replayEvents!("sess_1", { afterSequence: 625 });
expect(requestUrl).toBe(
  "/v1/sessions/sess_1/events?after_sequence=625",
);
expect(events.map((event) => event.sequence)).toEqual([626, 627]);
```

Add a non-2xx test expecting `Channel event replay failed (503)`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm vitest run apps/bridge/src/channel-ingress.test.ts
```

Expected: FAIL because `replayEvents` does not exist.

- [ ] **Step 3: Add the optional shared contract**

Add to `ChannelSessionIngress`:

```ts
replayEvents?(
  sessionId: string,
  opts: { afterSequence: number },
): Promise<ChannelSessionEvent[]>;
```

Keep it optional so existing channel test doubles and disabled Telegram behavior remain compatible.

- [ ] **Step 4: Implement finite replay through the existing endpoint**

In `createChannelSessionIngress`, request the same endpoint without `live=true`:

```ts
const replayEvents = async (
  sessionId: string,
  opts: { afterSequence: number },
): Promise<ChannelSessionEvent[]> => {
  const response = await app.request(
    `/v1/sessions/${encodeURIComponent(sessionId)}/events?after_sequence=${opts.afterSequence}`,
    { headers: auth },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Channel event replay failed (${response.status})`);
  }
  const events: ChannelSessionEvent[] = [];
  for await (const event of readSessionEvents(response.body)) events.push(event);
  return events;
};
```

Return it from the ingress object next to `events`.

- [ ] **Step 5: Re-run the focused test and confirm GREEN**

Run the Step 2 command. Expected: PASS.

## 3. Task 2 — Make terminal reconciliation self-sufficient

**Files:**
- Modify: `packages/channel-feishu/src/session-watcher.ts`
- Test: `packages/channel-feishu/src/session-watcher.test.ts`

- [ ] **Step 1: Replace the old recovery expectation with failing invariant tests**

Add tests for these exact contracts:

```text
terminal snapshot + persisted final AGENT_EVENT
  -> original card contains final answer
  -> completeDelivery called without watcher.start()

terminal snapshot + replay unavailable/failing
  -> card contains “结果恢复中”
  -> card does not contain “本次无输出”
  -> completeDelivery not called

terminal snapshot + successful empty replay
  -> card contains “本次无输出”
  -> completeDelivery called

terminal snapshot + structured Flow history
  -> card contains rendered Flow result
  -> completeDelivery called

terminal card patch failure
  -> completeDelivery not called
```

- [ ] **Step 2: Run the watcher test and confirm RED**

Run:

```bash
pnpm vitest run packages/channel-feishu/src/session-watcher.test.ts
```

Expected: FAIL because reconciliation writes an empty terminal card before persisted replay and waits for terminal SSE to complete.

- [ ] **Step 3: Track whether durable result recovery is confirmed**

Extend each resumed-card entry with:

```ts
resultRecovery: "pending" | "confirmed";
```

Initialize it to `pending`. In terminal rendering, `pending` must produce `⏳ 结果恢复中` instead of the projector's empty fallback.

- [ ] **Step 4: Add pure target-Run replay**

Add a private helper that receives a finite event array and, only when `event.runId === runId`:

- applies `AGENT_EVENT` to `ChannelStreamProjector` and run activity;
- applies structured Flow events to `ChannelFlowProjector`;
- applies the existing nonfatal `STEP_FAILED` fallback once;
- performs no card write, Delivery transition, submit, or Runtime mutation.

Set `resultRecovery = "confirmed"` only after the finite replay call completes successfully.

- [ ] **Step 5: Commit terminal Delivery from reconciliation**

For a terminal `runSnapshot`:

```ts
await restorePersistedResult(delivery, resumed);
applyRunSnapshot(resumed.runStatus, delivery.runSnapshot);
const written = await writeResumedCard(delivery.runId, resumed);
if (resumed.resultRecovery === "confirmed" && written) {
  await completeRecoveredDelivery(delivery.runId);
}
```

If replay is missing or throws, log a structured recovery warning, write the recoverable terminal state, and leave Delivery unfinished. Preserve terminal-event handling for the normal live path; both completion paths must remain idempotent.

- [ ] **Step 6: Re-run watcher tests and confirm GREEN**

Run the Step 2 command. Expected: PASS.

## 4. Task 3 — Integration regression and current Delivery recovery

**Files:**
- Test existing channel, router, work-items, and Bridge suites.
- No business data writes other than the existing Delivery/card reconciliation.

- [ ] **Step 1: Run focused cross-package regression**

```bash
pnpm vitest run \
  apps/bridge/src/channel-ingress.test.ts \
  packages/channel-feishu/src/session-watcher.test.ts \
  packages/channel-feishu/src/bridge-recovery.test.ts \
  packages/channel-feishu/src/bridge-lifecycle.test.ts \
  packages/channel-telegram/src/telegram-session-watcher.test.ts \
  packages/router/src/channel-stream-projector.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package type/build checks**

Run the repository's existing lint/build gates for touched packages. Expected: no new errors.

- [ ] **Step 3: Run GitNexus change detection**

```bash
npx gitnexus detect-changes --repo CodeBridge
```

Expected: only shared ingress replay and Feishu terminal-delivery recovery flows are affected.

- [ ] **Step 4: Commit implementation**

Stage only the files listed in §1 and commit:

```bash
git commit -m "fix(feishu): recover terminal output from persisted events"
```

- [ ] **Step 5: Restart Bridge and recover the existing stuck Delivery**

Restart through the repository's existing service command. Let the regular Delivery reconciler process `turn_640c1da4a2064664a831b2513c0b198c`; do not submit a new message or rerun `run_cd03401eaa4f450fbf6bba2529f929cd`.

- [ ] **Step 6: Verify terminal surface and persistence**

Assert:

```text
original Feishu card contains the persisted dry-run result
card no longer contains “本次无输出” or “结果恢复中”
channel_turn_delivery.status == completed
no new Run was created for the repair
```

If Feishu rejects the old card as permanently invalid, retain Delivery and report the exact provider error; do not send an untracked fallback message.

## 5. Task 4 — Persist and update the actual CardKit instance

实机复核证明 `im.message.patch(surface_message_id)` 不能更新 SDK 创建的流式 CardKit 实例。本任务修订 Task 3 的“patch 成功”定义。

- [x] **Step 1: RED — 锁定双 ID 与失败不完成合同**

  覆盖 schema 迁移、ack 的可选 `surface_card_id`、新卡同时确认 message/card ID、历史 ID 解析、解析失败不完成，以及恢复写入使用 `card_id`。

- [x] **Step 2: 持久化 CardKit ID**

  `ChannelDeliveryRow` 增加 `surfaceCardId`；ack 保持旧三参数兼容，并允许第四参数原子保存 CardKit ID。SQLite 迁移保留旧行并为其写入 `NULL`。

- [x] **Step 3: 改用 CardKit 全量更新**

  新卡从 SDK controller 取得运行时 `cardId`。恢复路径只调用 `cardkit.v1.card.update`，并检查响应；不再把 IM message PATCH 成功当成用户表面成功。

- [x] **Step 4: 历史兼容**

  对 `surface_card_id IS NULL` 的 Delivery 调用 `card.idConvert(surface_message_id)`，成功后持久化再写卡；缺权限或解析失败时保留 Delivery。

- [ ] **Step 5: 全量验证、提交和重启**

  运行全量 test/lint/build 与 GitNexus change detection，仅提交本任务文件，然后重启 Bridge。

- [ ] **Step 6: 历史误完成补偿与实机验收**

  将本次错误窗口内误标 completed 的 10 条 Delivery 恢复为可对账状态；这只修复交付状态，不创建新 Run。开通 `cardkit:card:read` 后由正常 reconciler 解析旧 card ID、更新原卡并完成 Delivery，以飞书实机可见结果作为最终验收。
