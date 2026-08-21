# Flow 产品定义与 Web / 飞书 / Telegram V1 最终对齐

- Status: Accepted for implementation
- Date: 2026-08-20
- Review target: 产品定义、三通道边界、V1 范围与现状缺口
- Scope: 本文定义目标产品，不以当前实现偶然行为代替产品语义
- Related draft: `docs/superpowers/specs/2026-08-20-flow-product-loop-design.md`

本文用于统一 Flow 的产品定义、Web / 飞书 / Telegram 三个入口的职责，以及 V1 的实现边界。若旧设计稿、交互或代码行为与本文冲突，以本文为准；实现前再同步更新被覆盖的旧规范。

---

## 0. 规范优先级与旧口径作废

本文是 Flow 三通道 V1 的产品北极星，并明确覆盖以下旧口径：

- `docs/orchestration/flow-design.md` 中 Guide 与 Runbook 作为长期并存、都可面向用户使用的产品语义作废；Guide 在本文中只允许作为草稿。
- `docs/orchestration/architecture.md` 中 `ephemeral | guide | runbook` 仍可作为历史类型或实现字段参考，但 `ephemeral` 不属于 Catalog 生命周期，也不是用户产品态。
- `docs/superpowers/specs/2026-08-20-flow-product-loop-design.md` 中 `/flow` 列出或绑定 Published Guide、飞书/Telegram 通过长期绑定运行、显式 `flow_id` 自动写 Session binding 等决定作废。
- “对话内不做参数表单”仅约束普通 Agent 闲聊；飞书/Telegram 的 Flow 消费向导可以使用卡片、命令或逐项追问采集运行参数，这不是普通聊天表单。

旧文档可以保留作历史设计记录，但不得作为 V1 实现依据；实现计划只能引用本文的合法状态、谓词和 API 语义。

---

## 1. Flow 是什么

Flow 是一份由用户确认、经过校验和版本管理，并由 Runtime 确定性执行的可复用任务定义。

它负责把一次已经验证可行的处理过程，沉淀成可以反复调用的标准任务。Flow 至少应包含：

- 明确的输入参数；
- 可执行步骤和依赖关系；
- Capability、Adapter 等执行约束；
- 风险等级和审批要求；
- `success_when` 验收条件；
- 版本、来源和变更记录；
- Runtime 执行所需的冻结计划。

Flow 不是：

- Agent 在一次对话中生成的临时 plan；
- 一段 Prompt 模板；
- 普通聊天的别名；
- 各通道分别实现的一套自动化；
- 让 Agent 绕过 Runtime 直接执行工具的机制；
- V1 要建设的通用 DAG 编辑平台。

一句话定义：

> Flow 是可以从 Web、飞书和 Telegram 调用，由 Runtime 按同一规则安全执行的、可审查且可版本化的标准任务。

---

## 2. 产品目标

Flow 要解决三个核心问题：

1. 将成功完成过的任务稳定沉淀并复用；
2. 让用户在 Web、飞书和 Telegram 都能发现和使用这些任务；
3. 用户确认执行意图，Runtime 负责权限、风险、步骤和结果验收。

终局闭环是（不是 V1 每一步都必须实现）：

```text
一次任务成功
→ 整理为 Guide 草稿
→ 补齐为 Runbook Draft
→ 提交为 Candidate Runbook
→ Dry-run
→ 人工审查
→ 发布
→ 三个通道发现并使用
→ Runtime 执行
→ 结果返回原通道
→ 根据运行证据迭代新版本
```

V1 不要求一次完成所有自动化。V1 先解决：

- Web 能发现、管理、审查、发布和使用 Flow；
- 飞书和 Telegram 能列出并使用 Flow；
- 三个通道使用同一个 Flow 后端和 Runtime；
- 执行进度和结果能够回到发起通道。

Guide 不是 V1 必经站。V1 的最小沉淀路径允许：

```text
成功的 Runbook Run
→ 生成 Candidate Runbook
→ Dry-run
→ 审查发布
```

自由创建 Guide、从闲聊建议保存、根据运行证据自动迭代新版本属于 P2，不阻塞 V1。

---

## 3. 产品形态定案

### 3.1 Published Runbook 是唯一一等 Flow

面向三通道消费列表可用、可绑定、可正式执行的 Flow，只能是：

```text
kind = runbook
status = published
```

“Web 管理端可见”和“三通道可调用”是两种不同能力，必须使用不同谓词：

```text
isManageable   = 合法的 Catalog 产品态（仅 Web 控制面）
isConsumable   = kind == runbook && status == published
isBindable     = kind == runbook && status == published
isExecutable   = kind == runbook && status == published
isDryRunnable  = kind == runbook && status in {candidate, published}
```

