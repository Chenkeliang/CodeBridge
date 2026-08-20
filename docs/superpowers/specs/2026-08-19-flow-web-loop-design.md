# Flow 阶段 1 Web 闭环：证据链全可见

- Status: Landed (2026-08-20, plan `2026-08-19-flow-web-loop.md` T1–T7 全部落地；e2e `e2e/flow-loop.spec.ts` 通过)
- Date: 2026-08-19
- Branch: `feat_flow`（从 `origin/main` 切出，与 backend 同支）
- Scope: `packages/work-items/src/session-projector.ts`（本轮**唯一**后端改动：把 flow 事件投影进 timeline；**不新增 HTTP 路由**）、`apps/web/src`（types/api/session-store/components/workbench/composer）、新增 Playwright e2e 基建
- Related: `docs/superpowers/specs/2026-08-19-flow-runtime-loop-design.md`（后端闭环，已落地 T1–T8 + 收尾 `8505f3d` / `5a99ba5`）
- 本文件是阶段 1 Web 闭环的**目标规格**。实现计划另写。

## 0. 决策

Web 主路径（侧边栏选 Flow → 填参数 → 发消息 → 看执行 → 看结果）端到端走通，**证据链全部可见可交互**。这是对 `flow-runtime-loop-design.md` §7 两条非目标的**明确捞回**：

- 捞回「参数表单卡片」「独立 Flow 详情视图」：没有它们主路径在 Web 上是死路（后端 409 missing_inputs，前端无入口）。
- 新增「实时步骤流」「结果/失败渲染」：STEP_* 与 RUN_SNAPSHOT / VERIFICATION_FAILED 事件后端已发（run-executor），**服务端 timeline 投影缺失**（见 §3）。

**时间线权威源拍板 A（2026-08-20）：** 改 `projectSessionEvent`，把 `PARAM_RESOLVED` / `STEP_*` / `RUN_SNAPSHOT` / `VERIFICATION_FAILED` 写成 `flow_*` block。Web 把 `GET /v1/sessions/:id` 的 timeline 当**唯一权威源**。F5、submit 后 `refresh`/`hydrate`、gap 恢复都走这条。`applyFlowEvent` 若保留，只做 live 加速；**不得**承担「刷新后证据链仍在」。拒绝「只改 `receive`」。

**candidate 入口拍板 A（2026-08-20）：** 侧栏「已发布」下加「候选」组，同一套点开 `FlowDetail`（candidate 只有 Dry-run）。点 published **绑定** `flowId`；点 candidate **只打开详情，不写会话绑定**（dry-run POST 的 `flow_id` 走消息体）。不在 composer 加选择器。Composer Plus 里现有绑定下拉若保留，只列 published。

不做的仍是阶段 2/3 产物（非"尾巴"，是分期）：审批 UI、推荐、DAG 编辑器、guide 可重放、参数候选自动推荐下拉。本轮降级（记档，见 §5）：attribution 展开、`output_ref` 拉 artifact、`BRANCH_*` / `RUN_STARTED` / `RUN_SUCCEEDED` 逐步独立渲染。

## 1. 北极星（沿用，不改）

Flow 是参数化、版本冻结、结果可验证的可执行契约。一次成功 runbook 执行留下 PARAM_RESOLVED → 冻结 PlanIR → ResolvedPlan → 确定性执行 → RUN_SNAPSHOT（失败则 VERIFICATION_FAILED 四分类）。**Web 端把这整条链呈现给用户**：

| 证据链环节 | Web 呈现 |
| --- | --- |
| 绑 published Flow | 侧栏「已发布」选 Flow → 绑定 + 详情（版本/inputs/steps 可见）。「候选」只预览，不绑定 |
| 参数确认 → PARAM_RESOLVED | 参数表单（default 预填、required 标注）→ 缺参就地高亮且不丢已填 → 提交带 inputs；历史 PARAM_RESOLVED 显示 confirmed/edited 徽标 |
| 冻结 PlanIR | 详情与绑定徽标显示 hash **去 `sha256:` 前缀后的末 8 位** |
| 确定性执行 | 步骤流：`STEP_STARTED/SUCCEEDED/FAILED/RETRYING/SKIPPED` 投影为 `flow_step`（按 step 聚合，upsert merge） |
| RUN_SNAPSHOT | 结果卡：步骤轨迹（capability → passed/failed → `output_ref` 原文）、`resolved_inputs` |
| VERIFICATION_FAILED | 失败卡：四分类徽标 + postcondition + `truncated` 标记 |

