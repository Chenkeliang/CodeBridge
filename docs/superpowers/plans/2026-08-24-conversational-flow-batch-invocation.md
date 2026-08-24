# Conversational Flow Batch Invocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 Web/飞书对话中引用 Published Runbook、交给 LLM 解析整批参数、一次确认后创建一项一个 Runtime Run，并可查看、取消、恢复和只重试失败项。

**Architecture:** `FlowBatchStore` 在 orchestration SQLite 中持久化草稿、批次和 item→Run 身份；Bridge 的 `FlowBatchService` 负责 Schema 校验、冻结 Flow snapshot、调度普通无 Session Runtime Run 和聚合状态。Agent 只提交结构化 draft，Web/飞书/Telegram 通过同一 API 和事件查看/确认，Runtime 仍是唯一执行器。

**Tech Stack:** TypeScript、Node SQLite、Hono、React 19、Vitest、现有 FlowCatalog/SqliteEventStore/RunExecutor/ChannelFlowController。

---

## 0. 实施约束与文件边界

- 不执行线上业务 API、业务 upsert 或 production capability；端到端只注册内存测试 capability。
- 每个已索引函数/类修改前运行 `npx gitnexus impact -r CodeBridge -d upstream <symbol>`；HIGH/CRITICAL 先停下汇报。
- 每个任务先写失败测试，完成后只提交本任务文件。
- 子 Run 使用现有 `WorkItem → Plan → RunExecutor`，Batch 不实现步骤执行器。
- Batch child 使用 `sessionId=null`，避免同一 Session 的单活跃 Run 约束阻止批量并发；来源 Session 通过 batch 事件和查询 API 查看结果。
- `FlowBatchStore` 与 `SqliteEventStore` 打开同一个 `orchestration.sqlite`。确认事务只冻结 batch/item 身份；调度器按预留 ID 幂等物化 WorkItem/Plan/Run，崩溃后可恢复。

文件职责：

- `packages/work-items/src/flow-batch.ts`：Batch 类型、SQLite schema、持久化和纯状态聚合。
- `apps/bridge/src/flow-batch-validation.ts`：按 FlowInput 清洗全局/逐项参数、证据和 issues。
- `apps/bridge/src/flow-batch-service.ts`：确认、物化、并发泵、取消、重试和恢复。
- `apps/bridge/src/flow-batch-api.ts`：共享 Hono API 与 wire DTO。
- `apps/web/src/components/flow-batch-panel.tsx`：批量预览和结果控制面，不把状态塞回 `workbench.tsx`。
- `packages/router/src/channel-flow-controller.ts`：通道精简确认命令；不保存领域状态。

### Task 1: Batch 领域类型、持久化和状态聚合

**Files:**
- Create: `packages/work-items/src/flow-batch.ts`
- Create: `packages/work-items/src/flow-batch.test.ts`
- Modify: `packages/work-items/src/index.ts`

- [ ] **Step 1: 写失败测试锁定持久化、幂等和聚合状态**

```ts
it("persists a ready draft and confirms it once", () => {
  const store = new FlowBatchStore(":memory:");
  const draft = store.createDraft(fixtureDraft({ status: "ready" }));
  const first = store.confirmDraft({
    draftId: draft.draftId,
    expectedRevision: draft.revision,
    idempotencyKey: "confirm-1",
    planIrHash: "sha256:plan",
    flowSnapshot: fixturePublishedFlow(),
    concurrency: 3,
  });
  const replay = store.confirmDraft({
    draftId: draft.draftId,
    expectedRevision: draft.revision,
    idempotencyKey: "confirm-1",
    planIrHash: "sha256:plan",
    flowSnapshot: fixturePublishedFlow(),
    concurrency: 3,
  });
  expect(replay.batchId).toBe(first.batchId);
  expect(store.listBatchItems(first.batchId)).toHaveLength(2);
});

it("derives partial_succeeded from child Run status", () => {
  expect(aggregateFlowBatchStatus(["succeeded", "failed"]))
    .toBe("partial_succeeded");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run packages/work-items/src/flow-batch.test.ts`