禁止继续使用含义不清的 `discoverable` 同时表示管理可见和消费可用。飞书、Telegram 和 Web 的“可使用”列表只使用 `isConsumable`；Web 管理列表使用 `isManageable`。

Candidate Runbook 只能编辑、校验、Dry-run 和送审，不能正式绑定或执行。

Deprecated Runbook 不能新增绑定或发起新 Run，但不影响已经开始的历史 Run，也必须保留历史证据。

### 3.2 Guide 是创作草稿，不是可执行 Flow

Guide 用于 Web 中整理任务说明、补充步骤和准备 Runbook。

Guide：

- 不进入飞书和 Telegram 的 Flow 列表；
- 不进入 Web 的“可使用 Flow”列表；
- 不可绑定；
- 不可正式执行；
- 不可作为最终发布形态；
- 可以继续编辑；
- 可以被补齐并转换为 Runbook Draft，再提交为 Candidate Runbook。

当前实现中 Guide 可以 published、进入可绑定列表，但 Runtime 又不执行 Guide。这是语义冲突，不是已经闭合的产品设计。

### 3.3 成熟度和生命周期是两条不同的轴

`kind` 表示定义成熟度：

```text
guide → runbook
```

`status` 表示生命周期：

```text
draft → candidate → published → deprecated
```

不是所有 `kind × status` 组合都合法。合法组合必须写死为：

| Kind / Status | Draft | Candidate | Published | Deprecated |
| --- | ---: | ---: | ---: | ---: |
| Guide | 合法 | 非法 | 非法 | 非法 |
| Runbook | 合法 | 合法 | 合法 | 合法 |

对应产品状态和能力为：

| 产品状态 | 作用 | Web 管理可见 | 三端消费可用 | Dry-run | 可审查 | 可绑定/正式执行 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Guide Draft | 创作和整理 | 是 | 否 | 否 | 否 | 否 |
| Runbook Draft | 补齐确定性定义 | 是 | 否 | 否 | 否 | 否 |
| Candidate Runbook | 校验和送审 | 是 | 否 | 是 | 是 | 否 |
| Published Runbook | 正式使用 | 是 | 是 | 是 | 已通过 | 是 |
| Deprecated Runbook | 历史和审计 | 是 | 否 | 否 | 否 | 否 |

正确演进关系是：

```text
Guide Draft
→ Runbook Draft
→ Candidate Runbook
→ Published Runbook
→ Deprecated Runbook
```

`Guide Draft → Runbook Draft` 要补齐结构化 inputs、steps、Capability、Adapter 和 `success_when`；`Runbook Draft → Candidate Runbook` 要通过 Candidate 校验并生成 `definitionRevision`。转换必须保持同一逻辑 Flow lineage 和 provenance：实现可以更新同一 Catalog 记录，也可以创建同一 Flow 下的新 revision，但不能创建没有来源关系的无关 Flow。若 Guide 已完整，应用层命令可以原子完成前两个转换。

`ephemeral` 不能被描述成当前已实现的生命周期阶段。当前 `flow_ephemeral_*` 只是运行期标识或事件，没有进入 Catalog，也没有 promote、provenance 等完整能力。

---

## 4. 三个入口的定位

### 4.1 Web：Flow 控制面

V1 中，Web 是完整的管理和使用入口，但不建设通用工作流编辑器。

V1 必须具备：

- 查看、搜索和筛选所有 `isManageable` 状态；
- 区分 Guide Draft、Runbook Draft、Candidate、Published 和 Deprecated；
- 从最近一次成功且可固化的 Runbook Run 生成 Candidate Runbook；
- 通过结构化属性表单和有序步骤列表修改名称、说明、inputs、Capability/Adapter 映射、风险和 `success_when`；
- 校验和 Dry-run；
- 查看语义 Diff、provenance 和运行证据；
- 提交审查；
- 批准和打回；
- 发布和废弃；
- 查看版本及审计记录；
- 选择 Published Runbook；
- 填写参数并运行；
- 查看进度、审批、结果和失败原因；
- 在保留会话绑定时，提供明确的查看、切换和解绑入口。

V1 不提供自由画布、任意分支/循环编排或完整 Guide 创作器。自由创建 Guide、从零逐步编辑 Runbook、导入高级定义可以作为 P2；V1 的结构化编辑只服务“成功 Run → Candidate → Review”主路径。

Web 是完整客户端，但不是 Flow 领域能力的所有者。

### 4.2 飞书：Flow 消费端

