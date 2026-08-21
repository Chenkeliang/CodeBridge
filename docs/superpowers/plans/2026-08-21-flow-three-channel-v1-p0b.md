# Flow 三表面 V1 P0B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **执行要求：** 每个任务先写失败测试，再做最小实现。修改已有函数、类或方法前必须重新执行 GitNexus upstream impact；`projectSessionEvent` 和 `FeishuSessionWatcher` 已知为 CRITICAL，`TelegramSessionWatcher` 已知为 HIGH，必须先向用户报告影响面。提交前必须运行 `gitnexus_detect_changes()`。

**Goal:** 让 Web、飞书和 Telegram 从同一 Bridge 领域事件得到 Runbook 的结构化进度、审批状态和最终结果，并在当前 Web Workbench 中闭合 Runtime Step Approval。

**Architecture:** Bridge/Runtime 事件仍是唯一事实源。Channel Ingress 先把生产 SSE DTO 规范化，再由 router 中的纯 `ChannelFlowProjector` 生成通道无关 snapshot；飞书和 Telegram 只负责把 snapshot 合成到现有单卡片/单消息。Web 通过 Session projector 和当前 `SessionTimeline` 展示 Runtime approval，并只调用现有 approve/reject API。

**Tech Stack:** TypeScript、Hono SSE、SQLite Session Projection、React、Vitest、Feishu Card Streaming、Telegram Bot API。

**Design source:** [2026-08-21-flow-p0b-structured-return-design.md](../specs/2026-08-21-flow-p0b-structured-return-design.md)

---

## 0. 范围、风险和 Surface Matrix

### 本计划包含

1. 修复 Channel Ingress 对生产 SSE snake_case 的转换，并保留 artifact `result_ref`。
2. 新增通道无关 Flow event projector。
3. Web Timeline 投影 approval requested/granted/rejected。
4. 当前 Workbench 中的 Runtime approval 卡片和现有 approve/reject API 接入。
5. 飞书/Telegram 单表面中的 Step、Artifact、Verification、Approval、Run snapshot。
6. 重放、恢复、重复事件和终态交付测试。

### 本计划不包含

- 新 approval endpoint 或 ApprovalService 规则变更；
- 飞书/Telegram 内审批按钮或命令；
- Flow Definition Review；
- Flow 列表、补参和确认卡；
- Agent Permission 产品改造。

### 已知影响门

| Symbol | Risk | 受影响流程 | 实施门禁 |
| --- | --- | --- | --- |
| `projectSessionEvent` | CRITICAL | executePlan、createWorkItemApp、succeed/fail、appendEvent、projection backfill | work-items projector 全量 + Session API 回放测试 |
| `FeishuSessionWatcher` | CRITICAL | connect、dispatchToAgent、recoverDeliveries、submitAndStream | 飞书 watcher、恢复投递、卡片合并写测试 |
| `TelegramSessionWatcher` | HIGH | connect、poll、submitAndStream、recoverDeliveries | Telegram watcher、polling、恢复投递测试 |
| `SessionTimeline` | LOW | 当前 Web Timeline 渲染 | Timeline 组件活跃表面测试 |
| `Workbench` | LOW | Web App | API action + Session refresh 回归 |

### Surface Matrix

| Surface | entry | read path | write path | events | error/recovery | terminal feedback | planned 落点 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Web | 当前 `SessionTimeline` | Session snapshot | existing approve/reject | approval requested/granted/rejected | API error + refresh + SSE | approval 与 Run 终态 | Task 3–4 |
| Agent | existing Agent stream | `AGENT_EVENT` | existing permission path | 不接管 Runtime approval | 维持现状 | 维持现状 | 明确非目标 |
| 飞书 | 当前 Run 卡片 | normalized channel events | P0B 无 approval write | Flow structured events | cursor replay + delivery recovery | 原卡片 final summary | Task 1–2、5 |
| Telegram | 当前 Run 消息 | normalized channel events | P0B 无 approval write | Flow structured events | cursor replay + delivery recovery | 原消息 final summary | Task 1–2、6 |

飞书/Telegram 的“请前往 Web”文案只能与 Task 3–4 同一交付批次上线。

---

## 1. 规范化 Channel Session Event 合同

**Files:**

- Modify: `packages/core/src/types.ts`
- Modify: `apps/bridge/src/channel-ingress.ts`
- Modify: `apps/bridge/src/channel-ingress.test.ts`

### Task 1.1：先用生产 SSE 字段写失败测试

