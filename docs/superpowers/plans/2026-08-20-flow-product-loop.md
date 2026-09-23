> 历史记录：Flow 功能已于 2026-09-23 进入完整移除；本文保留设计/验收审计，不再描述当前可用功能。当前范围见 `docs/plans/2026-09-23-remove-flow.md`。

# Flow 全通道产品闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 published Flow 能在 Web / 飞书 / Telegram 上被发现、绑定、运行，并补上「存为 Candidate → Web 审查发布」的人手动闭环；先修通道 `flow_id` 省略被写成 `null` 导致无法继承会话绑定的合同 bug。

**Architecture:** 通道只做适配。Catalog / Session / Run 仍在 Bridge。绑定写 `session.flowId`（仅 published）。斜杠 `/flow` 与 `/backend` 一样走共用 `handleSlashCommand`，通过 ingress 调现有 `apply` / `candidates` / `review`。不新建通道侧状态机。

**Tech Stack:** TypeScript, Hono, Vitest, 现有 `@codebridge/router` slash、`channel-feishu` / `channel-telegram`、`apps/web` React、Playwright e2e（已有 `e2e/flow-loop.spec.ts`）。

**Spec:** `docs/superpowers/specs/2026-08-20-flow-product-loop-design.md`

**Branch:** `feat_flow`（从 `origin/main` 切出）。禁止在 `main` 上直接改。合入前跑 GitNexus `detect_changes`。改任何已有函数前先 `gitnexus_impact({target, direction: "upstream"})`；HIGH/CRITICAL 先停并报告。

**Default decisions (D1–D10):** 见 spec §13。审查改决策后先改 spec 再改本计划。

**Wave order:** W0 → W1 → W2 → W3 →（可选）W4 → W5 → W6。W0 不可跳。审查可砍 W4/W5/W6。

**Granularity:** 本文件是**程序计划**（供审查范围、文件、验收、测试名）。每个 Wave 开工前再拆成 TDD 微步骤；W0/W1 下面已给出应先红的测试形状，避免「省略变 null」被再次写错。

---

## File map

| File | Wave | Responsibility |
| --- | --- | --- |
| `apps/bridge/src/session-api.ts` | W0 | 通道消息：仅当 `Object.hasOwn(body, "flow_id")` 才转发；command-context 返回 `flow_id` |
| `apps/bridge/src/session-runtime-api.ts` | W0 | `nullable`：缺省继承 `session.flowId`；显式 null 的语义按 D4（通道不再发 null） |
| `apps/bridge/src/channel-ingress.ts` | W0 W1 | submit 省略 flowId；command-context 映射 `flowId` |
| `apps/bridge/src/flow-api.ts` | W0 W2 | apply 只接受 published；candidates 从 runbook Run 抽定义（W2） |
| `packages/core/src/types.ts` | W0 W1 | `ChannelCommandContext.flowId` |
| `packages/router/src/slash-commands.ts` | W1 | `/flow` |
| `packages/router/src/command-help.ts` | W1 | help + `BOT_MENU_EVENT_KEYS.fcb_flow` |
| `packages/router/src/slash-commands.test.ts` | W1 | `/flow` 列表/绑定/解绑/run |
| `packages/channel-feishu/src/bridge.ts` | W1 W4 | 注入 list/apply/unbind；可选成功卡 |
| `packages/channel-telegram/src/telegram-bridge.ts` | W1 W4 | 同上 |
| `apps/web/src/components/workbench.tsx` | W2 W3 W6 | 「存为 Flow」；审查入口；空目录解绑 |
| `apps/web/src/components/flow-detail.tsx` | W3 | 审查通过/打回；candidate 保持仅 Dry-run |
| `apps/web/src/lib/api.ts` | W2 W3 | `saveFlowCandidate` / `reviewFlow` |
| `e2e/flow-loop.spec.ts` | W2 W3 | 存为 Flow、审查后侧栏出现 published |
| `apps/bridge/src/session-api.test.ts` | W0 | 通道省略 flow_id 时继承 session 绑定 |
| `apps/bridge/src/flow-api.test.ts` | W0 | apply(candidate) → 409 |
| `apps/bridge/src/session-runtime-api.test.ts` | W0 | 已绑会话、消息无 flow_id → 仍编译 runbook |