V1 只要求：

- 列出当前 actor 可消费的 Published Runbook；
- 搜索或翻页；
- 查看简介、输入要求和风险说明；
- 选择一个 Flow；
- 填写或确认参数；
- 明确确认执行；
- 查看运行进度；
- 处理必要的 Runtime step approval；
- 取消运行；
- 接收成功结果、产物或结构化失败信息。

V1 不要求飞书创建、编辑、审查和发布 Flow。

### 4.3 Telegram：Flow 消费端

Telegram V1 与飞书保持同一产品能力：

- 列出当前 actor 可消费的 Published Runbook；
- 查看详情；
- 选择和填写参数；
- 确认运行；
- 查看进度；
- 处理必要审批；
- 取消运行；
- 接收结果。

交互可以使用命令和 Inline Keyboard，但背后的业务接口必须与 Web、飞书一致。

### 4.4 V1 身份、权限和审计范围

CodeBridge V1 按本机单用户工具设计，不引入按用户或群组配置的 Flow ACL。

- Catalog 的 `isConsumable` 列表对通过实例级入口校验的本机 actor 全量可见。
- Web 用户、飞书 `open_id` 和 Telegram `user_id` 统一映射为 `actor`，用于审计、Runtime step approval 和既有 Capability 授权。
- “有权使用”仅表示 actor 通过实例级 allowlist/通道接入校验，并通过 Runtime 既有 Capability 授权；不表示 V1 新增 Flow 级 ACL。
- 后续增加多用户 Flow ACL 时，只扩展 Bridge 的统一授权策略，不在各通道复制权限规则。

---

## 5. 三通道如何复用能力

三端复用的不是 Web 页面，而是 Web 背后的 Bridge Flow API 和领域服务。

```text
Web 页面 ───────────┐
飞书命令/卡片 ──────┼──> Bridge Flow API / Application Service
Telegram 命令/按钮 ─┘                  │
                                       ├── Flow Catalog
                                       ├── Authorization / Audit
                                       └── Runtime
```

三端共同复用：

- Flow 查询和详情；
- 生命周期规则；
- Candidate 校验；
- Dry-run；
- Definition Review；
- 发布和废弃；
- 权限判断；
- Run 创建；
- Runtime 风险控制；
- 结果和审计模型。

通道单独实现的只有：

- 命令、页面、卡片和按钮；
- 参数采集方式；
- 回调适配；
- 消息格式；
- 用户身份映射；
- 通道能力限制。

V1 中的 Authorization 仅包含实例级入口校验、actor 映射、既有 Capability 授权和审计，不包含新建 Flow ACL 系统。

后续飞书和 Telegram 增加管理能力时，应继续复用 Web 已接入的 Bridge Flow API 和统一领域服务，只新增该通道的命令、卡片、回调及身份权限映射，不重新实现 Flow 生命周期和业务规则。

例如未来飞书增加“批准发布”：

```text
飞书批准按钮
→ 将飞书用户映射为统一 actor
→ 调用统一权限检查
→ 调用与 Web 相同的 Review 用例/API
→ 将结果渲染为飞书卡片
```

不应该出现三套业务实现：

```text
webApproveFlow()
feishuApproveFlow()
telegramApproveFlow()
```

API 从一开始就应定义为“通道无关的 Flow API”，而不是“Web 专用接口”。

---

## 6. V1 使用方式

### 6.1 Web

Web 可以支持两种使用方式：

1. 从 Flow 目录选择后直接运行；
2. 将 Published Runbook 绑定到会话，后续在该会话中使用。

两种方式使用不同应用用例：

- **仅运行一次**：`/messages` 显式携带 `flow_id + definition_revision`，只创建本次 Run，不修改 Session binding。
- **持久绑定**：只有 `apply` 可以写入 `flowId + definitionRevision`；只有显式 unbind 可以清除。绑定后的 Web 消息省略 `flow_id` 才继承 Session binding。

如果保留会话绑定，绑定和运行不能只依赖一个可变的 `flowId`。需要区分两层：

- **绑定层（本轮缺失）**：Session 绑定至少固定 `flowId + definitionRevision`，不能只存 `flowId`。
- **执行层（Runtime 已有，不重复建设）**：每次 Run 执行时冻结 `planIrHash` 与执行计划快照（`plan_ir_drift` 门禁）。

否则 Flow 更新后，同一个会话可能在用户不知情时执行不同版本（版本语义见 §6.3）。

### 6.2 飞书和 Telegram

V1 优先采用“一次选择、一次确认、一次执行”，不依赖隐式长期绑定：

