# Flow 三通道 V1 P0A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **执行要求：** 按任务顺序实施，每个任务先写失败测试，再做最小实现。修改已有函数、类或方法前必须先执行 GitNexus upstream impact；若为 HIGH/CRITICAL，先报告影响面并单独验证受影响流程。提交前必须运行 `gitnexus_detect_changes()`。

**目标：** 建立 Flow V1 的统一领域规则和调用合同，使 Web 能管理、绑定和使用 Flow，并为飞书、Telegram 后续列出和显式调用 Published Runbook 提供共用 Bridge API 与传输底座。

**架构：** Flow Catalog 是状态和谓词的唯一真相，Session Catalog 只通过 apply/unbind 持久化不可变 revision binding，Runtime 用一个纯 invocation resolver 区分 Web binding、一次调用和通道普通消息。Web、飞书、Telegram 只调用这些用例；通道侧不实现 Flow 状态机、版本规则或授权策略。

**唯一产品依据：** [2026-08-20-flow-three-channel-v1-final-alignment.md](../specs/2026-08-20-flow-three-channel-v1-final-alignment.md)

**核心定义：** `Flow = Published Runbook + Runtime 执行权`。Guide 仅是 Web 草稿。三端共用 Flow Catalog、Session、Runtime、Review 和审计能力；飞书、Telegram 只增加通道交互与身份适配，不复制 Web 页面，也不复制 Flow 领域逻辑。

**技术栈：** TypeScript、Hono、SQLite、React、Vitest、现有 Bridge / Flow Catalog / Session Catalog / Channel Ingress。

---

## 0. 范围、顺序与风险

### 本计划包含

1. 合法 `kind × status` 状态矩阵与五个统一谓词。
2. Catalog 写入校验与管理/消费两套查询。
3. Session 绑定固定 `flowId + definitionRevision`。
4. `apply`、`unbind` 与 `/messages` 一次调用的写语义拆分。
5. Runtime 对状态、Dry-run、revision 的统一校验，禁止 Guide 回落 Agent。
6. Web 对新合同的最小适配。
7. 飞书、Telegram 调用所需的 `flow_id + definition_revision` 传输合同。
8. 本机 actor 映射和 Flow 调用审计，不引入 Flow ACL。

### 本计划不包含

- 飞书、Telegram `/flow` 列表卡、补参卡、确认卡的最终交互。
- P0A 不以“飞书/Telegram 用户已经能在聊天中列出并完整跑完 Flow”为验收条件；该端到端消费交互属于后续 Channel UI 计划。
- `STEP_SUCCEEDED`、`RUN_SNAPSHOT`、`ARTIFACT`、`VERIFICATION_FAILED` 的跨通道结构化回流；单列 P0B。
- 成功 Run 自动生成 Candidate、lineage 模型和 Web Review 工作台；属于 P1。
- Guide 编辑器、DAG、自由编排、对话自动推荐；属于 P2。
- semver；V1 使用 `definitionRevision`、`planIrHash` 和发布序号。

### 已知风险门

- `registerSessionRuntimeCommandRoutes` 的 upstream impact 已是 **HIGH**：影响 `createSessionApp`、Session 测试 fixture 和三条执行流程。Task 4 开工前必须重新运行 impact，并在改动后执行 Bridge Session 全量测试。
- `FlowCatalogStore`、`SessionCatalogStore` 为 **MEDIUM**：分别影响 Flow API、Session API 和测试 fixture。
- Web `sendMessage`、`Workbench` 为 **LOW**，但必须做一次普通聊天与一次 Flow 调用回归。

### PR 建议

| PR | 内容 | 对应任务 |
| --- | --- | --- |
| PR 1 | Flow policy + Catalog 合法状态 | Task 1 |
| PR 2 | Session revision binding + Flow API | Task 2–3 |
| PR 3 | Runtime message contract | Task 4 |
| PR 4 | Channel/Web contract + actor audit | Task 5–7 |
| PR 5 | P0A 集成验收 | Task 8 |

不要把 P0B watcher 回流绑进以上任一 PR。

---

## 1. 建立唯一 Flow Policy

**Files**

- Create: `packages/flow-catalog/src/policy.ts`
- Create: `packages/flow-catalog/src/policy.test.ts`
- Modify: `packages/flow-catalog/src/index.ts`
- Modify: `packages/flow-catalog/src/index.test.ts`

### Task 1.1：先固定合法状态矩阵