不改：`packages/workflow-engine` 编译语义、`run-executor` 确定性执行（除非 W2 抽 PlanIR 只读）。不把 `AGENTS.md` / 未跟踪垃圾卷进提交。

---

## Wave 0 — 通道合同（绑定才能真执行）

**Done when:** 槽位 session 已有 `flowId=published runbook`，飞书/Telegram 式通道 POST **不带** `flow_id` 字段，Runtime 仍按该 Flow 执行。`apply(candidate)` → 409。

### Task 0.1: 通道入口不要把省略变成 null

**Files:**
- Modify: `apps/bridge/src/session-api.ts`（`POST /v1/channels/:channel/conversations/:conversation_id/messages` 转发 messages 的 JSON）
- Test: `apps/bridge/src/session-api.test.ts`

- [ ] **Step 1: 写失败测试**

现有通道 send helper 不传 `flow_id`。先给 fixture session `updateSession({ flowId: publishedId })`，再 POST 通道消息，断言内层行为：该 turn 的 run 绑的是 published Flow（或 202 后 session 快照 / 事件含该 `flow_id`），而不是按未绑定 Agent 创建。

若当前测试基建只 assert 202：新增断言 `GET /v1/sessions/:id` 的 `flow_id` 仍为 publishedId，且若有 `runtime.active_run` / 最近事件，`workflow` / plan 与该 Flow 一致。

对照错误实现：转发 `"flow_id": null` 会导致 `nullable(null, session.flowId) === null`。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run apps/bridge/src/session-api.test.ts apps/bridge/src/session-runtime-api.test.ts
```

Expected: 新用例 FAIL（通道省略 flow_id 后按未绑定执行，或 flow_id 被清空）。

- [ ] **Step 3: 最小修复**

通道 handler 里不要写：

```ts
flow_id: asNullableString(body.flow_id),
```

改为：

```ts
...(Object.hasOwn(body, "flow_id") ? { flow_id: asNullableString(body.flow_id) } : {}),
```

`/v1/sessions/:id/messages` 已有 `nullable(body.flow_id, session.flowId)`：字段缺省（`undefined`）继承；不要把通道层的省略变成 `null`。

兼容 POST `/runs` 同样处理（通道 handler 里第二段 `flow_id: asNullableString(body.flow_id)`）。

- [ ] **Step 4: 单测通过**

```bash
pnpm vitest run apps/bridge/src/session-api.test.ts apps/bridge/src/session-runtime-api.test.ts
```

Expected: PASS

- [ ] **Step 5: 提交**（仅当用户要求 commit；审查阶段可先不提交）

```bash
git add apps/bridge/src/session-api.ts apps/bridge/src/session-api.test.ts apps/bridge/src/session-runtime-api.test.ts
git commit -m "$(cat <<'EOF'
fix: inherit session flow when channel omits flow_id