```text
列出 Flow
→ 选择 Published Runbook
→ 补充参数
→ 确认
→ 创建 Run
→ Runtime 执行
→ 返回结果
```

飞书和 Telegram V1 不调用 `apply`，也不创建持久 Session binding。每次 **Flow invocation** 都显式携带 `flow_id + definition_revision`，只运行一次且不得改写 binding；普通 Agent 消息不携带 Flow 字段。渠道 Session 在 V1 应保持未绑定，因此不会触发 Session 继承。

字段省略时继承 binding 的能力只服务 Web 已显式绑定的会话，不是飞书/Telegram V1 的调用方式。

后续如果增加“设为当前 Flow”，必须明确展示：

- 当前绑定的 Flow；
- 绑定版本；
- 解绑入口；
- 切换确认；
- 下一条消息会进入 Runtime 还是 Agent。

不能让绑定处于用户不可见的隐式状态。

### 6.3 版本语义

V1 不使用 semver，采用三层标识：

- `definitionRevision`：Flow 定义内容哈希，是绑定的**不可变身份**；
- `planIrHash`：编译产物身份，由 Runtime 执行时校验；
- 发布序号：第 N 次发布，仅用于 Web 展示和审计，**不参与执行判定**。

保存关系：

```text
Session binding:
  flowId + definitionRevision

Run snapshot:
  flowId
  + definitionRevision
  + planIrHash
  + frozenPlan
```

绑定后出现新 revision：V1 **不静默升级**。消息处理必须在编译和创建 Run 前比较 `binding.definitionRevision` 与当前 Published Flow 的 `definitionRevision`。失配时不执行、不回落 Agent，返回：

```text
HTTP 409
code: flow_revision_mismatch
source: binding | request
flow_id
expected_definition_revision
current_definition_revision
requires_confirmation: true
```

Web 提示用户查看变更并重新绑定；飞书/Telegram 的显式 invocation 重新打开确认步骤。若旧定义没有版本存储能力，旧绑定不能继续运行。

### 6.4 一次执行、绑定和消息合同

`POST /v1/sessions/:id/messages` 增加可选字段 `definition_revision`：

```json
{
  "flow_id": "flow_xxx",
  "definition_revision": "sha256:..."
}
```

合同规则：

- 显式 `flow_id + definition_revision`：执行一次指定 Published Runbook，不修改 Session binding。
- 显式 `flow_id`、缺少 revision：为兼容旧客户端，按当前 Published revision 解析，并在响应和 Run snapshot 中返回实际 revision；飞书/Telegram V1 不使用此兼容路径。
- 省略 `flow_id`：只允许继承已有 Session binding 及其固定 revision。
- 只传 `definition_revision` 且既没有 `flow_id` 也没有 binding：返回参数错误。
- 显式 revision 与当前 Published revision 不同：返回 `409 flow_revision_mismatch`。
- `flow_id: null`：V1 目标语义是持久化解绑 Session；不表示“仅当前 Turn 绕过 Flow”。
- `/messages` 永远不因显式非空 `flow_id` 写入或替换 Session binding；持久写只允许 `apply` / unbind 用例。

---

## 7. Agent、Bridge 和 Runtime 的边界

### 7.1 Agent

Agent 可以：

- 理解用户意图；
- 帮用户整理 Guide 内容；
- 从上下文建议参数；
- 建议用户使用某个 Published Runbook；
- 提示一次成功任务可以保存；
- 解释运行结果。

Agent 不可以：

- 直接写 Flow Catalog；
- 绕过确认创建 Candidate；
- 自行批准和发布；
- 绕过 Runtime 执行 Runbook；
- 把瞬时 `FLOW_PROPOSED` 当作已保存 Flow。

### 7.2 Bridge

Bridge 是 Flow 应用能力的统一入口，负责：

- 身份和权限；
- Flow 查询；
- Candidate 创建；
- Review 和 Publish；
- Run 创建；
- 幂等控制；
- 审计记录；
- 通道与领域模型转换。

所有写操作都经过 Bridge 的统一用例/API。

### 7.3 Runtime

Runtime 负责：

- 编译和冻结执行计划；
- Capability、Adapter 校验；
- Definition hash 和版本门禁；
- 风险及审批；
- 幂等和重试；
- 步骤执行；
- `success_when` 验收；
- 结构化运行结果。

Runbook 一旦进入运行阶段，执行权属于 Runtime，不属于 Agent 或通道。

---

## 8. 必须区分的三种审批

产品和代码中必须拆开以下三种机制：

1. **Flow Definition Review**

   审查 Candidate Runbook 是否可以发布，包括语义 Diff、provenance、Dry-run 证据和发布版本。

