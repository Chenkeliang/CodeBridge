# Flow P1A Three-Channel Consumption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Web consumption behavior intact while making Feishu and Telegram list, parameterize, confirm, invoke, cancel, and resolve Runtime approval for the same Published Runbooks through the shared Bridge contracts.

**Architecture:** The Flow domain remains in the Catalog/Bridge/Runtime. `ChannelSessionIngress` exposes typed consumable metadata and one-shot invocation inputs; a new router-level `ChannelFlowController` owns only short-lived interaction state for `/flow` commands. Feishu and Telegram adapt transport and presentation, then submit the same explicit `flow_id + definition_revision + inputs` contract; neither channel binds a Session or executes Flow logic locally.

**Tech Stack:** TypeScript, Hono, Vitest, existing `@codebridge/core`, `@codebridge/router`, Feishu SDK, Telegram Bot API.

---

## Scope and contracts

- P1A consumption object is exactly a `published + runbook` returned by `GET /v1/flows?view=consume`.
- Channel invocation is one-shot. It always carries `flow_id`, `definition_revision`, and collected `inputs`; it never calls `apply` and never reads a historical Flow binding.
- `/flow` interaction state is an adapter concern only. It is keyed by channel conversation/topic and sender, expires in memory, and contains no Catalog lifecycle state.
- `/approve` and `/deny` remain Agent Permission commands. Runtime step approval uses `/flow approve` and `/flow reject` so the three approval meanings stay distinct.
- V1 uses shared text commands on both channels. Feishu cards and Telegram inline keyboards are presentation improvements, not prerequisites for list/use closure.

## Files and responsibilities

- Modify `packages/core/src/types.ts`: define channel-facing Flow input/detail/invocation types and carry `inputs` through `ChannelSessionMessage`.
- Modify `apps/bridge/src/channel-ingress.ts`: map consume metadata, forward invocation inputs, and adapt Runtime approval reads/writes.
- Modify `apps/bridge/src/session-api.ts`: preserve `inputs` across the channel route into the existing session message/run contracts.
- Create `packages/router/src/channel-flow-controller.ts`: parse `/flow` commands, validate user inputs, hold ephemeral drafts, and emit a typed invocation only after confirmation.
- Modify `packages/router/src/index.ts` and `packages/router/src/command-help.ts`: export and document the shared controller.
- Modify `packages/channel-feishu/src/bridge.ts`: route `/flow` before Agent dispatch and submit explicit Flow invocations through the existing watcher.
- Modify `packages/channel-telegram/src/telegram-bridge.ts`: mirror Feishu behavior and register `/flow` in the Telegram native menu.
- Add/modify focused Vitest files beside each changed unit.

### Task 1: Complete the shared channel Flow contract

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `apps/bridge/src/channel-ingress.ts`
- Test: `apps/bridge/src/channel-ingress.test.ts`

- [x] **Step 1: Write failing ingress tests**

Add tests proving that `listConsumableFlows()` retains typed `inputs` and step/risk summary, `submit()` sends `inputs`, and Runtime approval resolution reads requested approvals then calls the existing approve/reject endpoint.

```ts
expect(await ingress.listConsumableFlows()).toEqual([{
  flowId: "flow_demo",
  name: "Demo",
  definitionRevision: "sha256:one",
  inputs: [{ id: "oid", type: "integer", source: "user", required: true }],
  steps: [{ id: "lookup", purpose: "查订单", mode: "read_only", approval: "none" }],
}]);

await ingress.submit({
  channel: "feishu",
  conversationId: "chat",
  message: "运行 Flow：Demo",
  flowId: "flow_demo",
  flowDefinitionRevision: "sha256:one",
  inputs: { oid: 1644460 },
});
```

- [x] **Step 2: Run the focused test and verify failure**

Run: `pnpm vitest run apps/bridge/src/channel-ingress.test.ts`

Expected: FAIL because the channel types and ingress do not yet expose metadata, inputs, or Runtime approval operations.

- [x] **Step 3: Add minimal typed contracts and ingress mapping**

Introduce `ChannelFlowInput`, `ChannelFlowStep`, `ChannelConsumableFlow`, `ChannelFlowInvocation`, and `ChannelRuntimeApproval`. Extend `ChannelSessionMessage` with `inputs?: Record<string, unknown>` and `ChannelSessionIngress` with:

```ts
listConsumableFlows(): Promise<ChannelConsumableFlow[]>;
listRuntimeApprovals(runId: string): Promise<ChannelRuntimeApproval[]>;
resolveRuntimeApproval(
  runId: string,
  approvalId: string,
  decision: "approve" | "reject",
): Promise<ChannelRuntimeApproval>;
```