EOF
)"
```

### Task 0.2: apply 拒绝非 published

**Files:**
- Modify: `apps/bridge/src/flow-api.ts` `POST /v1/flows/:flow_id/apply`
- Test: `apps/bridge/src/flow-api.test.ts`

- [ ] **Step 1: 失败测试** — candidate 调 apply → 409 `flow_not_bindable`（或 spec 选定的 error code），session.flowId 不变。
- [ ] **Step 2: 实现** — `flow.status !== "published"` 或 `flow.status === "deprecated"`（deprecated 已 409）均不可绑定。guide published 按 spec D3：允许 apply，执行路径仍走 Agent 指针（现有 kind!==runbook 不 compile）。
- [ ] **Step 3:** `pnpm vitest run apps/bridge/src/flow-api.test.ts` PASS
- [ ] **Step 4:** 提交（用户要求时）`fix: reject candidate flow apply`

### Task 0.3: command-context 带 flowId

**Files:**
- Modify: `packages/core/src/types.ts` `ChannelCommandContext`
- Modify: `apps/bridge/src/session-api.ts` `POST /v1/channels/command-context` 响应
- Modify: `apps/bridge/src/channel-ingress.ts` 映射 `flowId`
- Test: 覆盖 command-context 的现有测试（`session-api.test.ts` 搜 `command-context`）

- [ ] 响应增加 `flow_id: session?.flowId ?? null`
- [ ] ingress 填 `flowId`
- [ ] 无 session 时 `flowId: null`
- [ ] `pnpm vitest run apps/bridge/src/session-api.test.ts apps/bridge/src/channel-ingress.test.ts`

**W0 验收：** spec §12.2、§12.3（apply 部分）。

---

## Wave 1 — 聊天绑定 `/flow`

**Done when:** 飞书与 Telegram 用户 `/flow` 看到 published 列表，`/flow 1` 绑定当前槽位，下一句普通消息跑该 runbook；`/flow off` 后回到 Agent。不经 Web UI。

### Task 1.1: SlashContext 能力（ingress 注入，router 不碰 SQLite）

**Files:**
- Modify: `packages/router/src/slash-commands.ts` `SlashContext`
- Modify: `apps/bridge/src/channel-ingress.ts` 或 session-api 增加薄路由：`GET` 已有 `/v1/flows`；apply 已有。Slash 通过 **新的 ingress 方法** 调这些 HTTP，避免 router 依赖 Hono app。

建议在 `ChannelSessionIngress`（`packages/core/src/types.ts`）增加：

```ts
listPublishedFlows(): Promise<Array<{ flowId: string; name: string; kind: string }>>;
applyFlow(sessionId: string, flowId: string): Promise<{ ok: true } | { ok: false; error: string }>;
unbindFlow(sessionId: string): Promise<void>;
```

`unbindFlow`：`catalog.updateSession(id, { flowId: null })`，可走现有 PATCH session 若已有；没有则在 session-api 加显式 `POST /v1/sessions/:id/flow` `{ flow_id: null }`。**优先**复用 `updateSession` 的 HTTP（搜 `PATCH` / `POST /v1/sessions/:id`）。没有就加最小 PATCH，不要让 slash 直接 import FlowCatalogStore。

- [ ] 单测 ingress：list 只返回 published；apply 走 W0 的 409
- [ ] FeishuBridge / TelegramBridge 把这些函数传入 `handleSlashCommand`

### Task 1.2: `/flow` 命令

**Files:**
- Modify: `packages/router/src/slash-commands.ts`
- Modify: `packages/router/src/command-help.ts`（常用或新分组「Flow」；`BOT_MENU_EVENT_KEYS.fcb_flow = "/flow"`）
- Test: `packages/router/src/slash-commands.test.ts`

行为（spec §6.2）：

| 输入 | 结果 |
| --- | --- |
| `/flow` | 回复列表；已绑定则首行当前 Flow |
| `/flow 1` | apply 第 1 条 published |
| `/flow flow_demo_echo` | 按 id 或唯一前缀 apply |
| `/flow off` | unbind |
| `/flow run text=hi` | 见 Task 1.4 |
| `/flow save` | Wave 2 再接通，W1 回复「尚未支持」或直接留到 W2 实现 |

未知 id → reply 不明码执行 Agent。

`/status` 增加 `**flow**: ...`，读 `getSlotCommandContext().flowId`。

- [ ] `pnpm vitest run packages/router/src/slash-commands.test.ts`
- [ ] `pnpm vitest run packages/router/src/slash-commands.test.ts` 里现有 `/help` `/help full` 断言包含 `/flow`

### Task 1.3: 绑定后普通消息执行（依赖 W0）

**Files:** 主要靠 W0；此处加 **通道级** 测试：

- Test: `apps/bridge/src/session-api.test.ts` 或 `packages/channel-feishu/src/bridge-stream.test.ts`（若 submit mock 足够）

场景：session.flowId 已是 `flow_demo_echo`（published fixture），submit 不带 flowId，断言 coordinator/runtime 收到的 message.flowId 或冻结 plan 的 workflowId 为 echo。

- [ ] 飞书与 Telegram 的 submit 对象继续不设 `flowId`（省略），不要为「修复」去硬编码 `flowId: session.flowId` 在 bridge 里——继承必须发生在 Bridge messages 合同，否则 Web 与通道会分叉。

### Task 1.4: `/flow run k=v`

**Files:** slash + ingress `submit` 带 `flowId` + `inputs`

解析：`/flow run text=hello other=x` → `{ text: "hello", other: "x" }`。值含空格用第一次 `=` 分割。缺绑定 → 文案先 `/flow`。409 missing_inputs → 把 missing id 列表回给用户（slash `type: "reply"`）。

- [ ] 单测解析与 missing 文案
- [ ] 不在聊天里做表单

**W1 验收：** spec §12.1、§12.3（列表）、§12.6。手工：工作台有一条 published 时，飞书 `/flow` → `/flow 1` → 发一句 → Web 打开同一 session 能看到 flow 步骤（若槽位 session 能在 Web 列出）。

**不确定：** Web 会话列表是否展示通道槽位 session。不影响通道执行；若列表没有，用 `/status` 的 session id 在 Web 打开。

---

## Wave 2 — 存为 Flow

**Done when:** Web 当前会话在一次成功 runbook Run 之后可点「存为 Flow」，侧栏「候选」出现该条，可 Dry-run。空闲聊点按钮得到可读错误。`/flow save` 对槽位会话做同一 POST。

### Task 2.1: API 从最近成功 runbook Run 生成定义

**Files:**
- Modify: `apps/bridge/src/flow-api.ts` `POST /v1/flows/candidates`
- Test: `apps/bridge/src/flow-api.test.ts`

当 body.flow.steps 为空或省略：从 `session_id` 找最近 succeeded run，其 plan 为 source=workflow 的 PlanIR，映射为 candidate steps/inputs。没有则 409 `no_saveable_runbook`。

不要把 `FLOW_PROPOSED` manual guide 当成可发布源（spec D6）。

自动参数化：最小可用 = 原样拷贝该 Run 的 inputs 声明 + 步骤 capability；把看起来像绝对路径的 **resolved 值** 提成 input 可列为 W2 增强，没有则拷贝声明即可，审查 W3 再改。

- [ ] 测试：有成功 echo run → 201 candidate，steps 含 `demo.echo`
- [ ] 测试：从未跑过 runbook → 409

### Task 2.2: Web 按钮

**Files:**
- Modify: `apps/web/src/lib/api.ts` — `saveFlowCandidate(sessionId)`
- Modify: `apps/web/src/components/workbench.tsx` / `session-chrome.tsx` — 会话区「存为 Flow」
- Test: `apps/web/src/components/workbench.test.tsx` 或邻近测试
- e2e: `e2e/flow-loop.spec.ts` mock POST candidates → 侧栏候选可见

空目录文案：`session-chrome.tsx` published 为 0 时增加「把一次成功的确定性执行存为 Flow」。

Plus 下拉无 published 时仍隐藏 Flow 选择器（保持现状）。解绑入口见 W6。

### Task 2.3: `/flow save`

接 Task 1.2 占位。调用同一 candidates API，session_id = 槽位 session。成功回复 candidate id，提示去 Web Dry-run。

**W2 验收：** spec §12.4。

---

## Wave 3 — Web 审查

**Done when:** 用户在 Web 对 candidate 点通过（填 git_revision）后变为 published，侧栏「已发布」出现；打回仍为 candidate。无 git_revision 的 approve 保持 409。

### Task 3.1: api.reviewFlow

**Files:** `apps/web/src/lib/api.ts`、`apps/web/src/lib/api.test.ts`

`POST /v1/flows/:id/review` `{ decision, git_revision? }`

### Task 3.2: UI

**Files:** `apps/web/src/components/flow-detail.tsx`（candidate 段：Dry-run 旁增加「通过 / 打回」；通过前 `git_revision` 输入；可选只读预填需 workspace git，没有则空着让用户粘贴）

Diff：最小可用 = 展示 steps JSON（当前 candidate）。相对上一 published 的语义 Diff 若费时，W3 可先做「全新 / 步骤列表」，W3.1 再补。计划默认：**W3 必须能通过/打回**；语义 Diff 列为 W3 完成定义的加分项，审查可要求必须做。

Spec 默认 D8：不替用户 git commit。

飞书 **无** 批准按钮。

- [ ] e2e：candidate → review approve mock → 侧栏 published
- [ ] `pnpm vitest run apps/web`
- [ ] `pnpm vitest run apps/bridge/src/flow-api.test.ts` 回归 publishIssues

**W3 验收：** spec §12.5。

---

## Wave 4 — 建议保存 / 建议审查（可选）

**Done when:** 成功 runbook 终态后，飞书/Telegram 出现短卡或 markdown 按钮文案；用户确认才 POST candidates。Agent 文本「建议存为 Flow」若用户只打字「好」——**W4 不解析自然语言确认**（误触发）。确认只接受：卡按钮、`/flow save`、Web 按钮。

对话「建议审查」= 文本 + Web 指引，不调用 review approve。

**Files:** `packages/channel-feishu/src/session-watcher.ts`（终态）、telegram watcher；卡片 schema 保持飞书 2.0 markdown + 可选 button（若现有 coalescing card 不便加按钮，用「回复 `/flow save`」文案，避免新交互栈）。

**W4 验收：** spec §7 表；未确认不新增 catalog 行（单测：终态通知不 POST）。

---

## Wave 5 — 对话识别 published（可选，P2）

**Done when:** 未绑会话用户说的话匹配某条 published **名称**（精确或唯一包含），Bot **先回复确认**「要绑定「仓库巡检」吗？回复 `/flow <id>`」。**禁止** 静默 apply。

不做 embedding / FLOW_RECOMMENDED 事件生产。

实现建议：slash 之外的普通消息仍先走 Agent；识别放在 **Agent 系统前缀** 之前太重。更小的做法：在 `handleSlashCommand` default 之前，若文本等于某 published name，reply 确认，不 `type: "agent"`。误伤：用户就是想闲聊同名话题——所以必须确认，且默认 **仅精确匹配 name 或 flow_id**。

**W5 验收：** spec §12 未绑不得当真跑；确认前 catalog apply 次数为 0。

---

## Wave 6 — 体验收口（可选）

- Composer：0 条 published 时仍能解绑（若 session.flowId 非空，显示「解除 Flow 绑定」）。Plus 下拉隐藏不等于不能解绑。
- `/new` 后新会话 flowId 为 null（核对 `getOrCreateBoundSession`；若复制了旧 flowId 则修）。
- 通道 Run 终态摘要：步骤通过数（从事件计数，不拉 artifact）。
- 不做 DAG 编辑器。

**W6 验收：** spec §6.4、§8。

---

## 测试与回归命令（每波结束）

```bash
pnpm vitest run apps/bridge/src/session-api.test.ts apps/bridge/src/session-runtime-api.test.ts apps/bridge/src/flow-api.test.ts
pnpm vitest run packages/router/src/slash-commands.test.ts
pnpm vitest run apps/web
pnpm vitest run e2e/flow-loop.spec.ts
# 或项目既有 playwright 入口
```

W1 后加：`packages/channel-feishu` / `channel-telegram` 相关 vitest。

合入前：`npx gitnexus analyze`（若 index stale）+ GitNexus `detect_changes`。

---

## 明确不在本计划

- 领域 adapter 真业务、equity 桩变真
- runbook 失败 Agent 兜底
- guide 进确定性执行器
- DAG 编辑器、自动推荐飞轮
- 飞书批准发布
- 通道自建 Flow 草稿

---

## Spec coverage

| Spec 章节 | 任务 |
| --- | --- |
| §2.3 省略变 null | 0.1 |
| §2.3 / §6.1 apply candidate | 0.2 |
| §6.2 /status flow | 0.3 + 1.2 |
| §6.2 `/flow` | 1.1–1.4 |
| §4 保存 | 2.1–2.3 |
| §5 审查 | 3.1–3.2 |
| §7 建议 | 4 |
| §7 P2 识别 | 5 |
| §6.4 §8 解绑/摘要 | 6 |
| §10 不做 | 本计划「不在本计划」 |

---

## 审查时请直接改的地方

1. D1–D10（spec §13）有没有要翻的。
2. W3 语义 Diff 是必须还是加分。
3. W4/W5/W6 保留还是砍。
4. `/flow` 是否只列 runbook（D3）。

仓库内不能当已经验证的：飞书自定义菜单会不会出现 `fcb_flow`；本机 flows.sqlite 是否为空；Web URL 能否贴进卡片。