- [ ] 对 `FlowCatalogStore` 运行 upstream impact，记录直接调用方和风险等级。
- [ ] 新增失败测试，覆盖所有合法组合：

```ts
expect(isLegalFlowState({ kind: "guide", status: "draft" })).toBe(true);
expect(isLegalFlowState({ kind: "runbook", status: "draft" })).toBe(true);
expect(isLegalFlowState({ kind: "runbook", status: "candidate" })).toBe(true);
expect(isLegalFlowState({ kind: "runbook", status: "published" })).toBe(true);
expect(isLegalFlowState({ kind: "runbook", status: "deprecated" })).toBe(true);
```

- [ ] 同一测试用参数化方式覆盖所有非法组合，至少包括：

```ts
[
  ["guide", "candidate"],
  ["guide", "published"],
  ["guide", "deprecated"],
  ["ephemeral", "draft"],
  ["ephemeral", "candidate"],
  ["ephemeral", "published"],
  ["ephemeral", "deprecated"],
]
```

- [ ] 运行并确认失败：

```bash
pnpm vitest run packages/flow-catalog/src/policy.test.ts
```

- [ ] 在 `policy.ts` 实现唯一状态规则，不能在 API 或 UI 重写条件：

```ts
export function isLegalFlowState(flow: Pick<FlowRecord, "kind" | "status">): boolean {
  if (flow.kind === "guide") return flow.status === "draft";
  if (flow.kind !== "runbook") return false;
  switch (flow.status) {
    case "draft":
    case "candidate":
    case "published":
    case "deprecated":
      return true;
    default:
      return false;
  }
}
```

- [ ] 增加运行期防御测试：把 `status: "unknown"` 强制转换为输入类型后，`isLegalFlowState` 必须返回 false；不能因为 `kind === "runbook"` 就放过未知状态。

- [ ] 实现并测试五个谓词：

```ts
export const isManageable = (flow: FlowState) => isLegalFlowState(flow);
export const isConsumable = (flow: FlowState) =>
  flow.kind === "runbook" && flow.status === "published";
export const isBindable = isConsumable;
export const isExecutable = isConsumable;
export const isDryRunnable = (flow: FlowState) =>
  flow.kind === "runbook" &&
  (flow.status === "candidate" || flow.status === "published");
```

- [ ] 导出统一错误：

```ts
export class InvalidFlowStateError extends Error {
  readonly code = "invalid_flow_state";
}
```

### Task 1.2：Catalog 拒绝新增非法记录

- [ ] 在 `FlowCatalogStore.save` 的第一处持久化前调用 `isLegalFlowState`；非法写入抛 `InvalidFlowStateError`。
- [ ] 修改现有使用 `guide × candidate/published` 的测试 fixture：
  - 真正执行/审查的 fixture 改为 `runbook`。
  - Guide fixture 只保留 `draft`。
- [ ] 增加测试：非法 Guide Published、任意 ephemeral 状态不落库。
- [ ] 不做破坏性的历史数据迁移。已有非法记录只允许诊断读取；管理列表、消费列表、apply、messages 一律用 policy 过滤或拒绝。
- [ ] 运行：

```bash
pnpm vitest run packages/flow-catalog/src/policy.test.ts packages/flow-catalog/src/index.test.ts
```

**验收：** 代码库只有 `policy.ts` 定义合法状态和五个谓词；其他层只能调用，不得复制布尔表达式。

---

## 2. Session 绑定固定 revision

**Files**

- Modify: `packages/session-catalog/src/index.ts`
- Modify: `packages/session-catalog/src/index.test.ts`
- Modify: `apps/bridge/src/session-runtime-types.ts`
- Modify: `apps/bridge/src/session-api.ts`
- Modify: corresponding session serialization tests in `apps/bridge/src/session-api.test.ts`

### Task 2.1：扩展持久化模型

- [ ] 对 `SessionCatalogStore`、`createSession`、`updateSession`、`toSession` 分别运行 upstream impact。
- [ ] 先写迁移测试：旧 SQLite 只有 `flow_id` 时重新打开 store，应自动增加 `flow_definition_revision`，旧记录 revision 为 `null`。
- [ ] 先写模型测试：绑定后同时返回 `flowId` 和 `flowDefinitionRevision`；解绑后两者同时为 `null`。
- [ ] 运行确认失败：

```bash
pnpm vitest run packages/session-catalog/src/index.test.ts
```

- [ ] 给 `AgentSession` 和 DB 增加：