Map only the existing consume endpoint, send `inputs` only when present, and call the existing `/v1/runs/:run_id/approvals`, `/approve`, and `/reject` contracts. Keep the new approval methods optional on `ChannelSessionIngress` so existing channel test doubles remain source-compatible while the active Bridge ingress supplies the complete implementation.

- [x] **Step 4: Run the focused test and typecheck affected packages**

Run: `pnpm vitest run apps/bridge/src/channel-ingress.test.ts && pnpm --filter @codebridge/core build && pnpm --filter @codebridge/bridge build`

Expected: PASS.

### Task 2: Preserve invocation inputs through the channel API

**Files:**
- Modify: `apps/bridge/src/session-api.ts`
- Test: `apps/bridge/src/session-api.test.ts`

- [x] **Step 1: Write a failing channel-route test**

Post an explicit Feishu invocation with `inputs: { oid: 1644460 }` to `/v1/channels/feishu/conversations/chat/messages` and assert the Runbook receives the value and emits a confirmed `PARAM_RESOLVED` event.

- [x] **Step 2: Run the focused test and verify failure**

Run: `pnpm vitest run apps/bridge/src/session-api.test.ts -t "forwards channel Flow inputs"`

Expected: FAIL with `missing_inputs`, because the channel route currently drops `body.inputs`.

- [x] **Step 3: Forward the existing input object without interpreting it**

Add `inputs: inputRecord(body.inputs)` to both child request bodies made by the channel route. Do not validate Flow input semantics in the channel route; the existing session Runtime remains authoritative.

- [x] **Step 4: Run the focused and Runtime regression tests**

Run: `pnpm vitest run apps/bridge/src/session-api.test.ts apps/bridge/src/session-runtime-api.test.ts`

Expected: PASS.

### Task 3: Build the shared `/flow` interaction controller

**Files:**
- Create: `packages/router/src/channel-flow-controller.ts`
- Create: `packages/router/src/channel-flow-controller.test.ts`
- Modify: `packages/router/src/index.ts`
- Modify: `packages/router/src/command-help.ts`
- Test: `packages/router/src/slash-commands.test.ts`

- [x] **Step 1: Write failing table-driven controller tests**

Cover these commands and terminal values:

```text
/flow                         -> numbered consumable list
/flow 1                       -> selected detail + required parameters
/flow set oid=1644460         -> typed integer stored
/flow set env=production      -> enum validated
/flow run                     -> confirmation summary, no invocation
/flow confirm                 -> invocation { flowId, definitionRevision, inputs }
/flow cancel                  -> draft cleared
/flow approve                 -> latest requested Runtime approval granted
/flow reject                  -> latest requested Runtime approval rejected
```

Also cover unknown Flow, missing required input, invalid integer/enum/pattern, stale revision after refreshing the consume list, confirmation without selection, duplicate confirmation, and independent state for two users in one group.

- [x] **Step 2: Run the new test and verify failure**

Run: `pnpm vitest run packages/router/src/channel-flow-controller.test.ts`

Expected: FAIL because the controller does not exist.

- [x] **Step 3: Implement the minimal transport-neutral controller**

Implement:

```ts
export type ChannelFlowCommandResult =
  | { type: "reply"; text: string }
  | { type: "invoke"; flow: ChannelConsumableFlow; inputs: Record<string, unknown>; idempotencyKey: string };

export class ChannelFlowController {
  async handle(input: {
    scopeKey: string;
    text: string;
    listFlows(): Promise<ChannelConsumableFlow[]>;
    getActiveRunId(): Promise<string | null>;
    listApprovals(runId: string): Promise<ChannelRuntimeApproval[]>;
    resolveApproval(runId: string, approvalId: string, decision: "approve" | "reject"): Promise<ChannelRuntimeApproval>;
  }): Promise<ChannelFlowCommandResult | null>;
}
```

Only required `source === "user"` inputs block confirmation. Coerce integers, validate enum membership and string patterns, preserve strings/directory/secret refs as text, and require a second `/flow confirm` step. Generate one stable idempotency key per selected draft. Keep the confirmed draft so a repeated `/flow confirm` retries with the same key and cannot create a second Run; replace it only on a new selection or `/flow cancel`.

- [x] **Step 4: Export the controller and update command help**

Add a “Flow” help group containing list/select/set/run/confirm/cancel/approve/reject commands. Keep `/approve` and `/deny` descriptions explicitly labeled as Agent permission.

