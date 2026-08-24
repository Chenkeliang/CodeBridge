# 对话式 Flow 批量调用设计

- Status: Accepted for implementation
- Date: 2026-08-21
- Scope: Web / Agent / 飞书 / Telegram 共用的自然语言抽参与批量 Runtime 执行
- Product baseline: `2026-08-20-flow-three-channel-v1-final-alignment.md`

## 1. 第一性原理目标

用户不应先学习参数表单和命令，才能复用一份 Flow。正确入口是用户在普通对话里引用一个 Published Runbook，并直接提供一批业务参数；LLM 阅读 Flow，理解整批输入，再由 Runtime 按同一份 Flow 安全执行。

目标链路只有一条：

```text
用户引用 Flow + 提供批量参数
→ LLM 按 Flow Schema 全量理解、归一化并找出缺失/歧义
→ Bridge 校验并持久化批量调用草稿
→ Web / 通道展示批量预览
→ 用户一次确认
→ 一个 BatchRun 创建多个独立 Runtime Run
→ Runtime 逐项执行、审批和验收
→ LLM 汇总解释，用户可查看逐项结果并只重试失败项
```

这不是“Flow 推荐卡支持多个参数”，也不是把一个数组塞进一次 Run。它是正式的对话式 Flow 消费方式。

## 2. 不变边界

- 只有 `kind=runbook && status=published` 可以创建正式批量调用。
- Flow 是 LLM 理解任务和参数的标准作业协议；LLM 可以跨整批分析，但不能绕过 Flow 自由调用业务能力。
- Bridge 负责 Flow identity、revision、参数 Schema、权限上下文和状态转换校验。
- Runtime 仍是唯一执行器，继续负责 Capability、Adapter、风险、审批、重试、幂等和 `success_when`。
- 一组参数对应一个普通 Runtime Run；BatchRun 不复制步骤执行器，也不成为第二个 Run 状态事实源。
- 用户确认前不得创建执行 Run。
- Agent 不写 Catalog、不审查发布、不批准 Runtime step，也不修改 Session binding。
- 不执行任何线上业务写操作作为开发或验收手段；使用内存、fixture 或明确的测试能力。
- Telegram 实现共享合同和自动化测试，正式启用继续后置。

## 3. 当前能力与缺口

当前链路已经具备：

- Agent prompt 能看到可消费 Flow 的最小摘要；
- LLM 可以通过 `fcb flow suggest` 产生 `FLOW_RECOMMENDED`；
- Bridge 会校验 Flow/revision 并只保留合法的非 secret 参数；
- Web recommendation 卡可以打开 Flow 并预填一组参数；
- 用户确认后可以通过现有 one-shot 合同创建一个 Runtime Run；
- 飞书可以用 `/flow` 选择、补参、确认和执行单次 Flow。

当前不具备：

- 从一段自然语言、Markdown 表格、JSON/CSV 或附件中抽取多组参数；
- 对整批输入做公共参数、重复项、冲突项和异常项分析；
- 持久化、可编辑的批量调用草稿；
- 一次确认后创建多个独立 Run；
- 批量并发、逐项状态、部分失败、取消、恢复和只重试失败项；
- Web 批量预览与批量结果视图；
- 飞书/Telegram 对同一批次的精简确认和状态回流。

因此当前只能称为“单组推荐与显式运行”，不能声称支持对话式批量 Flow。

## 4. 产品语义

### 4.1 引用 Flow

用户可以用名称、显式引用或当前界面选中的 Flow 表达意图，例如：

```text
用「订单链路核验」分析下面这些订单：
- A001，用户 1001
- A002，用户 1002
```

名称匹配由 LLM 做语义理解，但提交草稿时必须解析为唯一的：

```text
flow_id + definition_revision
```

多个 Flow 同名、匹配不唯一或 revision 已变化时，只能要求用户选择或重新确认，不能静默执行。

### 4.2 支持的输入

第一版支持：

- 普通自然语言列表；
- Markdown 表格；
- JSON 数组或对象；
- CSV 文本或附件；
- 对话已有上下文和已上传附件中的结构化内容。

附件解析结果必须记录附件 ID、行号或等价证据引用。不得把临时文件绝对路径作为长期领域标识。

### 4.3 全局参数与逐项参数

LLM 可以把整批共用值提升为 `global_inputs`，每个 item 只保存差异值。最终执行输入为：