```ts
flowDefinitionRevision: string | null;
```

SQLite 列名固定为：

```sql
flow_definition_revision TEXT
```

- [ ] 使用现有幂等 schema migration 模式添加列，不删除、不重建用户数据表。

### Task 2.2：把绑定变成显式领域操作

- [ ] 在 Session Catalog 增加：

```ts
bindFlow(
  sessionId: string,
  binding: { flowId: string; definitionRevision: string },
): AgentSession;

unbindFlow(sessionId: string): AgentSession;
```

- [ ] `bindFlow` 必须原子写入两个字段；`unbindFlow` 必须原子清空两个字段。
- [ ] Flow binding 不再通过通用 `updateSession({ flowId })` 写。删除 `UpdateSessionInput` 中的 Flow 绑定字段，修复所有编译错误调用点。
- [ ] `CreateSessionInput` 可保留兼容字段只用于旧数据库/fixture，生产绑定入口必须调用 `bindFlow`。若删除不会扩大迁移风险，则一并删除。
- [ ] Session JSON 增加：

```json
{
  "flow_id": "flow_demo",
  "flow_definition_revision": "sha256:..."
}
```

- [ ] 运行：

```bash
pnpm vitest run packages/session-catalog/src/index.test.ts apps/bridge/src/session-api.test.ts
```

**验收：** 不存在只有 `flowId` 没有 revision 的新绑定；解绑不会留下孤立 revision。

---

## 3. 统一 Flow API 的管理、消费、绑定与解绑

**Files**

- Modify: `apps/bridge/src/flow-api.ts`
- Modify: `apps/bridge/src/flow-api.test.ts`
- Modify: `apps/bridge/src/session-api.ts`（若专用解绑路由注册在 Session API）
- Modify: `apps/bridge/src/session-api.test.ts`

### Task 3.1：两套列表谓词

- [ ] 对 `createFlowApp` 和 Flow routes 注册函数运行 upstream impact。
- [ ] 新增 API 测试：
  - `GET /v1/flows?view=manage` 返回合法 Guide Draft 和全部合法 Runbook 状态。
  - `GET /v1/flows?view=consume` 只返回 Published Runbook。
  - Task 3 单独合入时，`GET /v1/flows` 缺少 `view` 暂按 `manage` 处理，保护尚未迁移的旧 Web。
  - 非法历史记录不进入任一业务列表。
  - 未知 `view` 返回 400 `invalid_flow_view`。
- [ ] 分两阶段迁移缺省值：Task 3 开发期间可暂以 `manage` 兼容尚未更新的旧 Web；Task 6 把所有第一方调用方改为显式 view 后，P0A 合入前必须把缺省改为 `consume`。最终生产代码不得保留“缺省即 manage”。
- [ ] Web 管理调用必须显式 `view=manage`；Web 消费和 Channel ingress 必须显式 `view=consume`。消费客户端不得依靠缺省值区分业务语义。
- [ ] 实现时只调用 `isManageable` / `isConsumable`。

### Task 3.2：apply 只做持久绑定

- [ ] 把现有 apply 的 Published Guide 成功测试改为 Published Runbook。
- [ ] 增加失败测试：Guide Draft、Runbook Draft、Candidate、Deprecated apply 均返回 409 `flow_not_bindable`，Session 原绑定不变。
- [ ] 成功 apply 调用 `sessionCatalog.bindFlow`，保存并返回：

```json
{
  "flow_id": "flow_demo",
  "definition_revision": "sha256:..."
}
```

- [ ] apply 使用 `isBindable`，禁止手写 status/kind 判断。

### Task 3.3：显式解绑

- [ ] 增加失败测试和最小 API：

```http
DELETE /v1/sessions/:session_id/flow
```

- [ ] 成功调用 `sessionCatalog.unbindFlow`，返回解绑后的 Session。
- [ ] 不存在 Session 返回既有 404 合同。
- [ ] `/messages` 的显式 `flow_id: null` 可复用同一 `unbindFlow` use case 作为兼容合同；不能自行实现另一套清空逻辑。

### Task 3.4：Candidate 与 Review 合同收口

- [ ] `POST /v1/flows/candidates` 缺省 `kind` 改为 `runbook`。
- [ ] 显式传 `guide` 或 `ephemeral` 返回 400 `invalid_flow_state`，不能创建非法 candidate。
- [ ] Review 批准前验证目标是 Candidate Runbook。
- [ ] 保留 `git_revision`，明确只作为审批 provenance/audit 字段；Runtime 版本身份仍是 `definitionRevision` 和 `planIrHash`。
- [ ] 运行：