「越用越准」靠证据链，Web 把证据链给用户看得到。

## 2. 本轮做完的定义

用户在 Web：侧边栏点 published Flow → 绑定并看到详情 → 填参数 → **从详情「运行」发送（不依赖 composer 草稿非空）** → 看到绑定徽标、步骤、结果卡或四分类失败卡。刷新后证据链仍在。candidate 从侧栏「候选」打开同一详情，只 Dry-run、不绑定。全程无 Agent 执行（回归：未绑定会话仍走 Agent）。

1. `FlowRecord` 前端类型与后端 `toApiFlow` 对齐（`inputs` / `steps` / `success_when` / `plan_ir_hash`）。`FlowInput.source` 用 `string`，不写撒谎的联合类型（catalog 含 `agent` / `step_output`）。
2. 新增 `fetchFlow(id)`（`GET /v1/flows/:flow_id` 已有路由）供详情视图使用。
3. `sendMessage` 支持 `inputs` / `dry_run`；`ApiError.body` 透传 `missing[]`。
4. **`projectSessionEvent` 把四类 flow 事件写入 timeline**（`flow_param` / `flow_step` / `flow_run` / `flow_failure`）。upsert **merge** metadata（`STEP_SUCCEEDED` 不得丢掉 `capability_id`）。
5. Web 渲染上述四种 block；`session-store.receive` 不把 flow 块当权威投影。hydrate 来的 timeline 才是刷新后的真相。
6. `FlowDetail`：详情 + 参数表单 + missing 高亮 + candidate dry-run。`values` 由 workbench **受控**；409 不 remount，只灌 `missing`。
7. FlowDetail 提交走独立 `sendMessage`：`message` = 当前草稿 trim，空则 `运行 ${flow.name || flow.flow_id}`。composer 未绑定路径不变。
8. 侧栏 Flows 面板两组：`status === "published"` 在「已发布」（点击 → 绑定 `flowId` + 打开详情，可「运行」）；`status === "candidate"` 在「候选」（点击 → 只打开详情，**不** `setFlowId`，仅 Dry-run）。draft/deprecated 不出现。Composer 不承担 Flow 发现。
9. Playwright e2e（route mock，不起真后端）：published 主路径；缺参高亮且值保留；**candidate 详情可见 dry-run 并点得下去**。
10. 既有测试全绿（含 projector / session-runtime-api / run-executor / flow-api）。

## 3. 地基（对代码核过）

### 3.1 已有、本轮不新增的 HTTP

- `GET /v1/flows/:flow_id`（`flow-api.ts`），`toApiFlow` 已含 `inputs` / `steps.success_when` / `plan_ir_hash`。
- `POST /v1/sessions/:id/messages` 已接受 `inputs` / `dry_run`；409 `missing_inputs` 返回 `{id,type,source,reason}[]`。
- SSE `GET /v1/sessions/:id/events` 已推 flow 事件。runbook 路径 `observeExecution(..., wait=true)`：**202 返回前事件已全部落库**。
- `GET /v1/sessions/:id` 返回 projector 写出的 `timeline`。submit 成功后 workbench **必** `sessionConnection.refresh()` → `hydrate` 整表替换。

### 3.2 本轮必须改的后端（无新路由）

- `packages/work-items/src/session-projector.ts`：`STEP_*` / `PARAM_RESOLVED` / `RUN_SNAPSHOT` / `VERIFICATION_FAILED` 目前在显式 no-op 分支（约 78–102 行），只推 cursor，**服务端 timeline 永无 flow 块**。这是主路径看不见步骤的根因。本轮把它们改成写入 `flow_*` block。`BRANCH_SELECTED` 仍 no-op（§5）。
- `PARAM_RESOLVED` 今天常无 `runId`。投影时：有 `runId` 挂该 Run 的 turn；否则挂该 session **最新** timeline turn。可选顺手：`appendParamResolvedEvents` 带上 `result.run.id`（仍不是新路由）。