```text
resolved_inputs(item) = validated(global_inputs) + validated(item.inputs)
```

逐项值覆盖全局值。覆盖、默认值和推断值必须在预览中可见。

## 5. LLM 解析合同

LLM 读取当前 Flow 的 inputs 定义后，生成 `BatchInvocationDraft`，不得自创 Flow 未声明的执行参数。

```ts
interface BatchInvocationDraft {
  draftId: string;
  sessionId: string;
  sourceRunId: string;
  flowId: string;
  definitionRevision: string;
  status: "needs_input" | "ready" | "confirmed" | "stale" | "cancelled";
  globalInputs: Record<string, unknown>;
  items: BatchInvocationItem[];
  sourceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

interface BatchInvocationItem {
  itemId: string;
  ordinal: number;
  label: string | null;
  inputs: Record<string, unknown>;
  evidence: Record<string, InputEvidence>;
  issues: InvocationIssue[];
}

interface InputEvidence {
  source: "user" | "agent_extracted" | "context" | "default";
  evidenceRef: string;
  inferred: boolean;
}

interface InvocationIssue {
  code: "missing" | "ambiguous" | "invalid_type" | "invalid_value" | "duplicate" | "conflict";
  field: string | null;
  message: string;
  blocking: boolean;
}
```

LLM 可以：

- 理解自然语言字段映射；
- 归一化整数、枚举、目录等类型；
- 识别全局参数和逐项参数；
- 跨整批识别重复、冲突和异常值；
- 使用明确的对话上下文或 Flow default；
- 给出缺失或歧义问题。

LLM 不可以：

- 猜测关键标识后直接执行；
- 提交 Flow 未声明的参数作为执行输入；
- 持久化 `secret_ref` 的真实值或证据文本；
- 把多组参数合成一个不可分解的 opaque prompt；
- 在草稿接口返回成功后继续自行调用业务工具。

Bridge 必须重新执行 Schema 校验，不能信任 Agent 给出的 `valid` 判断。草稿 `ready` 是服务端根据所有 blocking issues 计算的状态。

## 6. 确认模型

用户确认的是一份冻结预览，而不是一句含义模糊的“可以”。确认页至少显示：

- Flow 名称、`flow_id`、`definition_revision`；
- 总项数、有效项数、阻断项数、重复项数；
- 全局参数；
- 每项的最终输入、来源、推断标记和问题；
- 风险等级、需要审批的步骤和预计创建的 Run 数量；
- 并发策略和失败策略。

用户可以编辑参数、删除项目或补充缺失项。任何修改都使旧 confirmation token 失效，并由 Bridge 重算 draft hash。

确认请求必须携带：

```text
draft_id + draft_revision/hash + idempotency_key
```

只有 `ready` 且 Flow revision 未变化的草稿能确认。确认具有幂等性，重复点击只能返回同一个 BatchRun。

## 7. BatchRun 与子 Run

### 7.1 领域模型

BatchRun 只保存批次身份、冻结合同和子 Run 映射：

```ts
interface FlowBatchRun {
  batchId: string;
  draftId: string;
  sessionId: string;
  flowId: string;
  definitionRevision: string;
  planIrHash: string;
  concurrency: number;
  failurePolicy: "continue";
  createdBy: string;
  createdAt: string;
}

interface FlowBatchItemRun {
  batchId: string;
  itemId: string;
  ordinal: number;
  runId: string;
  inputHash: string;
}
```

每个 item 创建一个现有 Runtime Run，并冻结相同的 Flow revision 和 plan。每个子 Run 拥有独立：

- resolved inputs；
- idempotency/input hash；
- Run 状态和 attempts；
- 审批记录；
- artifacts、verification 和 terminal reason。

### 7.2 状态事实源

子 Run 状态仍以 Runtime Run 为唯一事实源。批次状态由子 Run 聚合得出：

| 聚合状态 | 条件 |
|---|---|
| queued | 尚无子 Run 开始 |
| running | 至少一个运行/等待，且仍有未终态项 |
| succeeded | 全部成功 |
| partial_succeeded | 至少一个成功，且至少一个失败/取消 |
| failed | 没有成功项，且全部失败/取消 |
| cancelled | 用户取消后没有运行中项，且没有成功项 |

不得单独更新一个可能与子 Run 冲突的 Batch status 字段。

### 7.3 调度与恢复