Expected: FAIL，`FlowBatchStore` 和 `aggregateFlowBatchStatus` 尚不存在。

- [ ] **Step 3: 实现独立 store 与公开类型**

公开接口必须固定为：

```ts
export type FlowBatchDraftStatus =
  | "needs_input" | "ready" | "confirmed" | "stale" | "cancelled";
export type FlowBatchStatus =
  | "queued" | "running" | "succeeded"
  | "partial_succeeded" | "failed" | "cancelled";

export class FlowBatchStore {
  constructor(databasePath: string);
  createDraft(input: CreateFlowBatchDraftInput): FlowBatchDraft;
  getDraft(draftId: string): FlowBatchDraft | undefined;
  listDraftsForSession(sessionId: string): FlowBatchDraft[];
  replaceDraft(input: ReplaceFlowBatchDraftInput): FlowBatchDraft;
  cancelDraft(draftId: string): FlowBatchDraft;
  confirmDraft(input: ConfirmFlowBatchDraftInput): FlowBatchRun;
  getBatch(batchId: string): FlowBatchRun | undefined;
  listBatchesForSession(sessionId: string): FlowBatchRun[];
  listBatchItems(batchId: string): FlowBatchItemRun[];
  markItemMaterialized(batchId: string, itemId: string): void;
  reserveRetry(input: ReserveFlowBatchRetryInput): FlowBatchItemRun[];
  requestBatchCancellation(batchId: string): FlowBatchRun;
  close(): void;
}
```

SQLite tables must include `flow_invocation_drafts`, `flow_batch_runs`, `flow_batch_items` and unique constraints on `(draft_id,idempotency_key)` and `(batch_id,item_id,attempt)`.

- [ ] **Step 4: 运行 work-items 测试**

Run: `pnpm vitest run packages/work-items/src/flow-batch.test.ts packages/work-items/src/index.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交领域持久化**

```bash
git add packages/work-items/src/flow-batch.ts packages/work-items/src/flow-batch.test.ts packages/work-items/src/index.ts
git commit -m "feat(flow): persist batch invocation state"
```

### Task 2: 服务端参数规范化与来源证据

**Files:**
- Create: `apps/bridge/src/flow-batch-validation.ts`
- Create: `apps/bridge/src/flow-batch-validation.test.ts`

- [ ] **Step 1: 写表驱动失败测试**

```ts
it.each([
  ["integer string", { oid: "1644460" }, { oid: 1644460 }, []],
  ["bad integer", { oid: "x" }, {}, ["invalid_type"]],
  ["enum", { region: "cn" }, { region: "cn" }, []],
  ["bad enum", { region: "xx" }, {}, ["invalid_value"]],
])("normalizes %s", (_name, inputs, expected, issueCodes) => {
  const result = validateFlowBatchDraft(fixtureFlow(), {
    global_inputs: {},
    items: [{ item_id: "one", inputs, evidence: {} }],
  });
  expect(result.items[0]?.inputs).toEqual(expected);
  expect(result.items[0]?.issues.map((issue) => issue.code)).toEqual(issueCodes);
});