```bash
pnpm vitest run apps/bridge/src/flow-api.test.ts apps/bridge/src/session-api.test.ts
```

**验收：** 管理、消费、绑定、执行四个概念不再混用；apply/unbind 是唯一持久绑定写操作。

---

## 4. Runtime 统一解析一次调用与已绑定调用

**Files**

- Create: `apps/bridge/src/flow-invocation.ts`
- Create: `apps/bridge/src/flow-invocation.test.ts`
- Modify: `apps/bridge/src/session-runtime-api.ts`
- Modify: `apps/bridge/src/session-runtime-api.test.ts`
- Modify: `apps/bridge/src/session-api.ts`（legacy messages/runs）
- Modify: `apps/bridge/src/session-api.test.ts`

### Task 4.1：先隔离纯解析器

- [ ] 重新运行 `registerSessionRuntimeCommandRoutes` upstream impact。其已知风险为 HIGH，向用户报告本次直接调用方和受影响流程后再编辑。
- [ ] 为避免在高风险 route 中堆条件，新建纯函数：

```ts
type FlowInvocationSource = "request" | "binding";

type ResolveFlowInvocationInput = {
  origin: "web" | "channel";
  hasFlowId: boolean;
  requestedFlowId: string | null | undefined;
  requestedDefinitionRevision: string | undefined;
  binding: {
    flowId: string;
    definitionRevision: string;
  } | null;
  dryRun: boolean;
  getFlow(flowId: string): FlowRecord | null;
};
```

- [ ] 解析结果只返回以下之一：
  - `none`：本轮普通 Agent。
  - `unbind`：显式 null，调用方持久解绑，本轮不执行 Flow。
  - `flow`：包含 Flow、source、resolved revision。
  - typed error：HTTP status、code、details。

### Task 4.2：用表驱动测试锁合同

- [ ] 至少覆盖下表：

| 输入 | 结果 |
| --- | --- |
| Web + 字段不存在 + 无 binding | `none` |
| Web + 字段不存在 + 有完整 binding | 按 binding 执行 |
| Channel + 字段不存在 + 有历史 binding | `none`，普通 Agent，不继承 |
| `flow_id: null` | `unbind`，不继承 |
| 显式 Published Runbook + 正确 revision | 一次执行，source=request |
| 显式 Candidate Runbook + dry-run | 允许 |
| 显式 Candidate Runbook + live | 409 `flow_not_executable` |
| Guide + 任意 dry-run/live | 409，不回落 Agent |
| Published Runbook + 错 revision | 409 `flow_revision_mismatch` |
| binding revision 与当前 Flow 不同 | 409 `flow_revision_mismatch` |
| 显式请求省略 revision 的旧客户端 | 按当前 Published 解析 |
| Candidate dry-run 省略 revision | 按当前 Candidate 解析 |

- [ ] revision mismatch error 固定包含：

```json
{
  "code": "flow_revision_mismatch",
  "source": "request",
  "flow_id": "flow_demo",
  "expected_definition_revision": "sha256:old",
  "current_definition_revision": "sha256:new",
  "requires_confirmation": true
}
```

- [ ] binding 失配时 `source` 为 `binding`；返回 409，不编译、不创建 Run、不升级绑定、不回落 Agent。
- [ ] 运行确认失败后，实现纯函数直至通过：

```bash
pnpm vitest run apps/bridge/src/flow-invocation.test.ts
```

### Task 4.3：接入主 `/messages` 路径

- [ ] 消息 body 增加可选 `definition_revision`。
- [ ] 使用 `Object.hasOwn(body, "flow_id")` 区分 absent 与 null，不能通过 `asNullableString` 丢失字段存在性。
- [ ] Runtime 必须从受信调用路径获得 `origin`：Web `/messages` 为 `web`；Coordinator 的 channel 转发为 `channel`。不要允许普通客户端靠伪造 `actorRef` 改变继承规则。
- [ ] 只有 `origin=web` 且字段不存在时可以继承 Session binding；`origin=channel` 且字段不存在时始终是普通 Agent，即使数据库残留旧 binding。
- [ ] 删除 `persistedSessionFlowId`；显式非 null Flow 调用成功也不得写 Session binding。
- [ ] 只有解析结果 `unbind` 时调用统一 `unbindFlow`。
- [ ] `flow` 结果必须在 Agent dispatch 前完成 policy 和 revision 校验。任何 Flow 合同错误都直接返回，不能进入 Agent。
- [ ] 保留现有执行冻结：`frozenPlan`、`definitionHash`、`planIrHash` 漂移校验；不要重复实现第二套执行冻结。
- [ ] 修改旧测试“Published live run 会绑定”为“Published live run 是 one-shot，原 binding 不变”。
- [ ] 增加测试：显式调用 Flow A 时 Session 已绑定 Flow B，本轮运行 A，结束后仍绑定 B+原 revision。