2. **Runtime Step Approval**

   某次 Run 执行到高风险步骤时，需要用户或审批人确认后继续。

3. **Agent Permission**

   普通 Agent 调用工具时的权限确认。

三者拥有不同的对象、状态、权限和审计记录，不能共用一个含糊的 approval 状态。

---

## 9. 当前实现的真实缺口

### 9.1 Guide 存在双重语义

当前表现：

- `FlowKind` 正式包含 Guide；
- Guide 可以 Published；
- Web 会把 Published Guide 展示为可选项；
- Runtime 又不会执行 Guide。

目标必须统一成：

```text
Guide 不可发布、不可绑定、不可执行
Published Runbook 才是用户可用 Flow
```

现状还有一处回落漏洞：`flow?.kind !== "runbook"` 时消息不进入 compile/dry-run 分支，Guide 请求会直接走普通 Agent。Guide 通过 `apply`、`messages` 或 dry-run 请求进入时，必须返回 `flow_not_executable` / `flow_not_bindable`，**不得回落普通 Agent**（实施项见 P0-9）。

### 9.2 `/v1/flows/:flow_id/apply` 存在绑定规则漏洞

现状需要区分两个入口：

- `/v1/sessions/:id/messages` **已阻止** Candidate 正式执行（`flow_not_executable`）和绑定污染（dry-run 不写 Session binding，`persistedSessionFlowId`）。
- `/v1/flows/:flow_id/apply` **仍可**绑定 Candidate / Guide——只拒绝 Deprecated，不区分 status 和 kind。

问题本质是**入口规则不一致**，不是所有入口都没有防护。

统一规则应为：

```text
if status !== published || kind !== runbook
  → flow_not_bindable
```

所有入口必须调用同一个领域规则，不能在 `/messages`、`apply` 和 Web 中分别维护判断。

### 9.3 飞书和 Telegram 当前不会真正继承绑定执行

当前主链路是：

```text
渠道消息没有 flowId
→ ingress 省略 flow_id
→ session-api.ts 的 asNullableString(undefined) 将其转为 null
→ Runtime 收到显式 null
→ 当前 Turn 不加载 Session 中已有 Flow
→ 走普通 Agent
→ Session 中的 flowId 本身仍被保留
```

因此真实现状是：

> Session binding 被保留，但飞书和 Telegram 当前 Turn 会绕过它，不会执行已绑定 Runbook。

这不是单纯缺少“选 Flow UI”，而是执行链路没有真正打通。

V1 采用一次性显式调用时，每次 Run 必须携带所选 Flow 和版本，不能依赖这条有歧义的 Session fallback。

以下是 **V1 目标合同**，不是当前代码已经实现的行为：

| 输入 | 语义 |
| --- | --- |
| 字段不存在 | 继承 Session binding |
| `flow_id: null` | 持久化解绑 Session |
| `flow_id: value` | 使用指定 Published Runbook |

「仅当前 Turn 绕过 Flow」V1 **不支持**；未来需要时使用独立字段或接口。

当前代码中 `persistedSessionFlowId` 使用 `requested ?? current`，显式 `null` 仍会保留 current，尚不能真正解绑。三态丢失发生在 `session-api.ts` 的 `asNullableString`（`undefined → null`）。解析层不能提前把 `undefined` 转成 `null`；实现时在消息 handler 用 `Object.hasOwn(...)` 保留「字段是否存在」，再决定是否调用转换函数（详见 §14.3）。

### 9.4 跨通道结构化结果回流不完整

当前渠道 watcher 只处理部分事件，没有完整消费 Runbook 运行中的：

- Step succeeded；
- Run snapshot；
- Artifact；
- Verification failed；
- Runtime approval；
- 最终结构化结果。

所以飞书和 Telegram 尚未具备完整的“使用 Flow”能力。能发起 Run 不代表产品闭环已经完成。

### 9.5 绑定没有不可变版本语义

- **已有（Runtime）**：编译并冻结执行计划；校验 `planIrHash`（`plan_ir_drift` 门禁）；每次 Run 执行的都是冻结计划。
- **缺失（绑定）**：Session binding 只保存 `flowId`，没有固定 `definitionRevision`。

必须确保绑定层固定 `definitionRevision`（发布新版本不得改变已有会话的执行行为）；执行层的冻结能力不重复建设。版本语义见 §6.3。

当前还缺少运行前 revision 失配校验和统一错误响应。绑定或显式 invocation 的 revision 与当前 Published revision 不一致时，必须在 compile/Run 创建前返回 `409 flow_revision_mismatch`，不得执行、静默升级或回落 Agent。