- [ ] 对 `ChannelSessionEvent`、`createChannelSessionIngress` 和内部 `events` 运行 upstream impact。
- [ ] 把现有 camelCase SSE fixture 改成生产格式，并断言所有结构化字段被保留：

```ts
return sse([
  JSON.stringify({
    type: "ARTIFACT_CREATED",
    sequence: 4,
    run_id: "run_1",
    occurred_at: "2026-08-21T10:00:00.000Z",
    target: "artifact_1",
    result_ref: "artifact://artifact_1",
    payload: {
      artifact_id: "artifact_1",
      step_id: "deploy",
      name: "deploy.output.json",
      mime_type: "application/json",
    },
  }),
]);
```

- [ ] 期望：

```ts
expect(events[0]).toEqual({
  type: "ARTIFACT_CREATED",
  sequence: 4,
  runId: "run_1",
  occurredAt: "2026-08-21T10:00:00.000Z",
  target: "artifact_1",
  resultRef: "artifact://artifact_1",
  payload: expect.objectContaining({ artifact_id: "artifact_1" }),
});
```

- [ ] 运行并确认旧实现失败：

```bash
pnpm vitest run apps/bridge/src/channel-ingress.test.ts
```

Expected: `runId` 为 null 或 `resultRef/occurredAt` 缺失。

### Task 1.2：实现显式 DTO 转换

- [ ] 扩展共享类型：

```ts
export interface ChannelSessionEvent {
  type: string;
  sequence: number;
  runId: string | null;
  occurredAt: string | null;
  target: string | null;
  resultRef: string | null;
  payload: Record<string, unknown>;
}
```

- [ ] 将 ingress 内部 wire type 和转换固定为：

```ts
interface SessionEventWire {
  type?: string;
  sequence?: number;
  run_id?: string | null;
  occurred_at?: string | null;
  target?: string | null;
  result_ref?: string | null;
  payload?: Record<string, unknown>;
}

function toChannelSessionEvent(event: SessionEventWire): ChannelSessionEvent {
  return {
    type: String(event.type ?? ""),
    sequence: Number(event.sequence ?? 0),
    runId: typeof event.run_id === "string" ? event.run_id : null,
    occurredAt: typeof event.occurred_at === "string" ? event.occurred_at : null,
    target: typeof event.target === "string" ? event.target : null,
    resultRef: typeof event.result_ref === "string" ? event.result_ref : null,
    payload: event.payload ?? {},
  };
}
```

- [ ] `readSessionEvents` 返回 wire DTO；`events` 只通过 `toChannelSessionEvent` 暴露共享类型。
- [ ] 删除测试中的 camelCase wire fixture，避免再次掩盖生产合同。
- [ ] 运行：

```bash
pnpm vitest run apps/bridge/src/channel-ingress.test.ts
```

Expected: PASS。

---

## 2. 新增共享 Channel Flow Projector

**Files:**

- Create: `packages/router/src/channel-flow-projector.ts`
- Create: `packages/router/src/channel-flow-projector.test.ts`
- Modify: `packages/router/src/index.ts`

### Task 2.1：用表驱动测试固定事件语义

- [ ] 测试以下事件序列：

```ts
const events: ChannelSessionEvent[] = [
  event("STEP_STARTED", "deploy", { capability_id: "deploy.production" }),
  event("STEP_RETRYING", "deploy", { attempt: 2, error: "timeout" }),
  event("STEP_SUCCEEDED", "deploy", {}),
  event("ARTIFACT_CREATED", "artifact_1", {
    artifact_id: "artifact_1",
    step_id: "deploy",
    name: "deploy.output.json",
    mime_type: "application/json",
  }, "artifact://artifact_1"),
  event("RUN_SNAPSHOT", "run_1", {
    flow_id: "flow_deploy",
    flow_revision: "sha256:rev",
    outcome: "succeeded",
    steps: [{
      step_id: "deploy",
      capability_id: "deploy.production",
      output_ref: "artifact://artifact_1",
      verification_status: "passed",
    }],
  }),
];
```

- [ ] 断言同一 Step/Artifact 被重复 apply 后数组长度仍为 1。
- [ ] 分别测试 `VERIFICATION_FAILED`、`APPROVAL_REQUESTED/GRANTED/REJECTED` 和 `STEP_SKIPPED/FAILED`。
- [ ] 测试未知事件是显式 no-op，不能清空已投影状态。
- [ ] 运行并确认失败：