### Task 4.4：收口 legacy `/messages` 和 `/runs`

- [ ] 两条 legacy 路径都复用相同解析器或同一 use case。
- [ ] 删除它们成功后通过 `updateSession({ flowId })` 的隐式绑定写入。
- [ ] Guide、Candidate live、revision mismatch 的错误码与主 Runtime route 一致。
- [ ] 执行高风险回归：

```bash
pnpm vitest run \
  apps/bridge/src/flow-invocation.test.ts \
  apps/bridge/src/session-runtime-api.test.ts \
  apps/bridge/src/session-api.test.ts \
  apps/bridge/src/flow-api.test.ts
```

**验收：** `/messages` 是一次调用入口；apply/unbind 是绑定入口；任何不合法 Flow 都不会伪装成普通 Agent 聊天。

---

## 5. 通道合同保留字段存在性并携带 revision

**Files**

- Modify: `packages/core/src/types.ts`
- Modify: `apps/bridge/src/channel-ingress.ts`
- Modify: `apps/bridge/src/channel-ingress.test.ts`
- Modify: `apps/bridge/src/session-api.ts`
- Modify: `apps/bridge/src/session-api.test.ts`
- Modify: `packages/channel-feishu/src/bridge.ts`
- Modify: `packages/channel-telegram/src/telegram-bridge.ts`
- Modify: relevant channel tests

### Task 5.1：扩展共享消息类型

- [ ] 给 `ChannelSessionMessage` 增加：

```ts
flowId?: string;
flowDefinitionRevision?: string;
actorRef?: { channel: "feishu" | "telegram"; id: string };
```

- [ ] `ChannelSessionIngress.submitMessage` 只在值存在时序列化：

```ts
{
  text: message.text,
  ...(message.flowId !== undefined ? { flow_id: message.flowId } : {}),
  ...(message.flowDefinitionRevision !== undefined
    ? { definition_revision: message.flowDefinitionRevision }
    : {}),
}
```

- [ ] 普通通道消息必须省略两个 Flow 字段；不能发送 null。
- [ ] Flow invocation 必须两个字段同时存在。Ingress 对“只有 flowId 没 revision”返回客户端错误，兼容缺 revision 只允许旧 Web，不开放给通道。
- [ ] 给 `ChannelSessionIngress` 增加固定语义的方法，不能把原始 `view` 参数暴露给通道适配器：

```ts
listConsumableFlows(): Promise<Array<{
  flowId: string;
  name: string;
  definitionRevision: string;
}>>;
```

- [ ] `createChannelSessionIngress` 的实现固定请求 `/v1/flows?view=consume`。测试必须断言 URL 含 `view=consume`，且返回值中没有 Guide、Candidate、Deprecated。

### Task 5.2：修复 Coordinator 转换点

- [ ] 通道 API 转发 body 时使用 `Object.hasOwn`，不能无条件执行 `asNullableString(undefined)`。
- [ ] 不全局修改 `asNullableString`；它在其他路由仍可能需要 absent→null。只在 Flow 字段的边界保存字段存在性。
- [ ] Coordinator 转发到 Runtime 时设置受信 `origin=channel`；直接 Web `/messages` 使用 `origin=web`。来源字段由 Bridge 路由生成，不接受通道消息正文覆盖。
- [ ] 测试：
  - 普通飞书/Telegram 载荷转发后没有 `flow_id` 键。
  - 普通通道消息即使对应 Session 残留旧 binding，也不继承 Flow、仍走 Agent。
  - Flow invocation 转发完整 `flow_id + definition_revision`。
  - 显式 null 只可能来自 Web unbind 合同。

### Task 5.3：通道只传身份与选择，不复制领域规则