### 9.6 保存和审查的人入口不完整

已有 Candidate 和 Review API，不代表用户闭环已经成立。目前仍缺：

- Web 从最近一次成功且可固化的 Runbook Run 生成 Candidate；
- Candidate 的结构化属性编辑和提交审查；
- 语义 Diff；
- Dry-run 证据展示；
- 批准和打回 UI；
- 审计信息展示。

完整 Guide 创作器、从零编排 Runbook、日常聊天自动建议保存和飞书/Telegram 管理可以放在 V1 之后。

### 9.7 一次执行和持久绑定仍被混在一起

当前 `/messages` 对显式 Published Flow 的成功请求可能通过 `persistedSessionFlowId` 写入 Session binding。这与飞书/Telegram V1 的 one-shot 产品语义冲突：第一次显式运行会留下长期绑定，后续省略 Flow 的普通消息可能意外继承。

V1 必须拆开应用用例：

- `/messages` 显式 Flow 只创建一次 Run，不写 binding；
- `apply` 是唯一持久绑定入口；
- unbind 是唯一持久解绑入口；
- 飞书/Telegram V1 只使用显式 one-shot，不调用 `apply`；
- Web 只有用户明确选择“绑定到会话”时才调用 `apply`。

---

## 10. V1 优先级

### P0：统一领域规则和执行底座

1. 写死合法 `kind × status` 组合和转换；非法组合在 Catalog 写入边界拒绝。
2. 建立统一的 `isManageable`、`isConsumable`、`isBindable`、`isExecutable`、`isDryRunnable` 规则。
3. 将 Guide 从所有消费列表移除；Guide 经 `apply` / `messages` / dry-run 进入时返回 `flow_not_executable` / `flow_not_bindable`，不得回落普通 Agent。
4. 修复 `apply` 可以绑定 Candidate 或 Guide 的问题，并让 binding 保存 `flowId + definitionRevision`。
5. 修复 `asNullableString(undefined)` 导致字段存在性丢失；用 `Object.hasOwn(...)` 保留省略、null、value 三态。
6. 拆开一次执行与持久绑定：`/messages` 显式 Flow 不得写 binding，持久写只由 `apply` / unbind 完成。
7. `/messages` 支持 `definition_revision`；在 compile/Run 创建前执行 revision 失配校验并返回 `409 flow_revision_mismatch`。
8. 保留 Runtime 已有 `planIrHash + frozenPlan` 执行冻结，不重复建设。
9. 补齐运行事件到原通道的结构化回流。
10. 将 Web、飞书和 Telegram 身份映射为统一 actor 并写审计；复用既有 Capability 授权，不建设 Flow ACL。

### P1：完成三通道 V1 产品

Web：

- 管理全部合法产品态；从成功 Run 生成 Candidate；完成有限结构化编辑、Dry-run、送审、批准、发布、废弃和运行；
- 查看版本、Diff、provenance 和证据；
- 区分“仅运行一次”和“绑定到会话”；Session 真解绑必须调用后端写操作，不能只执行前端 `setFlowId("")`（见 §14.6）。

飞书和 Telegram：

- 列表、搜索和详情；
- 参数补充；
- 明确确认；
- 每次 invocation 显式携带 `flow_id + definition_revision`，不创建持久 binding；
- 运行、进度和取消；
- Runtime step approval；
- 成功结果和结构化失败结果。

### P2：让日常对话自然配合 Flow

- Web 自由创建 Guide、从零逐步编辑 Runbook 或导入高级定义；
- 对话识别可能适用的 Published Runbook；
- 用户确认使用；
- 从对话上下文提取参数；
- 缺失参数追问；
- 成功任务建议保存为 Guide；
- Candidate 可审查提醒；
- Web 深链跳转。

### P3：通道管理能力

后续飞书和 Telegram 可以增加：

- 创建 Guide；
- 修改 Candidate；
- 提交审查；
- 打回；
- 查看变更摘要。

是否允许在通道中批准发布，应根据通道能否完整展示以下信息决定：

- 语义 Diff；
- provenance；
- Dry-run 证据；
- git revision；
- 发布风险。

如果证据展示不完整，就只允许提醒或打回，批准仍进入 Web。

---

## 11. V1 验收标准

### 11.1 Web