```bash
pnpm vitest run packages/router/src/channel-flow-projector.test.ts
```

### Task 2.2：实现纯投影和紧凑文本

- [ ] 导出：

```ts
export interface ChannelFlowProjector {
  apply(event: ChannelSessionEvent): ChannelFlowSnapshot;
  snapshot(): ChannelFlowSnapshot;
}

export function createChannelFlowProjector(): ChannelFlowProjector;
export function renderChannelFlowLive(snapshot: ChannelFlowSnapshot): string;
export function renderChannelFlowFinal(snapshot: ChannelFlowSnapshot): string;
```

- [ ] 内部使用 `Map<stepId, StepState>`、`Map<artifactId, ArtifactState>` 和 `Map<approvalId, ApprovalState>`；snapshot 时复制为数组，禁止返回可变 Map。
- [ ] `RUN_SNAPSHOT` 通过 stepId merge output ref/verification，不替换已经记录的 error。
- [ ] `APPROVAL_REQUESTED` 从 payload 读取 `approval_id/step_id/expires_at`，capability 使用 `event.target`；GRANTED/REJECTED 用 approvalId 更新同一记录。
- [ ] live 文本最多展示当前步骤和最近四个步骤；final 文本展示 Flow/revision、通过数、验证失败和 artifact name/ref。
- [ ] 运行：

```bash
pnpm vitest run packages/router/src/channel-flow-projector.test.ts
```

Expected: PASS。

---

## 3. 让 Session Projection 闭合 Runtime Approval 状态

**Files:**

- Modify: `packages/work-items/src/session-projector.ts`
- Modify: `packages/work-items/src/session-projector.test.ts`
- Modify: relevant projection/backfill tests under `packages/work-items/src`

### Task 3.1：先写 requested → granted/rejected 回放测试

- [ ] 重新运行 `projectSessionEvent` upstream impact并报告 CRITICAL 影响面。
- [ ] 写测试：同一 Run append `APPROVAL_REQUESTED` 后产生一个 `kind=approval,status=waiting` block，metadata 包含 approval ID、step、environment、target 和 expires。
- [ ] append `APPROVAL_GRANTED` 后仍只有一个 block，status 为 `granted`；另一个测试对 `APPROVAL_REJECTED` 断言 `rejected`。
- [ ] 写兼容测试：数据库先存在旧 key `approval:${capabilityId}`，结果事件能更新旧 block，不创建第二张卡。
- [ ] 运行并确认失败：

```bash
pnpm vitest run packages/work-items/src/session-projector.test.ts
```

### Task 3.2：实现稳定 block key 和终态更新

- [ ] 增加纯 helper：

```ts
function approvalIdOf(event: DomainEvent): string {
  const id = asRecord(event.payload).approval_id;
  if (typeof id !== "string" || !id) {
    throw new Error(`Approval event missing approval_id: ${event.eventId}`);
  }
  return id;
}

function approvalBlockId(event: DomainEvent): string {
  return `approval:${approvalIdOf(event)}`;
}
```

- [ ] REQUESTED 使用新 key 并把 `capability_id: event.target` 合入 metadata。
- [ ] 新增 `updateApprovalBlock(database, event, status)`：先按新 key 更新；若未命中，再按旧 key `approval:${event.target}` 更新。更新 metadata 中的 resolved_at、granted_by/rejected_by，但保留 request metadata。
- [ ] 将 `APPROVAL_GRANTED/REJECTED` 从 no-op 列表移入显式 case。
- [ ] 不修改 ApprovalService、approve/reject API 或 RunExecutor。
- [ ] 运行高风险回归：

```bash
pnpm vitest run \
  packages/work-items/src/session-projector.test.ts \
  packages/work-items/src/session-runtime.test.ts \
  apps/bridge/src/session-api.test.ts \
  apps/bridge/src/work-item-api.test.ts
```

Expected: PASS。

---

## 4. 在当前 Web Workbench 挂载 Runtime Approval

**Files:**

- Create: `apps/web/src/components/runtime-approval-card.tsx`
- Create: `apps/web/src/components/runtime-approval-card.test.tsx`
- Modify: `apps/web/src/components/session-timeline.tsx`
- Modify: `apps/web/src/components/session-timeline.test.tsx`
- Modify: `apps/web/src/components/workbench.tsx`
- Modify: `apps/web/src/lib/api.test.ts`
- Modify: `apps/web/src/components/workbench-component-policy.test.ts`

### Task 4.1：先写活跃表面失败测试