- [ ] Feishu 从现有 `senderId` 填 `actorRef`；Telegram 从 update 的 `senderId` 填 `actorRef`。
- [ ] 不在通道包检查 published/runbook、revision、capability；这些全部由 Bridge policy/runtime 处理。
- [ ] 当前 P0A 只打通 ingress 类型和测试。列 Flow、选择、确认、补参 UI 留给后续通道实现计划。
- [ ] 运行：

```bash
pnpm vitest run \
  apps/bridge/src/channel-ingress.test.ts \
  apps/bridge/src/session-api.test.ts \
  packages/channel-feishu/src \
  packages/channel-telegram/src
```

---

## 6. Web 适配一次调用与显式绑定

**Files**

- Modify: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/components/workbench.tsx`
- Modify: `apps/web/src/components/session-chrome.tsx`
- Modify: `apps/web/src/components/composer-controls.tsx`
- Modify: `apps/web/src/lib/api.test.ts`
- Modify: `apps/web/src/components/flow-detail.test.tsx`
- Modify: `apps/web/src/components/session-chrome.test.tsx`
- Modify: `apps/web/src/components/composer.test.tsx`
- Modify: `apps/web/src/components/workbench-component-policy.test.ts`

### Task 6.1：API 类型明确 absent/null/value

- [ ] 对 `sendMessage`、`Workbench` 运行 upstream impact。
- [ ] `SendMessageInput` 改为：

```ts
flowId?: string | null;
definitionRevision?: string;
```

- [ ] `sendMessage` 只在属性存在时序列化 `flow_id`；revision 同理。
- [ ] 增加 API 方法：

```ts
listFlows("manage" | "consume")
applyFlow(sessionId, flowId)
unbindFlow(sessionId)
```

- [ ] `AgentSession` 增加 `flow_definition_revision`。
- [ ] 扩展 `ErrorPayload`，保留 revision mismatch 的结构化字段，不能只压成错误字符串：

```ts
type ErrorPayload = {
  error?: string;
  code?: string;
  detail?: string;
  details?: string;
  message?: string;
  issues?: string[];
  missing?: Array<{ id: string; type: string; source: string; reason: string }>;
  source?: "binding" | "request";
  flow_id?: string;
  expected_definition_revision?: string;
  current_definition_revision?: string;
  requires_confirmation?: boolean;
} | null;
```

- [ ] `request()` 构造 `ApiError` 时使用 `payload?.code ?? payload?.error ?? "http_error"`；测试 409 后 `ApiError.code === "flow_revision_mismatch"` 且 `ApiError.body` 保留全部 revision 字段。

### Task 6.2：管理列表与消费列表分开

- [ ] Flow 管理目录/侧栏显式调用 `view=manage`，可看 Guide Draft、Runbook Draft、Candidate、Published 和 Deprecated；至少保留现有 Candidate 分组和详情入口。
- [ ] Candidate Runbook 在 P0A 期间必须始终能从 Web 管理目录进入，并保留 Dry-run；不能因为消费列表收紧而隐藏到 P1 才恢复。
- [ ] Composer 消费选择器显式调用 `view=consume`，只显示 Published Runbook。
- [ ] 删除 UI 中只按 `status === "published"` 的本地业务判断；服务端是权威，UI 可用共享类型做展示保护，但不能重新定义 policy。
- [ ] 所有第一方 Web 请求改为显式 `view=manage|consume` 后，将 Bridge 缺省 view 切为 `consume`，运行 Task 3.1 的无 view 回归测试。
- [ ] 将 Task 3 的迁移测试改为最终测试：`GET /v1/flows` 缺少 `view` 时只返回 Published Runbook。P0A 完成后不存在缺省为 manage 的生产窗口。

### Task 6.3：绑定、解绑和 one-shot 行为

- [ ] 拆开 Web 本地状态：`boundFlowId/boundDefinitionRevision` 来自 Session；`pendingFlowId/pendingDefinitionRevision` 只表示下一次 one-shot。不得继续用一个 `flowId` 同时表达“查看中”“待运行”和“已绑定”。
- [ ] 侧栏点击任意 Flow 只选中并展开 `FlowDetail`，不运行、不 apply、不修改 Session binding。
- [ ] Published Runbook 详情提供两个明确动作：
  - **运行一次**：调用 `/messages`，显式发送 `flow_id + definition_revision`，成功后不改变 binding。
  - **绑定到会话**：立即调用 apply，成功后用响应更新 `boundFlowId + boundDefinitionRevision`。
- [ ] Candidate Runbook 详情只提供 **Dry-run 预演**；不显示“运行一次”和“绑定到会话”。Guide Draft、Runbook Draft、Deprecated 只查看/管理，不提供 Run 动作。
- [ ] Composer 的 Flow 选择器只设置下一条消息的 `pendingFlowId + pendingDefinitionRevision`；发送被接受后清空 pending。选择“自动”表示不发显式 Flow 字段：有 Web binding 时继承 binding，没有 binding 时走 Agent。
- [ ] 用户解绑时调用 DELETE unbind；不能只 `setFlowId("")`。
- [ ] 已绑定 Web 会话的普通消息省略 Flow 字段，由后端继承 binding。
- [ ] Candidate Dry-run、未绑定的 Published Runbook 运行使用显式 `flow_id + definition_revision`，只跑一次。
- [ ] explicit Flow 请求失败时保留当前 binding，不在前端猜测或改写。
- [ ] 当 `409 flow_revision_mismatch` 且 `source=binding` 时显示阻断提示“Flow 已更新，请确认后重新绑定”，并提供：
  - **查看最新版本**：打开响应 `flow_id` 的当前详情；
  - **重新绑定**：用户点击后以 `current_definition_revision` 对应的当前 Published Runbook 调 apply；
  - **解绑**：调用统一 unbind，随后普通消息恢复 Agent。
- [ ] revision mismatch 提示不能自动重试、自动 apply 或静默替换 binding。
- [ ] 回归：
  - 普通闲聊无 binding → Agent。
  - apply 后普通消息 → 已绑定 Runbook。
  - one-shot A 不覆盖已绑定 B。
  - unbind 后普通消息 → Agent。
  - 侧栏点击 Published 只打开详情，直到用户点“运行一次”或“绑定到会话”才发生写操作。
  - Candidate 在管理目录可见且只能 Dry-run。
  - binding revision 失配 → 显示结构化提示；用户可重新绑定或解绑，不会无限重复发送失败消息。
  - Guide 不出现在消费选择器。
- [ ] 运行 Web 现有测试及类型检查：

```bash
pnpm --filter @codebridge/web test
pnpm --filter @codebridge/web lint
```

若 package 无独立 script，改跑：

```bash
pnpm vitest run apps/web
pnpm lint
```

---

## 7. 本机 actor 映射与审计

**Files**

- Modify: `packages/work-items/src/session-runtime.ts`
- Modify: corresponding work-items tests
- Modify: `packages/session-coordinator/src/coordinator.ts`
- Modify: corresponding coordinator tests
- Modify: `apps/bridge/src/session-runtime-api.ts`
- Modify: `apps/bridge/src/session-runtime-api.test.ts`

### Task 7.1：审计身份，不建设 Flow ACL

- [ ] 对 `SessionTurnMessage`、`SubmitTurnInput` 和对应提交函数运行 upstream impact。
- [ ] 将 `actorRef` 从 channel ingress 传到 turn message，结构固定为：

```ts
type FlowActorRef = {
  channel: "web" | "feishu" | "telegram";
  id: string;
};
```

- [ ] Web 本机用户使用稳定 actor，例如 `{ channel: "web", id: "local" }`。
- [ ] Feishu/Telegram 使用平台 sender id；日志和事件遵循项目既有脱敏规则，不额外输出 token/profile。
- [ ] `MESSAGE_RECEIVED` / `TURN_QUEUED` 或现有最合适的审计 payload 保存 actor reference 和 invocation source。
- [ ] Flow 权限仍走实例 allowlist、现有 capability/adapter authorization 和 Runtime approval；不新增 per-Flow user ACL 表。
- [ ] 测试一次 Web Flow 调用和一次 channel Flow 调用，断言审计能区分 actor/channel，但执行规则完全相同。

---

## 8. P0A 集成验证与交付

### Task 8.1：静态残留扫描

- [ ] 扫描并消除生产代码中的分叉规则：

```bash
rg 'status === "published"|status !== "published"|kind === "runbook"|kind !== "runbook"' \
  apps packages \
  -g '*.ts' -g '*.tsx'