### 3.3 Web 侧缺失（本轮补）

- `FlowRecord`（`types.ts`）字段落后于 `toApiFlow`。
- `sendMessage` body 无 `inputs` / `dry_run`；`ApiError` 无 `body`。
- timeline block kinds 无 `flow_*`；渲染层不认识它们。
- 无 Playwright 基建（根目录有 `playwright-core`，无 `@playwright/test` config / 无 `e2e/`）。
- `session-store.receive` 对非 agent 事件 `refresh_required`：**这是正确的权威路径**（hydrate 拉 projector），不要改成「只靠客户端 reducer 扛证据链」。

## 4. 组件与数据流

```
run-executor appendEvent
  → projectSessionEvent 写入 timeline (flow_param/flow_step/flow_run/flow_failure)
  → GET /v1/sessions/:id hydrate = 权威
  → SSE 只推进 sequence；RUN_SUCCEEDED 等仍可 refresh_required
  → 可选 applyFlowEvent：仅 live 加速，hydrate 覆盖为权威

workbench: 侧栏「已发布」→ 绑定 + FlowDetail；「候选」→ 仅 FlowDetail（不绑定）
FlowDetail 运行 / Dry-run → sendMessage({ message: 合成, flow_id: detailFlow.flow_id, inputs, dry_run? })
  → 409 missing_inputs → 不卸载表单，只灌 missing
composer: 绑定徽标仅反映已绑定 published（hash 末 8）+ 未绑定仍走原 submit
```

## 5. 明确不做（阶段 2/3 + 本轮降级）

阶段 2/3：审批 UI、推荐、DAG 编辑器、guide 可重放、参数候选自动推荐下拉、独立「运行 Flow」整页导航。

本轮降级（不是尾巴，是砍范围）：

- RUN_SNAPSHOT **attribution** 不单独展开。
- `output_ref` 显示原文，**不**拉 artifact 内容。
- `BRANCH_SELECTED` / `RUN_STARTED` / `RUN_SUCCEEDED` / `RUN_FAILED` **不**做逐步独立卡（`RUN_STARTED` 已有 `work` 块；终态仍改 turn status）。
- `applyFlowEvent` 不是刷新后证据链的承担者。
- 不在 composer 新增 Flow 发现入口（`/flow` 命令或第二套下拉）。

## 6. 验收

1. `pnpm vitest run packages/work-items/src/session-projector.test.ts`：四类 flow 事件出现对应 `flow_*` block；`STEP_SUCCEEDED` 后 metadata 仍含 `capability_id`；刷新路径不依赖 Web reducer。
2. `pnpm vitest run apps/web` 全绿。
3. Playwright e2e（mock API，页面 `/workbench/`）：
   - published runbook：选 Flow → 填 `text` → 点详情「运行」（composer 可空）→ hydrate 后的时间线有步骤行与「Run 快照」（含 `output_ref` 原文与 `2 / 2`）。
   - 缺 `text`：字段高亮「缺少必填参数」，已填其它值保留。
   - candidate：侧栏「候选」点开详情 → 有 Dry-run、无「运行」；点击发出 `dry_run: true`，且会话 `flow_id` 仍为 null / 保持原 published 绑定。
4. 回归：未绑定会话消息路径不受影响；「已发布」组不含 candidate。
5. 后端测试套件全绿。

## 7. 自审

- 无 TBD：权威源 A、candidate 入口 A（侧栏两组、候选不绑定）、projector 范围、表单提交/受控 values、e2e mock 面、降级项均已选定。
- 不新增 HTTP 路由；本轮**需要**改 projector（以及可选 PARAM `runId`）。
- 不破坏现有序列语义：gap/recover/文本增量不动；`hydrate` 仍是 timeline 权威。
- hash 展示：去 `sha256:`（或最后一个 `:`）前缀，取末 8 位，禁止 `slice(0, 8)`。