- [ ] 对 `SessionTimeline` 和 `Workbench` 重新运行 upstream impact。
- [ ] 确认 `apps/web/src/lib/types.ts` 的 `TimelineBlockView.kind` 已包含 `"approval"`；本任务不得重复扩展或重定义该联合类型。若编译失败，先核实 active type import，不能据此新增第二套 Timeline 类型。
- [ ] 构造当前 Timeline turn：

```ts
const approvalBlock: TimelineBlockView = {
  block_id: "approval:approval_1",
  block_index: 2,
  kind: "approval",
  status: "waiting",
  metadata: {
    approval_id: "approval_1",
    step_id: "deploy",
    capability_id: "deploy.production",
    environment: "production",
    target_resource: "service/demo",
    expires_at: "2026-08-21T12:00:00.000Z",
  },
  segments: [],
  next_segment_cursor: null,
};
```

- [ ] `SessionTimeline` 活跃表面测试断言可见“Runtime 步骤需要审批”“允许一次”“拒绝并停止”，并断言点击回调收到 `{ runId: "run_1", approvalId: "approval_1" }`。
- [ ] rerender status `granted/rejected`，断言按钮消失并显示终态；传入 effective status `expired` 时显示“审批已过期”且没有操作按钮。
- [ ] 运行并确认当前实现不渲染 approval：

```bash
pnpm vitest run apps/web/src/components/session-timeline.test.tsx
```

### Task 4.2：实现专用卡片并接入 Timeline

- [ ] 新组件接口固定为：

```ts
export type RuntimeApprovalAction = {
  runId: string;
  approvalId: string;
};

export function RuntimeApprovalCard(props: {
  runId: string;
  block: TimelineBlockView;
  effectiveStatus?: "requested" | "granted" | "rejected" | "expired";
  busy: boolean;
  onResolve: (action: RuntimeApprovalAction, approve: boolean) => void;
}): JSX.Element;
```

- [ ] metadata 缺少 `approval_id` 时渲染不可操作错误卡，不回退到 Agent permission，也不猜测 ID。
- [ ] `SessionTimeline` 增加：

```ts
resolvingApprovalId: string | null;
onResolveApproval: (action: RuntimeApprovalAction, approve: boolean) => void;
```

- [ ] 在 `TimelineBlock` 的 `kind === "approval"` 分支直接渲染新卡片；必须把当前 `turn.run_id` 传入，不能把 approval 放入折叠的 ProcessBlock。
- [ ] Timeline 持久状态使用 block status；`effectiveStatus` 只用于服务端 approval record 已显示 `expired`、但尚无对应领域事件的只读覆盖。override 不得写回 Timeline 或伪造 approval 事件。
- [ ] 不把旧 `conversation.tsx` 的 dormant `ApprovalCard` 当作验收入口。

### Task 4.3：Workbench 只调用现有写 API，并查询 expired 状态

- [ ] 在 Workbench 增加 `resolvingApprovalId` 和 `approvalStatusOverrides` state。当前 Timeline 出现 waiting approval 时，用现有 `api.approvals(runId)` 获取对应 record；仅把 `expired` 保存为 UI override，requested/granted/revoked 仍以领域事件投影为主。
- [ ] approval action 固定为：

```ts
async function resolveRuntimeApproval(
  action: RuntimeApprovalAction,
  approve: boolean,
): Promise<void> {
  if (!selectedSessionId || resolvingApprovalId) return;
  setResolvingApprovalId(action.approvalId);
  try {
    if (approve) await api.approve(action.runId, action.approvalId);
    else await api.reject(action.runId, action.approvalId);
    await sessionConnection.refresh(selectedSessionId);
  } catch (caught) {
    await sessionConnection.refresh(selectedSessionId).catch(() => {});
    const records = await api.approvals(action.runId).catch(() => []);
    const current = records.find((record) => record.id === action.approvalId);
    if (current?.status === "expired") {
      setApprovalStatusOverrides((value) => ({
        ...value,
        [action.approvalId]: "expired",
      }));
    }
    notify(messageOf(caught), "error");
  } finally {
    setResolvingApprovalId(null);
  }
}
```

- [ ] 将函数、busy ID 和 expired overrides 传给当前 `<SessionTimeline>`；切换 Session 时清空 overrides，再按新 Timeline 的 waiting blocks 查询。
- [ ] 测试 approve/reject URL 和 body 仍是现有合同；P0B 不新增 endpoint。
- [ ] 测试 API 409 且 `GET approvals` 返回 expired 时会 refresh、显示“审批已过期”并保持按钮禁用；不会自动重试。若查询仍为 requested，只显示服务端错误并恢复按钮。
- [ ] 运行：