```

允许存在的位置：`packages/flow-catalog/src/policy.ts`、纯展示角标、测试断言。其他业务判断必须说明为何不能调用 policy。

- [ ] 扫描隐式绑定写：

```bash
rg 'updateSession\([^\n]*flowId|persistedSessionFlowId|setFlowId\(""\)' apps packages
```

Expected: 无生产调用通过通用 update 写 binding；无 `persistedSessionFlowId`；Web 无假解绑。

- [ ] 扫描消息合同：

```bash
rg 'flow_id|definition_revision|flowDefinitionRevision' \
  apps/bridge/src apps/web/src packages/channel-feishu packages/channel-telegram packages/core
```

人工确认：通道 invocation 成对传输 ID+revision；普通消息省略；Web unbind 使用专用 use case。

### Task 8.2：测试矩阵

- [ ] 领域与存储：

```bash
pnpm vitest run \
  packages/flow-catalog/src/policy.test.ts \
  packages/flow-catalog/src/index.test.ts \
  packages/session-catalog/src/index.test.ts
```

- [ ] Bridge 高风险路径：

```bash
pnpm vitest run \
  apps/bridge/src/flow-api.test.ts \
  apps/bridge/src/flow-invocation.test.ts \
  apps/bridge/src/session-runtime-api.test.ts \
  apps/bridge/src/session-api.test.ts \
  apps/bridge/src/channel-ingress.test.ts