it("blocks agent-extracted secret values", () => {
  const result = validateFlowBatchDraft(secretFlow(), {
    global_inputs: {},
    items: [{ item_id: "one", inputs: { token: "raw-secret" }, evidence: {
      token: { source: "agent_extracted", evidence_ref: "event:1", inferred: true },
    } }],
  });
  expect(result.items[0]?.inputs).not.toHaveProperty("token");
  expect(result.status).toBe("needs_input");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run apps/bridge/src/flow-batch-validation.test.ts`

Expected: FAIL，validator 尚不存在。

- [ ] **Step 3: 实现唯一校验入口**

```ts
export function validateFlowBatchDraft(
  flow: FlowRecord,
  candidate: unknown,
  limits: { maxItems: number } = { maxItems: 500 },
): ValidatedFlowBatchDraft;
```

实现 string/integer/enum/directory/secret_ref、required/default/pattern、全局值合并、逐项覆盖、未知字段丢弃、duplicate/conflict issues、evidenceRef 必填和服务端计算 `ready|needs_input`。`secret_ref` 只允许非 Agent 来源的引用字符串，所有错误返回稳定 code。

- [ ] **Step 4: 运行验证测试**

Run: `pnpm vitest run apps/bridge/src/flow-batch-validation.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交校验器**

```bash
git add apps/bridge/src/flow-batch-validation.ts apps/bridge/src/flow-batch-validation.test.ts
git commit -m "feat(flow): validate batch invocation drafts"
```

### Task 3: Batch Service、子 Run 物化和恢复

**Files:**
- Create: `apps/bridge/src/flow-batch-service.ts`
- Create: `apps/bridge/src/flow-batch-service.test.ts`
- Modify: `packages/work-items/src/index.ts`
- Modify: `apps/bridge/src/flow-compile.ts`

- [ ] **Step 1: 写失败测试验证一项一个 Run、并发和重启恢复**

```ts
it("materializes one ordinary Runtime Run per item", async () => {
  const harness = batchHarness({ concurrency: 2, itemCount: 3 });
  const batch = await harness.service.confirm(harness.readyDraft(), "confirm-1");
  expect(harness.workItems.listBatchRuns(batch.batchId)).toHaveLength(3);
  expect(harness.executor.started).toHaveLength(2);
  harness.executor.succeed(harness.executor.started[0]!);
  await harness.service.reconcile(batch.batchId);
  expect(harness.executor.started).toHaveLength(3);
});

it("does not recreate a succeeded child after restart", async () => {
  const harness = batchHarness({ concurrency: 1, itemCount: 2 });
  const batch = await harness.service.confirm(harness.readyDraft(), "confirm-1");
  harness.executor.succeed(harness.executor.started[0]!);
  const restarted = harness.restartService();
  await restarted.recover();
  expect(harness.executor.startCount(harness.executor.started[0]!)).toBe(1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run apps/bridge/src/flow-batch-service.test.ts`

Expected: FAIL，service 尚不存在。

- [ ] **Step 3: 增加幂等物化辅助方法**

`SqliteEventStore` 增加：

```ts
materializeFlowBatchRun(input: {
  workItem: CreateWorkItemInput & { id: string };
  plan: SavePlanInput;
  run: CreateRunInput & { id: string };
  resolvedInputs: Record<string, unknown>;
}): Run;
```

方法按预留 ID 检查已有 WorkItem/Plan/Run；已存在则返回同一 Run，缺失则补齐。不得创建 Session binding。

- [ ] **Step 4: 实现 service 与调度泵**

```ts
export class FlowBatchService {
  createDraft(input: CreateDraftRequest): FlowBatchDraft;
  updateDraft(input: UpdateDraftRequest): FlowBatchDraft;
  confirm(draftId: string, expectedRevision: number, key: string): Promise<FlowBatchSnapshot>;
  snapshot(batchId: string): FlowBatchSnapshot;
  cancel(batchId: string): Promise<FlowBatchSnapshot>;
  retryFailed(batchId: string, key: string): Promise<FlowBatchSnapshot>;
  reconcile(batchId: string): Promise<FlowBatchSnapshot>;
  recover(): Promise<void>;
}
```

confirm 冻结完整 Flow snapshot 和 `planIrHash`；`pump` 只启动未 materialized 且不超过 concurrency 的 item。每个 executor Promise settle 后再次 reconcile。子 WorkItem identifiers 保存 resolved inputs，plan 由冻结 snapshot 编译并为每项实例化。

- [ ] **Step 5: 实现取消、失败项重试和聚合事件**

取消未启动 item，运行中 Run 调用 `RunExecutor.cancelRunAndWait`；失败重试只 reserve 新 attempt，成功项不变。向来源 Session WorkItem 写：

```ts
"FLOW_BATCH_DRAFTED" | "FLOW_BATCH_CONFIRMED" |
"FLOW_BATCH_UPDATED" | "FLOW_BATCH_COMPLETED"
```

payload 只含 batch/draft identity、计数和状态，不复制 child logs 或 secret inputs。

- [ ] **Step 6: 运行 service 与 Runtime 回归**

Run: `pnpm vitest run apps/bridge/src/flow-batch-service.test.ts packages/run-executor/src/index.test.ts packages/work-items/src/index.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交执行服务**

```bash
git add apps/bridge/src/flow-batch-service.ts apps/bridge/src/flow-batch-service.test.ts apps/bridge/src/flow-compile.ts packages/work-items/src/index.ts
git commit -m "feat(flow): execute persistent flow batches"
```

### Task 4: 共享 Bridge API 与启动恢复

**Files:**
- Create: `apps/bridge/src/flow-batch-api.ts`
- Create: `apps/bridge/src/flow-batch-api.test.ts`
- Modify: `apps/bridge/src/cli.ts`
- Modify: `apps/bridge/src/channel-ingress.ts`

- [ ] **Step 1: 写 API 失败测试**

```ts
it("creates, edits and confirms a ready batch draft", async () => {
  const created = await app.request("/v1/flow-invocation-drafts", post({
    session_id: session.id,
    source_run_id: sourceRun.id,
    flow_id: flow.flowId,
    definition_revision: flow.definitionRevision,
    global_inputs: { region: "cn" },
    items: [{ item_id: "one", inputs: { oid: "1" }, evidence: {} }],
  }));
  expect(created.status).toBe(201);
  const draft = await created.json();
  const confirmed = await app.request(
    `/v1/flow-invocation-drafts/${draft.draft_id}/confirm`,
    post({ draft_revision: draft.revision }, { "idempotency-key": "confirm-1" }),
  );
  expect(confirmed.status).toBe(202);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run apps/bridge/src/flow-batch-api.test.ts`

Expected: FAIL，routes 尚不存在。

- [ ] **Step 3: 实现 API 和稳定错误体**

实现设计文档 §8 的 8 个 endpoint；wire 字段使用 snake_case。错误固定为 `flow_not_consumable`、`flow_revision_mismatch`、`batch_draft_not_ready`、`batch_draft_changed`、`batch_limit_exceeded`、`batch_item_invalid`、`batch_not_cancellable`、`batch_retry_empty`。

- [ ] **Step 4: 接入 CLI 与启动恢复**

使用同一 `orchestration.sqlite` 创建 `FlowBatchStore`，构造 `FlowBatchService` 和 app route；Bridge 启动后调用 `recover()`，并用现有恢复 interval 调用 `reconcileActive()`。关闭时 clear interval/close store。

- [ ] **Step 5: 扩展 channel ingress DTO**

`ChannelSessionIngress` 增加 `getFlowBatchDraft`、`confirmFlowBatchDraft`、`getFlowBatch`、`cancelFlowBatch`、`retryFailedFlowBatch`，全部调用共享 API，不实现本地状态转换。

- [ ] **Step 6: 运行 Bridge API 回归**

Run: `pnpm vitest run apps/bridge/src/flow-batch-api.test.ts apps/bridge/src/channel-ingress.test.ts apps/bridge/src/startup-surfaces.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交 API**

```bash
git add apps/bridge/src/flow-batch-api.ts apps/bridge/src/flow-batch-api.test.ts apps/bridge/src/cli.ts apps/bridge/src/channel-ingress.ts packages/core/src/types.ts
git commit -m "feat(flow): expose batch invocation API"
```

### Task 5: Agent 批量草稿命令与 Flow guidance

**Files:**
- Modify: `packages/runner-host/src/fcb-script.ts`
- Modify: `packages/runner-host/src/fcb-script.test.ts`
- Modify: `apps/bridge/src/flow-recommendation-guidance.ts`
- Modify: `apps/bridge/src/flow-recommendation-guidance.test.ts`

- [ ] **Step 1: 写失败测试锁定 batch 命令和停止规则**

```ts
it("submits a JSON batch draft file", async () => {
  const result = await runFcb(["flow", "batch", fixturePath], env);
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("/v1/flow-invocation-drafts"),
    expect.objectContaining({ method: "POST" }),
  );
  expect(result.exitCode).toBe(0);
});

it("teaches the agent to batch only after explicit Flow reference", () => {
  const text = buildFlowRecommendationGuidance([publishedFlow]);
  expect(text).toContain("fcb flow batch <draft-json-file>");
  expect(text).toContain("提交成功后停止调用业务工具");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run packages/runner-host/src/fcb-script.test.ts apps/bridge/src/flow-recommendation-guidance.test.ts`

Expected: FAIL，batch 子命令和 guidance 尚不存在。

- [ ] **Step 3: 实现文件型命令**

`fcb flow batch <draft-json-file>` 读取 JSON，强制覆盖 `source_run_id=FCB_RUN_ID`，POST 到 draft API。文件最大 2 MiB；拒绝非对象、缺 Flow identity 和超过 500 items。不得回显 secret 值。

- [ ] **Step 4: 更新 guidance**

明确单组仍 `suggest`；只有用户明确引用唯一 Flow 且提供多组输入时才 `batch`。指导 LLM 识别自然语言列表、Markdown 表格、JSON/CSV/附件，生成 evidence refs；提交后停止工具执行并等待用户确认。

- [ ] **Step 5: 运行测试并提交**

Run: `pnpm vitest run packages/runner-host/src/fcb-script.test.ts apps/bridge/src/flow-recommendation-guidance.test.ts`

```bash
git add packages/runner-host/src/fcb-script.ts packages/runner-host/src/fcb-script.test.ts apps/bridge/src/flow-recommendation-guidance.ts apps/bridge/src/flow-recommendation-guidance.test.ts
git commit -m "feat(flow): let agents propose batch invocations"
```

### Task 6: Web API、Timeline 入口和批量控制面

**Files:**
- Modify: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/api.test.ts`
- Create: `apps/web/src/components/flow-batch-panel.tsx`
- Create: `apps/web/src/components/flow-batch-panel.test.tsx`
- Modify: `apps/web/src/components/session-timeline.tsx`
- Modify: `apps/web/src/components/session-timeline.test.tsx`
- Modify: `apps/web/src/components/workbench.tsx`

- [ ] **Step 1: 写 Web API 失败测试**

```ts
it("confirms a draft with revision and idempotency key", async () => {
  await api.confirmFlowBatchDraft("draft_1", 3, "confirm-1");
  expect(fetchMock).toHaveBeenCalledWith(
    "/v1/flow-invocation-drafts/draft_1/confirm",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "idempotency-key": "confirm-1" }),
      body: JSON.stringify({ draft_revision: 3 }),
    }),
  );
});
```

- [ ] **Step 2: 写组件失败测试**

```tsx
it("shows blocking rows and disables confirmation", () => {
  render(<FlowBatchPanel draft={needsInputDraft} onConfirm={vi.fn()} />);
  expect(screen.getByText("1 项需要补充")).toBeTruthy();
  expect(screen.getByRole("button", { name: "确认并执行 2 项" }))
    .toHaveProperty("disabled", true);
});