```bash
pnpm vitest run \
  apps/web/src/components/runtime-approval-card.test.tsx \
  apps/web/src/components/session-timeline.test.tsx \
  apps/web/src/lib/api.test.ts \
  apps/web/src/components/workbench-component-policy.test.ts
```

Expected: PASS。

---

## 5. 飞书单卡片结构化回流

**Files:**

- Modify: `packages/channel-feishu/src/session-watcher.ts`
- Modify: `packages/channel-feishu/src/session-watcher.test.ts`

### Task 5.1：写事件与恢复失败测试

- [ ] 重新运行 `FeishuSessionWatcher` 和 `FeishuRunCard` upstream impact，报告 CRITICAL 影响面。
- [ ] 测试一个 Run 依次收到 STEP_STARTED、APPROVAL_REQUESTED、APPROVAL_GRANTED、STEP_SUCCEEDED、ARTIFACT_CREATED、RUN_SNAPSHOT、RUN_SUCCEEDED。
- [ ] 断言：
  - 使用同一张卡片更新；
  - 等待态出现“请在 Web 打开当前 Session 完成审批”；
  - granted 更新原卡片，不发送通道审批按钮；
  - final 同时保留 Agent final text 和 Flow snapshot；
  - Artifact 名称与 `artifact://` ref 可见；
  - delivery 在 final 卡片 flush 后完成。
- [ ] 对 `resumeCardForRun` 重放相同事件两次，断言 Step/Artifact/Approval 只出现一次。
- [ ] 运行并确认失败：

```bash
pnpm vitest run packages/channel-feishu/src/session-watcher.test.ts
```

### Task 5.2：把 Flow projector 合成到现有卡片

- [ ] `FeishuRunCard` 和 resumed card state 各持有一个 `ChannelFlowProjector`。
- [ ] 增加 `onDomainEvent(event)`：仅将受支持结构化事件交给 Flow projector，然后进入现有 `CoalescingCardWriter`；不要直接调用飞书 I/O。
- [ ] 统一合成函数：

```ts
function composeFeishuRunBody(
  agentText: string,
  flowText: string,
): string {
  return [agentText || undefined, flowText || undefined]
    .filter((value): value is string => Boolean(value))
    .join("\n\n---\n\n");
}
```

- [ ] watcher 在 terminal 判断前先 apply 当前结构化事件，确保 `RUN_SNAPSHOT` 已进入 final snapshot。
- [ ] `APPROVAL_REQUESTED` 只进卡片，不发送带 `/approve` 的 Runtime approval 消息。
- [ ] 保留 `AGENT_EVENT.permission_request` 的既有语义，不把它解释成 Runtime approval。
- [ ] 运行：

```bash
pnpm vitest run packages/channel-feishu/src/session-watcher.test.ts packages/channel-feishu/src
```

Expected: PASS。

---

## 6. Telegram 单消息结构化回流

**Files:**

- Create: `packages/channel-telegram/src/coalescing-message-writer.ts`
- Create: `packages/channel-telegram/src/coalescing-message-writer.test.ts`
- Modify: `packages/channel-telegram/src/telegram-session-watcher.ts`
- Modify: `packages/channel-telegram/src/telegram-session-watcher.test.ts`

### Task 6.1：先锁定单消息和限频合同

- [ ] 重新运行 `TelegramSessionWatcher` 和 `TelegramRunRenderer` upstream impact，报告 HIGH 影响面。
- [ ] 测试连续十个 Step 更新只编辑同一 pending message，合并期间不会并发调用 `editMessage`。
- [ ] 测试 approval requested/granted/rejected 更新同一消息，没有发送通道审批按钮。
- [ ] 测试 terminal flush 后，超过 Telegram 长度的 final 继续使用 `chunkTelegramText`：首块编辑原消息，其余块追加发送。
- [ ] 测试 resumeRun 重放不重复 Step/Artifact。
- [ ] 运行并确认失败：

```bash
pnpm vitest run packages/channel-telegram/src/telegram-session-watcher.test.ts
```

### Task 6.2：实现合并写和 Flow section

- [ ] `CoalescingMessageWriter` 只保留最新 snapshot，并串行执行写入：