- Catalog 拒绝所有非法 `kind × status` 组合；Runbook Draft 和 Guide Draft 均不能 Dry-run；
- 用户可以从最近一次成功且可固化的 Runbook Run 生成 Candidate，并完成 Dry-run、审查和发布；
- Web 管理列表能看到全部合法 Catalog 产品态，消费列表只显示 Published Runbook；
- Candidate 只能 Dry-run，不能绑定或正式运行；
- Published Guide 不再作为合法用户状态出现；
- 用户可以运行 Published Runbook 并查看完整结果；
- 每次运行都能定位到确定的 Flow revision 和 hash。
- “仅运行一次”不改变 binding；“绑定到会话”必须经 `apply`；解绑必须真实写入后端。
- binding 或显式 invocation revision 失配时返回 `409 flow_revision_mismatch`，不执行、不升级、不回落 Agent。

### 11.2 飞书和 Telegram

- 通过实例级入口校验的 actor 可以列出本机 Catalog 中全部 `isConsumable` Runbook；V1 不要求 Flow ACL。
- Candidate、Guide 和 Deprecated 不会出现在可执行列表；
- 用户可以查看说明、补参并明确确认；
- Flow invocation 必须显式发送 `flow_id + definition_revision`，确认后实际进入 Runtime，而不是普通 Agent；
- invocation 不写 Session binding，后续普通消息仍走 Agent；
- 能收到运行进度、必要审批、最终结果、产物和失败分类；
- 重复点击不会创建无法控制的重复 Run；
- 所有操作都有统一 actor 和审计记录。

### 11.3 三通道一致性

同一个 Published Runbook 在三个通道中必须具有一致的：

- 输入定义；
- 权限规则；
- 风险规则；
- 执行计划；
- 版本；
- 验收条件；
- 结果语义。

差异只能存在于交互和展示层。

---

## 12. 明确不作为 V1 阻塞项

- DAG 编辑器；
- 自动推荐飞轮；
- Agent 失败后接管 Runbook 执行；
- Agent 直接写 Flow Catalog；
- 飞书和 Telegram 完整管理 Flow；
- 日常对话中自动保存、自动审查或自动发布；
- Web 完整 Guide 创作器和从零自由编排 Runbook。

这些能力可以后续建设，但不能改变 Published Runbook 是唯一正式执行对象、Bridge 统一领域能力、Runtime 掌握执行权这三个原则。Guide 作为确定性执行器不是延期项，而是永久排除：Guide 必须先升级为 Runbook，之后才由 Runtime 执行 Runbook。

---

## 13. 最终产品结论

Flow 的核心产品不是“做一个 Web 自动化编辑器”，也不是“让 Agent 记住一段流程”。

它的核心是：

> 建立一个由 Web 负责完整管理、由飞书和 Telegram 负责便捷调用、由 Bridge 统一提供领域能力、由 Runtime 确定性执行的可复用任务系统。

V1 定案：

- 唯一一等 Flow 是 Published Runbook；
- Guide 是 Web 创作草稿，不可绑定、不可执行；
- Web 负责管理、审查、发布和使用；V1 创作主路径是成功 Run 生成 Candidate，不建设通用编排台；
- 飞书和 Telegram 负责列出、选择、补参、确认、一次执行和接收结果，不创建持久绑定；
- 三个通道复用同一套 Bridge Flow API 和 Runtime；
- 通道只实现交互、身份和权限适配，不复制 Flow 领域逻辑；
- Agent 可以建议和协助，但不能直接写 Catalog、批准发布或取代 Runtime；
- V1 优先完成确定性选择和执行，自然语言自动识别、保存建议和通道管理后续建设。

---

## 14. Review 修订记录（2026-08-20）

本审查未推翻 §3/§13 的产品方向。修订目标是把「已有 Runtime 能力」和「尚缺的绑定/通道能力」区分清楚，并把版本身份定义明确。以下 6 条为最终修订口径。

### 14.1 执行冻结与绑定固定拆开

（回写至 §6.1、§6.3、§9.5、§10 P0-4/P0-7/P0-8）

- **已有（Runtime）**：编译并冻结执行计划；校验 `planIrHash`（`plan_ir_drift` 门禁）；每次 Run 执行的都是冻结计划。
- **缺失（绑定）**：Session binding 只保存 `flowId`，没有固定 `definitionRevision`。
- 不重复建设 Runtime 冻结能力；本轮补的只是绑定层固定 revision。

### 14.2 apply 缺口精确描述

（回写至 §9.2、§10 P0-2/P0-4）

- `/v1/sessions/:id/messages` 已阻止 Candidate 正式执行（`flow_not_executable`）和绑定污染（dry-run 不写 binding）。
- `/v1/flows/:flow_id/apply` 仍可绑定 Candidate / Guide（只拒绝 Deprecated）。
- 问题本质是**入口规则不一致**，不是所有入口都没有防护。
- 收敛目标：统一 `isBindable` 领域规则（`status === "published" && kind === "runbook"`），所有入口调用同一规则，不在 `/messages`、`apply`、Web 分别维护判断。