it("offers retry failed without rerunning succeeded items", () => {
  render(<FlowBatchPanel batch={partialBatch} onRetryFailed={vi.fn()} />);
  expect(screen.getByRole("button", { name: "只重试 1 个失败项" })).toBeTruthy();
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run apps/web/src/lib/api.test.ts apps/web/src/components/flow-batch-panel.test.tsx`

Expected: FAIL，types/API/component 尚不存在。

- [ ] **Step 4: 实现 API 类型与独立面板**

面板显示 Flow/revision、全局参数、总数/有效/异常统计、逐项 inputs/evidence/issues、风险和并发。支持行编辑/排除、确认、取消、打开子 Run、只重试失败项。使用现有 Button/Input/design tokens，不建设 spreadsheet。

- [ ] **Step 5: 挂载活跃 Timeline**

`SessionTimeline` 识别 `FLOW_BATCH_DRAFTED/CONFIRMED/UPDATED/COMPLETED` 投影或 session 查询结果，渲染卡片；Workbench 只保存选中 `draftId|batchId`，动作全部调用 API 后刷新。深链支持 `?batch=<id>&session=<id>`。

- [ ] **Step 6: 运行 Web 测试与构建**

Run: `pnpm vitest run apps/web/src/lib/api.test.ts apps/web/src/components/flow-batch-panel.test.tsx apps/web/src/components/session-timeline.test.tsx && pnpm --filter @codebridge/web build`

Expected: PASS。

- [ ] **Step 7: 提交 Web 控制面**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts apps/web/src/components/flow-batch-panel.tsx apps/web/src/components/flow-batch-panel.test.tsx apps/web/src/components/session-timeline.tsx apps/web/src/components/session-timeline.test.tsx apps/web/src/components/workbench.tsx
git commit -m "feat(flow): add web batch invocation control plane"
```

### Task 7: 飞书/Telegram 共用确认与状态合同

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/router/src/channel-flow-controller.ts`
- Modify: `packages/router/src/channel-flow-controller.test.ts`
- Modify: `packages/router/src/channel-flow-projector.ts`
- Modify: `packages/router/src/channel-flow-projector.test.ts`
- Modify: `packages/channel-feishu/src/bridge.ts`
- Modify: `packages/channel-feishu/src/bridge-stream.test.ts`
- Modify: `packages/channel-telegram/src/telegram-bridge.ts`
- Modify: `packages/channel-telegram/src/telegram-bridge.test.ts`

- [ ] **Step 1: 写共享 controller 失败测试**

```ts
it("confirms a ready batch through the shared controller", async () => {
  const result = await controller.handle(context("/flow batch confirm draft_1", {
    getFlowBatchDraft: async () => readyDraft,
    confirmFlowBatchDraft: async () => queuedBatch,
  }));
  expect(result).toEqual(expect.objectContaining({
    type: "reply",
    text: expect.stringContaining("已开始批量执行 3 项"),
  }));
});
```

- [ ] **Step 2: 写 batch event 投影失败测试**

```ts
expect(projectFlowBatchEvent(batchUpdatedEvent)).toEqual({
  title: "批量执行中",
  summary: "成功 2 · 运行 1 · 失败 0 · 共 3",
  terminal: false,
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run packages/router/src/channel-flow-controller.test.ts packages/router/src/channel-flow-projector.test.ts`

Expected: FAIL，batch 命令和 projector 尚不存在。

- [ ] **Step 4: 实现精简通道合同**

支持 `/flow batch show <draft_id|batch_id>`、`/flow batch confirm <draft_id>`、`/flow batch cancel <batch_id>`、`/flow batch retry-failed <batch_id>`。复杂 issue 超过 10 项时只显示统计和 Web deep-link。controller 不缓存 draft/batch。

- [ ] **Step 5: 接入飞书与 Telegram 活跃路由**

两端只把 ingress 方法传给共享 controller，并用现有 writer 渲染 reply；Watcher/Projector 消费 batch 事件显示聚合状态。Telegram 配置不改为 enabled。

- [ ] **Step 6: 运行两端测试**

Run: `pnpm vitest run packages/router/src/channel-flow-controller.test.ts packages/router/src/channel-flow-projector.test.ts packages/channel-feishu/src/bridge-stream.test.ts packages/channel-feishu/src/session-watcher.test.ts packages/channel-telegram/src/telegram-bridge.test.ts packages/channel-telegram/src/telegram-session-watcher.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交通道适配**

```bash
git add packages/core/src/types.ts packages/router/src/channel-flow-controller.ts packages/router/src/channel-flow-controller.test.ts packages/router/src/channel-flow-projector.ts packages/router/src/channel-flow-projector.test.ts packages/channel-feishu/src/bridge.ts packages/channel-feishu/src/bridge-stream.test.ts packages/channel-telegram/src/telegram-bridge.ts packages/channel-telegram/src/telegram-bridge.test.ts
git commit -m "feat(flow): expose batch invocation to channels"
```

### Task 8: 对抗、重启恢复和端到端验收

**Files:**
- Create: `apps/bridge/src/flow-batch-goal-validation.test.ts`
- Modify: `docs/superpowers/specs/2026-08-21-conversational-flow-batch-invocation-design.md`

- [ ] **Step 1: 写目标级验证**

测试必须以一个参数化 Published Runbook 和内存 capability 覆盖：

```ts
it("completes conversational batch Flow without online writes", async () => {
  const draft = await submitAgentDraft(naturalLanguageFixtureWithThreeRows);
  expect(draft.status).toBe("ready");
  const batch = await confirmOnce(draft);
  await settleBatch(batch.batch_id);
  expect(await snapshot(batch.batch_id)).toMatchObject({
    status: "partial_succeeded",
    counts: { succeeded: 2, failed: 1, total: 3 },
  });
  const retried = await retryFailed(batch.batch_id);
  await settleBatch(retried.batch_id);
  expect(testCapability.callsFor("item-success-1")).toBe(1);
  expect(testCapability.callsFor("item-success-2")).toBe(1);
  expect(testCapability.callsFor("item-failed-then-ok")).toBe(2);
});
```

另覆盖 stale revision、确认重复、500 项上限、secret 遮罩、取消、进程重建后的 `recover()`、CSV/JSON/Markdown/附件 evidence fixture。

- [ ] **Step 2: 运行目标测试确认完整合同通过**

Run: `pnpm vitest run apps/bridge/src/flow-batch-goal-validation.test.ts`

Expected: PASS，且测试 capability 明确断言没有外部 HTTP/数据库业务写入；任一断言失败都保持本任务未完成，不进入活跃表面验收。

- [ ] **Step 3: 运行全量自动化门禁**

Run: `pnpm test && pnpm lint && pnpm build`

Expected: 全部 exit 0。

- [ ] **Step 4: 运行 Web 活跃入口验证**

启动本机测试配置，通过 Computer Use 完成：普通对话引用测试 Flow并粘贴三行参数 → draft 卡 → 编辑问题项 → 一次确认 → 逐项终态 → 只重试失败项。保存截图/日志到 `output/flow-batch-validation/`，不得提交临时产物。

- [ ] **Step 5: 运行真实飞书安全验证**

在测试 Flow/内存 capability 上发送批量参数，确认精简预览、明确确认和聚合终态。不得调用线上业务写 capability。Telegram 只运行自动化并记录“未正式启用”。

- [ ] **Step 6: 更新 Surface Matrix 和完成证据**

设计文档追加实施记录：Web/Agent/飞书/Telegram 的 implemented/reachable/closed-loop/planned 证据；Telegram 保持 implemented/disabled。

- [ ] **Step 7: GitNexus 与最终提交门禁**

Run: `npx gitnexus analyze && npx gitnexus detect-changes -r CodeBridge -s staged && git diff --cached --check`

Expected: 影响只落在 Flow batch、session event projection、Web batch UI 和 channel batch command；无无关执行流。

```bash
git add apps/bridge/src/flow-batch-goal-validation.test.ts docs/superpowers/specs/2026-08-21-conversational-flow-batch-invocation-design.md
git commit -m "test(flow): verify conversational batch invocation"
```

## 完成审计

最终逐条出示证据：

- LLM 能提交自然语言/表格/JSON/CSV/附件来源的多项 draft；
- Bridge 而非 Agent 决定 `ready`、版本和合法输入；
- Web 能预览、编辑并一次确认；
- 每项一个独立 Runtime Run，固定同一 Flow revision/plan；
- 并发、部分失败、取消、重启恢复和失败项单独重试均有测试；
- 飞书真实活跃入口闭环；
- Telegram 合同测试通过但仍 disabled；
- 无线上业务写入；
- 全量 test/lint/build 和 GitNexus detect-changes 通过。