- [x] **Step 5: Run router tests and build**

Run: `pnpm vitest run packages/router/src/channel-flow-controller.test.ts packages/router/src/slash-commands.test.ts && pnpm --filter @codebridge/router build`

Expected: PASS.

### Task 4: Wire Feishu to direct Flow invocation

**Files:**
- Modify: `packages/channel-feishu/src/bridge.ts`
- Test: `packages/channel-feishu/src/bridge-stream.test.ts`

- [x] **Step 1: Write failing Feishu surface tests**

Prove `/flow` replies with the consume list without calling Agent, `/flow confirm` calls `sessionIngress.submit()` once with explicit Flow identity and inputs, the submitted message uses the original Feishu message as reply anchor, and watcher registration is identical to a normal dispatched Run.

- [x] **Step 2: Run the focused tests and verify failure**

Run: `pnpm vitest run packages/channel-feishu/src/bridge-stream.test.ts -t "Flow"`

Expected: FAIL because Feishu currently sends unknown `/flow` text to Agent.

- [x] **Step 3: Add the controller and an explicit invocation path**

Create one `ChannelFlowController` per `FeishuBridge`. Before generic slash handling, call it with `scopeKey = feishu|chat|topic|sender`. For `reply`, send Markdown. For `invoke`, call the existing submit/watcher path with:

```ts
{
  flowId: result.flow.flowId,
  flowDefinitionRevision: result.flow.definitionRevision,
  inputs: result.inputs,
  idempotencyKey: result.idempotencyKey,
}
```

Do not append Agent output-style or mention guidance to a Flow invocation.

- [x] **Step 4: Run Feishu tests and build**

Run: `pnpm vitest run packages/channel-feishu/src/bridge-stream.test.ts packages/channel-feishu/src/bridge-lifecycle.test.ts && pnpm --filter @codebridge/channel-feishu build`

Expected: PASS.

### Task 5: Wire Telegram to the same direct invocation

**Files:**
- Modify: `packages/channel-telegram/src/telegram-bridge.ts`
- Test: `packages/channel-telegram/src/telegram-bridge.test.ts`

- [x] **Step 1: Write failing Telegram surface tests**

Prove `/flow` is registered as a native command, list/select/set/run/confirm are rendered as plain text, confirmation submits the same explicit identity and inputs, no Agent prompt is generated, and topic/user state does not leak.

- [x] **Step 2: Run the focused test and verify failure**

Run: `pnpm vitest run packages/channel-telegram/src/telegram-bridge.test.ts -t "Flow"`

Expected: FAIL because Telegram has no Flow command wiring.

- [x] **Step 3: Mirror the Feishu adapter**

Register `{ command: "flow", description: "列出或运行已发布 Flow" }`, call the same controller with `scopeKey = telegram|chat|topic|sender`, and pass explicit Flow identity/inputs/idempotency through the existing session watcher path.

- [x] **Step 4: Run Telegram tests and build**

Run: `pnpm vitest run packages/channel-telegram/src/telegram-bridge.test.ts packages/channel-telegram/src/telegram-session-watcher.test.ts && pnpm --filter @codebridge/channel-telegram build`

Expected: PASS.

### Task 6: Adversarial closure and Surface Matrix

**Files:**
- Modify: `docs/superpowers/plans/2026-08-21-flow-p1a-channel-consumption.md`

- [x] **Step 1: Run adversarial contract tests**

Verify: Guide/Candidate never appear; missing or stale revision never executes; omitted historical channel binding never executes; malformed input never reaches Runtime; repeated confirm cannot create two Runs; Agent `/approve` cannot resolve Runtime approval; one channel/user cannot use another's draft.

Run: `pnpm vitest run apps/bridge/src/channel-ingress.test.ts apps/bridge/src/session-api.test.ts packages/router/src/channel-flow-controller.test.ts packages/channel-feishu/src/bridge-stream.test.ts packages/channel-telegram/src/telegram-bridge.test.ts`

Expected: PASS.

- [x] **Step 2: Run repository verification**

Run: `pnpm test && pnpm lint && pnpm build`

Expected: all commands exit 0.

- [x] **Step 3: Record the completion Surface Matrix**

Append a matrix for Web, Agent, Feishu, and Telegram covering entry, read path, write path, event consumption, errors, recovery, terminal feedback, and planned landing. Web must remain reachable for consume/bind/run and Runtime approval; Agent remains outside Flow execution; Feishu and Telegram must be closed-loop for text-command list/use.