- 默认并发数为 3，服务端上限为 10；客户端不能突破服务端限制。
- 默认 `failurePolicy=continue`，单项失败不阻断其他项。
- 取消批次时，未启动项转为取消；运行中项复用现有 Run cancellation。
- Bridge 重启后扫描非终态批次，根据持久化子 Run 状态补齐可运行槽位。
- 已成功项绝不因重启或重试再次执行。
- “重试失败项”创建新的 child Run attempt/Run 映射，保留原失败证据；不得覆盖历史结果。

## 8. API 合同

新增共享 Bridge 领域 API，Web、飞书和 Telegram 都通过它们使用能力：

```text
POST   /v1/flow-invocation-drafts
GET    /v1/flow-invocation-drafts/:draft_id
PATCH  /v1/flow-invocation-drafts/:draft_id
POST   /v1/flow-invocation-drafts/:draft_id/confirm
POST   /v1/flow-invocation-drafts/:draft_id/cancel

GET    /v1/flow-batches/:batch_id
POST   /v1/flow-batches/:batch_id/cancel
POST   /v1/flow-batches/:batch_id/retry-failed
```

`POST /v1/flow-invocation-drafts` 接受 LLM 解析出的候选结构，Bridge 根据 Catalog 中的 Flow Schema 清洗、校验并持久化。服务端返回的 draft 才是预览真相。

`confirm` 在一个事务中完成：

1. 校验 actor、draft hash、Flow revision 和 `ready`；
2. 冻结 Flow plan identity；
3. 创建 BatchRun 和所有 item→Run 记录；
4. 按并发限制启动第一组子 Run；
5. 返回 `batch_id` 和聚合 snapshot。

现有 `/messages` one-shot 和 `/flows/:id/apply` 语义不变；批量调用不得复用 Session binding，也不得通过循环调用 `/messages` 假装批量事务。

## 9. Agent 集成

现有 Flow guidance 增加两种清晰动作：

- 单组、高置信建议：继续使用 `fcb flow suggest`；
- 用户明确引用 Flow 且提供多组数据：生成 batch draft，不产生普通 recommendation。

批量 payload 可能较大，因此 Runner 提供文件型结构化命令，命令只读取 Agent 本轮产生的 JSON，再提交 Bridge；领域 API 不依赖文件路径：

```text
fcb flow batch <draft-json-file>
```

JSON 内必须包含 `flow_id`、`definition_revision`、`global_inputs`、`items` 和证据引用。命令提交成功后，Agent停止业务工具调用，只告诉用户草稿已经生成并等待确认。

## 10. Web 交互

Web 是完整批量控制面：

1. Timeline 显示“已解析 N 项”的 Batch Draft 卡；
2. 点击进入批量预览，可查看/筛选有效、缺失、歧义、重复和冲突项；
3. 允许编辑全局参数、逐项参数和排除项目；
4. 一次确认后显示 BatchRun 汇总；
5. 展示逐项 `queued/running/waiting/succeeded/failed/cancelled`；
6. 可取消批次、打开子 Run、只重试失败项；
7. revision 失配时禁止确认，提示重新解析或明确升级版本。

第一版不建设电子表格编辑器。使用紧凑表格、行级问题和现有 Flow 参数控件即可；CSV 的大规模修改应在源文件完成后重新上传。

## 11. 飞书与 Telegram

两个通道不复制批量状态机，只消费 Bridge snapshot 和事件。

第一版通道行为：

- 用户在普通对话中明确引用 Flow 并发送批量参数；
- LLM 生成同一 Batch Draft；
- 通道回复精简预览：Flow、版本、总数、有效/异常数和风险；
- 数据全部合法且规模在通道确认上限内时，可用明确的 `/flow batch confirm <draft_id>` 或等价卡片动作确认；
- 存在复杂问题或项目过多时提供 Web 深链编辑；
- 执行后持续显示批量聚合进度和最终摘要；
- 单项详情和失败重试可以跳 Web，通道只提供不会造成歧义的最小动作。

飞书必须完成真实活跃入口验证。Telegram 复用 controller/DTO/合同测试，配置和 bot 启用继续后置并在最终交付中提醒。

## 12. 错误与安全

标准错误至少包括：