### 14.3 渠道三态转换点

（回写至 §9.3、§10 P0-5）

明确点名三态丢失位置：`session-api.ts` 的 `asNullableString`（`undefined → null`）。

以下是 V1 目标字段语义，不代表当前代码已经实现：

| 输入 | 语义 |
| --- | --- |
| 字段不存在 | 继承 Session binding |
| `flow_id: null` | 持久化解绑 Session |
| `flow_id: value` | 使用指定 Published Runbook |

「仅当前 Turn 绕过 Flow」V1 不支持；未来需要时使用独立字段或接口。

实现层注意点：**不预先规定全局修改 `asNullableString`**——它可能被其他接口复用。更稳妥的是在消息 handler 用 `Object.hasOwn(...)` 保留「字段是否存在」，再决定是否调用转换函数。

当前 `persistedSessionFlowId` 的 `requested ?? current` 仍会让显式 `null` 保留旧 binding，实施时必须一并修正。

### 14.4 Guide Dry-run 定案

（回写至 §3.3、§9.1、§10 P0-3）

- Guide **不提供** Dry-run；
- Candidate Runbook、Published Runbook 才支持 Dry-run；
- Guide 的请求**不能伪装成 Dry-run 后转去普通 Agent**（现状 `flow?.kind !== "runbook"` 时会绕过 compile 走 Agent，必须封堵）。

### 14.5 版本模型

（已回写至 §6.3，正文为准）

### 14.6 Web 真解绑

（回写至 §10 P1 Web 清单）

P1 Web 清单补充：

- **Session 真解绑**：必须调用后端写操作清除 Session binding，不能只执行前端 `setFlowId("")`；
- API 形态可以是专用 unbind 接口，也可以复用现有消息合同；
- 若采用 `flow_id: null`，必须**真正持久化清除**，而不是只让当前 Turn 绕过 Flow（参考 14.3 字段语义）。

---

## 15. 第二轮 Review 修订记录（2026-08-20）

第二轮审查继续认可 Published Runbook、Runtime 执行权和三通道复用 Bridge 的核心定义，并消除以下实现歧义。正文是规范来源，本节只记录落点。

### 15.1 合法状态与转换

已回写 §3.2/§3.3：合法组合为 `guide × draft` 和 `runbook × draft/candidate/published/deprecated`；转换保持同一逻辑 Flow lineage，完整路径为 `Guide Draft → Runbook Draft → Candidate → Published → Deprecated`。

### 15.2 管理可见与消费可用

已回写 §3.1：废弃一词多义的 `discoverable`，拆成 `isManageable`、`isConsumable`、`isBindable`、`isExecutable` 和 `isDryRunnable`。

### 15.3 一次执行、绑定与 revision

已回写 §6.1–§6.4、§9.5/§9.7 和 §10 P0：

- `/messages` 显式 Flow 只执行一次，不写 binding；
- `apply` / unbind 是持久 binding 的唯一写入口；
- 飞书/Telegram V1 每次 Flow invocation 显式携带 `flow_id + definition_revision`；
- 运行前 revision 失配统一返回 `409 flow_revision_mismatch`，不执行、不升级、不回落 Agent。

### 15.4 Session 三态的现状与目标

已回写 §9.3：`undefined → null` 的转换点是 `session-api.ts` 的 `asNullableString`；`flow_id: null → 持久化解绑` 是 V1 目标合同，当前 `requested ?? current` 尚不能清除 binding。

### 15.5 终局闭环与 V1 主路径

已回写 §2、§4.1、§9.6 和 §10 P1/P2：Guide 与自动迭代属于终局/P2；V1 最小创作主路径是“成功 Run → Candidate → Dry-run → Review → Published”，不建设通用 DAG 或完整 Guide 创作器。

### 15.6 V1 权限范围

已回写 §4.4、§5、§10 和 §11：V1 只做本机实例级入口校验、统一 actor 映射、既有 Capability 授权和审计，不建设 Flow ACL。

### 15.7 Guide 永不执行

已回写 §12：Guide 作为确定性执行器不是延期项，而是永久排除；Guide 必须先升级为 Runbook。

### 15.8 旧规范覆盖

已回写 §0：明确作废旧 Guide 一等产品语义、`/flow` 列出 Published Guide、通道长期绑定运行和显式 Flow 自动写 binding 等旧决定；Flow 消费向导采集参数不属于普通 Agent 闲聊表单。