```

- [ ] 全量：

```bash
pnpm test
pnpm lint
pnpm build
```

- [ ] 若现有 E2E 环境可用，至少验证：Web apply → 普通消息执行、one-shot 不改 binding、unbind 回 Agent。

### Task 8.3：GitNexus 与交付说明

- [ ] 运行 `gitnexus_detect_changes()`，确认只影响预期符号和流程。
- [ ] 如果出现未在计划中的执行流程，停止提交并补 impact 分析。
- [ ] `git diff --check`。
- [ ] `git status --short`，只暂存本计划涉及文件；忽略工作区既有未跟踪文件和用户改动。
- [ ] 未经用户要求不自动 commit。需要提交时按 PR 划分小提交，不把 P0B/P1 混入。

---

## 9. P0A 完成定义

全部满足才算完成：

- [ ] Catalog 不再接受非法 `kind × status` 新写入。
- [ ] 所有管理、消费、绑定、执行、Dry-run 判断来自五个统一谓词。
- [ ] Session binding 原子保存 `flowId + definitionRevision`。
- [ ] apply/unbind 是唯一持久绑定写操作。
- [ ] `/messages` 显式 Flow 是 one-shot，不改变 binding。
- [ ] absent/null/value 三态在 Web、Bridge、Channel Ingress 之间保持一致。
- [ ] absent 继承只对 Web 生效；Channel absent 即使存在历史 binding 也不会执行 Flow。
- [ ] Guide、非法状态、revision mismatch 不会回落 Agent。
- [ ] 飞书/Telegram 所需的显式 `flow_id + definition_revision` 合同已就绪，普通消息不依赖隐式 Flow binding。
- [ ] P0A 只验收通道共用 API、固定 `view=consume` client 和 invocation 传输合同；不验收聊天内列表卡、补参卡或完整运行结果回流。
- [ ] Web Candidate 管理入口和 Dry-run 未因消费列表收紧而退化。
- [ ] revision mismatch 错误体使用 `flow_id`、`expected_definition_revision`、`current_definition_revision`，Web 能提示重新绑定或解绑。
- [ ] actor 能映射到 Web/飞书/Telegram 审计身份，不引入 Flow ACL。
- [ ] Runtime 既有 frozen plan/hash 门禁保持不变。
- [ ] 全量测试、lint、build 和 GitNexus change detection 通过。

## 10. 后续计划边界

P0A 合入后再分别编写：

1. **P0B — 三表面结构化结果回流：** Web 当前 `SessionTimeline` 完成 Runtime approval 卡片、现有 approve/reject API 接入和 granted/rejected 终态闭合；飞书/Telegram watcher 只读展示 Runtime approval，并消费 Run snapshot、step success/failure、artifact 和 verification。三个表面保持 Bridge 领域事件为唯一来源；通道“前往 Web”提示不得早于 Web 可操作入口交付。实施依据见 [2026-08-21-flow-p0b-structured-return-design.md](../specs/2026-08-21-flow-p0b-structured-return-design.md)。
2. **P1 — Web 创作与审查闭环：** 成功 Run → Candidate（必须有 provenance/lineage）→ Dry-run → Review → Published；届时再决定 lineage 使用同一 `flow_id` 还是 parent 指针。
3. **P1 Channel UI — 飞书/Telegram 消费交互：** `view=consume` 列表、选择、补参、确认、显式 invocation。只实现 adapter 和权限映射，不复制 Catalog/Review/Runtime 逻辑。