| 错误 | HTTP | 行为 |
|---|---:|---|
| flow_not_consumable | 409 | 不创建草稿 |
| flow_revision_mismatch | 409 | 标记 stale，要求重新确认 |
| batch_draft_not_ready | 409 | 返回 blocking issues |
| batch_draft_changed | 409 | 刷新预览，不执行 |
| batch_already_confirmed | 200 | 幂等返回已有 batch |
| batch_limit_exceeded | 413 | 拒绝并给出上限 |
| batch_item_invalid | 422 | 返回逐项字段错误 |
| batch_not_cancellable | 409 | 返回当前聚合状态 |
| batch_retry_empty | 409 | 没有可重试失败项 |

安全规则：

- 服务端限制单批项目数、总 payload、附件大小和并发数；第一版默认最多 500 项。
- `secret_ref` 只保存引用，不保存 secret 内容；UI、日志、事件和 LLM evidence 均遮罩。
- Flow 权限在 draft 创建和 confirm 时都校验，防止长时间停留的草稿越权。
- 每项 input hash 包含 Flow revision 和归一化 resolved inputs，保证幂等归因。
- 不因部分成功自动回滚已经成功的外部副作用；需要补偿的 Flow 必须显式定义补偿步骤，V1 不建设通用事务回滚。

## 13. Surface Matrix

| Surface | 入口 | 参数解析 | 预览/修改 | 确认 | 执行状态 | 失败恢复 |
|---|---|---|---|---|---|---|
| Web | 对话引用/推荐卡 | 当前 Agent LLM | 完整 | 一次确认 | 汇总+逐项 | 取消、失败项重试 |
| Agent | Flow guidance | 生成候选 draft | 无 UI | 禁止代确认 | 只做结果解释 | 禁止直接重试 |
| 飞书 | 普通对话引用 | 当前 Agent LLM | 精简，复杂项跳 Web | 明确命令/卡片 | 聚合状态 | Web 深链或安全最小动作 |
| Telegram | 同飞书合同 | 同 Agent 合同 | 合同测试 | 合同测试 | 合同测试 | 正式启用后验收 |

任何表面只有 API 或组件但没有活跃入口，不得声称 reachable；任何“前往 Web”都必须带上可打开对应 draft/batch 的有效深链。

## 14. 测试与验收

### 14.1 合同测试

- 自然语言、Markdown 表格、JSON、CSV 和附件引用能生成同一规范化 draft；
- 类型、枚举、pattern、required、default 和 secret 规则逐项校验；
- 全局值、逐项覆盖和来源证据正确；
- 重复、缺失、歧义、冲突和非法值不会被错误标记 ready；
- stale revision、无权限、非法状态和篡改 hash 均不能确认；
- 重复确认只创建一个 BatchRun 和一组 child Run；
- 同一批次一组参数对应一个独立 Runtime Run；
- 并发上限、部分失败、取消、重试失败项和重启恢复正确；
- 已成功项不会重复执行；
- secret 不出现在响应、事件、日志和 UI fixture。

### 14.2 活跃表面测试

- Web：真实对话生成 draft → 预览编辑 → 确认 → 查看逐项状态 → 重试失败项；
- 飞书：真实消息引用 Flow → 精简预览 → 确认 → 收到聚合终态；
- Telegram：相同 controller、DTO 和错误合同自动化通过，部署保持 disabled；
- Runtime：只使用模拟/测试 Capability，验证 plan hash、审批、验收和结果回流，不执行线上业务更新。

### 14.3 完成定义

只有同时满足以下条件才能声称支持“自然语言批量执行 Flow”：

1. LLM 能从至少自然语言列表、表格和 CSV/JSON 中生成多项 draft；
2. 用户能看到服务端校验后的逐项预览并一次确认；
3. 每项产生独立 Runtime Run，并冻结同一 Flow revision；
4. 用户能看到批次和逐项终态；
5. 部分失败后只重试失败项，不重复成功项；
6. Bridge 重启后批次可恢复；
7. Web 和真实飞书活跃路径闭环；
8. Telegram 兼容测试通过且明确标记未正式启用；
9. 全程没有线上业务写入或业务数据 upsert。

## 15. 实施边界

本设计不包含：

- 通用 DAG/循环编排器；
- LLM 自主批准或无人确认执行；
- 通用跨子 Run 事务回滚；
- 通道独立 Flow/Batch 状态机；
- Flow ACL 新体系；
- 自动发布或自动修改 Flow；
- Telegram 正式部署启用。

实施顺序必须先完成共享领域合同和持久化，再接 Web，最后接飞书/Telegram；不得从通道卡片反推或复制后端规则。