```ts
export interface CoalescingMessageWriter<T> {
  enqueue(value: T): void;
  flush(): Promise<void>;
  close(): void;
}
```

- [ ] `TelegramRunRenderer` 增加 Flow projector；结构化事件到达时 enqueue live text，terminal 时 flush 后再完成 delivery。
- [ ] live edit 失败记录日志并保留 final fallback；不能因为一次 live edit 失败改变 Runtime 状态。
- [ ] Agent text 和 Flow text 使用与飞书相同 section 顺序；只做 Telegram Markdown/长度适配。
- [ ] 运行：

```bash
pnpm vitest run \
  packages/channel-telegram/src/coalescing-message-writer.test.ts \
  packages/channel-telegram/src/telegram-session-watcher.test.ts \
  packages/channel-telegram/src
```

Expected: PASS。

---

## 7. 集成、对抗性验证和交付

### Task 7.1：合同与活跃表面双层测试

- [ ] 合同层：

```bash
pnpm vitest run \
  apps/bridge/src/channel-ingress.test.ts \
  packages/router/src/channel-flow-projector.test.ts \
  packages/work-items/src/session-projector.test.ts \
  apps/bridge/src/work-item-api.test.ts
```

- [ ] 活跃表面层：

```bash
pnpm vitest run \
  apps/web/src/components/runtime-approval-card.test.tsx \
  apps/web/src/components/session-timeline.test.tsx \
  packages/channel-feishu/src/session-watcher.test.ts \
  packages/channel-telegram/src/telegram-session-watcher.test.ts
```

- [ ] 对抗性用例：
  - 生产 snake_case SSE，不允许 camelCase fixture；
  - 同一 sequence 重连重放；
  - 两个 step 使用同一 capability，但 approval ID 不同；
  - approval 先 requested 后 granted，再 Run succeeded；
  - approval rejected 后 Run cancelled；
  - Web approve 返回 409 expired；
  - Agent final text 为空但 Run snapshot 存在；
  - Artifact 只有 top-level `result_ref`；
  - live surface update 失败后 final retry 成功。

### Task 7.2：重新核对 Surface Matrix

- [ ] Web：用当前 Workbench 入口验证 approval card reachable，批准/拒绝后终态可见，才能标记 closed-loop。
- [ ] 飞书：用当前 watcher/恢复入口验证单卡片，不从 Web 测试推断。
- [ ] Telegram：用当前 polling/watcher/恢复入口验证单消息，不从飞书推断。
- [ ] Agent：明确记录为 P0B 非目标，不能声称 Runtime approval closed-loop。
- [ ] 若“前往 Web”提示存在而 Web 卡片测试未通过，P0B 不得交付。

### Task 7.3：全量门禁

- [ ] 运行：

```bash
pnpm test
pnpm lint
pnpm build
```

- [ ] 静态扫描：

```bash
rg 'APPROVAL_REQUESTED|APPROVAL_GRANTED|APPROVAL_REJECTED|RUN_SNAPSHOT|ARTIFACT_CREATED|VERIFICATION_FAILED' \
  packages/channel-feishu packages/channel-telegram packages/router apps/web packages/work-items
```

人工确认：两个通道调用共享 Flow projector；Web 使用当前 SessionTimeline；没有新增 approval 写入口。

- [ ] 运行 GitNexus change detection：

```bash
npx gitnexus detect-changes --repo CodeBridge --scope unstaged
```

- [ ] `git diff --check`；只暂存本计划文件，保留工作区既有未跟踪文件。

---

## 8. P0B 完成定义

- [ ] Channel Ingress 按生产 snake_case 正确保留 run ID、time 和 result ref。
- [ ] Step、Artifact、Verification、Approval、Run snapshot 只有一个共享通道投影实现。
- [ ] 当前 Web Workbench 的 Runtime approval reachable 且 closed-loop。
- [ ] expired approval 通过现有查询 API 进入只读过期态，不伪造领域事件、不继续显示可操作按钮。
- [ ] Web 只使用既有 approve/reject API；没有新写路径。
- [ ] 飞书/Telegram 只读显示 Runtime approval，不提供 P0B 通道操作。
- [ ] 飞书/Telegram 的“前往 Web”目的地已在同阶段可用。
- [ ] Agent final text 和结构化 Flow summary 不互相覆盖、不重复。
- [ ] watcher 恢复和事件重放幂等。
- [ ] Surface Matrix、合同层测试、活跃表面测试、全量测试、lint、build 和 GitNexus change detection 全部通过。