- [x] **Step 4: Run GitNexus change detection before commit**

Run: `npx gitnexus detect-changes --repo CodeBridge --scope staged`

Expected: only channel Flow contracts, router interaction, Bridge channel forwarding, and Feishu/Telegram active surfaces are affected.

- [x] **Step 5: Commit the P1A slice**

```bash
git add packages/core/src/types.ts apps/bridge/src/channel-ingress.ts apps/bridge/src/channel-ingress.test.ts apps/bridge/src/session-api.ts apps/bridge/src/session-api.test.ts packages/router/src/channel-flow-controller.ts packages/router/src/channel-flow-controller.test.ts packages/router/src/index.ts packages/router/src/command-help.ts packages/router/src/slash-commands.test.ts packages/channel-feishu/src/bridge.ts packages/channel-feishu/src/bridge-stream.test.ts packages/channel-telegram/src/telegram-bridge.ts packages/channel-telegram/src/telegram-bridge.test.ts docs/superpowers/plans/2026-08-21-flow-p1a-channel-consumption.md
git commit -m "feat(flow): add three-channel P1A consumption"
```

Do not stage the user-owned `AGENTS.md` index-count change or unrelated untracked files.

## Completion Surface Matrix (2026-08-21)

| Surface | Entry | Read path | Write path | Event consumption | Error handling / recovery | Terminal feedback | Four-state result | Planned landing |
|---|---|---|---|---|---|---|---|---|
| Web | Active Flow sidebar, Composer, Runtime approval card | `view=consume` for use; `view=manage` for control-plane visibility | Existing one-shot `/messages`, `apply`/`unbind`, Runtime `/approve`/`reject` | Session SSE → active timeline blocks | Revision mismatch, unbind/rebind, expired approval state | Timeline result, artifact, verification, approval terminal state | implemented + reachable + closed-loop | P1B: Run → Candidate → Definition Review management loop |
| Agent | Ordinary chat only; no Flow consumption entry | None by design | Cannot write Catalog, review, bind, approve, or execute as Runtime | Agent events may be rendered beside Flow events but do not own Flow state | Unknown `/flow` is intercepted; Guide/non-consumable state cannot fall back to Agent | Normal Agent final answer only | implemented guard; Flow closed-loop is not a target | P2 may suggest a Flow, still requiring human confirmation and Bridge write APIs |
| Feishu | `/flow`, `/flow search`, select/set/run/confirm; `/stop`; `/flow approve|reject` | Shared ingress → `GET /v1/flows?view=consume`; Runtime approvals query | Explicit one-shot `flow_id + definition_revision + inputs`; cancel and existing Runtime approval endpoints | Persistent Session watcher consumes structured Runtime events | Local input validation, stale revision reselect, stable retry key, watcher delivery recovery | Live Flow progress, approval command guidance, final result/artifact/verification | implemented + reachable + closed-loop for text-command V1 | Presentation-only cards/buttons may be added without duplicating Flow rules |
| Telegram | Native `/flow` plus same text command sequence; `/stop`; `/flow approve|reject` | Same shared ingress consume and approval queries | Same explicit one-shot invocation/cancel/approval contracts | Persistent Telegram Session watcher consumes the same structured events | Same validation/revision/idempotency rules; delivery recovery | Edited live status, approval command guidance, final result/artifact/verification | implemented + reachable + closed-loop for text-command V1 | Inline keyboards may be added as a transport adapter only |

Fresh verification evidence before commit:

- `pnpm test`: 117 files, 1056 tests passed.
- `pnpm lint`: exit 0; five pre-existing React hook warnings, zero errors.
- `pnpm build`: all workspace packages built successfully.
- Focused P1A matrix: 118 tests passed across Bridge ingress/session, router controller, Feishu, and Telegram.

## Self-review

- Spec coverage: P1A covers three-channel consumption, explicit revision, parameter collection, confirmation, cancellation, Runtime step approval, and existing structured result watchers. Run-to-Candidate and Definition Review remain P1B Web control-plane work.
- Placeholder scan: no implementation step depends on an unspecified endpoint or invented lifecycle operation.
- Type consistency: the controller, ingress, and both channel adapters use the same `ChannelConsumableFlow`, `ChannelRuntimeApproval`, invocation input, and idempotency types.
- Deliberate exclusions: no Session binding from channels, no Guide execution, no Flow ACL, no Agent catalog writes, no Feishu/Telegram management logic, no automatic discovery, and no card/inline-keyboard dependency.