## 16. 实施与验收记录（2026-08-24）

### 16.1 已实现范围

- `FlowBatchStore` 持久化 draft、batch、item attempt、幂等键和冻结的 Flow snapshot；Bridge 启动时恢复非终态批次。
- `FlowBatchService` 完成 Schema/证据校验、一次确认、一项一个无 Session Runtime Run、并发调度、取消和失败项重试。
- Agent guidance 与 `fcb flow batch <draft-json-file>` 已接通。真实飞书测试曾暴露 evidence 结构不明确，现已补充逐字段 JSON 示例；后端证据门禁未放宽。
- Web 已挂载批量预览/编辑/排除/确认/取消/状态/失败项重试面板，并保留 Candidate Dry-run 管理入口。
- 飞书与 Telegram 共用 `ChannelFlowController`、Bridge DTO 和 `ChannelFlowProjector`；两端 watcher 均消费四类 `FLOW_BATCH_*` 事件。`confirm/retry-failed` 额外启动只读批次状态卡，持续读取 Bridge snapshot 并更新到终态，不复制批次状态机。
- Telegram 代码和合同测试已完成，部署仍保持 disabled；正式启用后的 bot 凭证、菜单和真实聊天验收是明确收尾项。

### 16.2 目标级证据

- 自动化目标测试使用本地 `RunExecutor` 和纯内存 capability，覆盖 Markdown/CSV/JSON evidence、三项独立 Run、2 成功 1 失败、只重试失败项、确认幂等、stale revision、501 项拒绝、secret 拦截、取消和重启恢复；网络请求被测试级 spy 禁止。
- 全量门禁：127 个测试文件、1151 项测试全部通过；TypeScript/ESLint 无 error（5 条既有 React effect warning）；20 个 workspace package 构建通过。
- 真实飞书安全测试：普通消息明确引用 `商品状态变更方案模拟与验证`，LLM 抽取 3 行参数并生成 `ready` 草稿；`/flow batch show` 显示 3 可处理、0 阻断；`/flow batch confirm` 产生 3 个独立 Runtime Run，最终 3/3 succeeded。该 Flow 的 4 个 capability 均为 `demo.catalog.*`、`read_only`、`side_effects=false`，全过程未连接或更新线上系统。
- 首次真实测试得到 `needs_input`，根因为 Agent 未按对象结构填写 evidence；修复 guidance 后，同一自然语言路径生成 `ready`，证明结果不是绕过 LLM 直接写 draft。
- 真实测试同时发现“批次后端已终态、飞书仍停在 running”；已增加独立终态状态卡和两端活跃适配测试。修复后在小V真实确认新草稿，批次 `batch_fac678344b05415a83d4d8c241ace257` 的状态卡由 running 自动更新为 succeeded，显示 3/3 成功；未重复写入未变化状态。
- Web 生产 Workbench 已用隔离本地浏览器打开上述真实批次深链：显示 3/3 succeeded、三项实际参数与三个子 Run 入口；点击首项“打开 Run”后成功定位 `run_ab8c4019ae724903bce64f178e0b3db2`。

### 16.3 Surface Matrix

| Surface | implemented | reachable | closed-loop | planned / 证据 |
|---|---|---|---|---|
| Web | 是 | 是，Workbench 生产入口已挂载 | 是，真实批次深链展示 3/3 终态、逐项参数和子 Run 下钻；控制面回归测试覆盖预览/编辑/确认/取消/重试 | P2 继续增强大批量编辑体验，不建设 DAG |
| Agent | 是 | 是，真实飞书 Cursor Agent 已调用 `fcb flow batch` | 是，只能生成 draft，不能确认或执行；真实 `ready` 草稿证据 | 后续只优化解析质量，不授予 Catalog/Runtime 执行权 |
| 飞书 | 是 | 是，真实 `/flow`、普通消息、show、confirm 均已验证 | 是，真实批次 3/3 成功，独立状态卡自动到 succeeded，且未重复写入未变化状态 | 继续保留活跃适配回归测试 |
| Telegram | 是 | 否，配置 disabled | 否，不声称真实可用 | 正式启用时补 bot、菜单、权限和真实会话验收 |

Web 和飞书已完成真实活跃入口的 closed-loop 验收。Telegram 仍按 V1 定案保持 disabled，不虚报为 reachable 或 closed-loop。
