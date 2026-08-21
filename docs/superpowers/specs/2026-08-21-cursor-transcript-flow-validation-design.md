# Cursor Transcript → 通用 Flow 全链验证设计

Status: Superseded by the accepted single-goal validation plan

> 2026-08-21：原“Cursor transcript 导入产品”方案不再实施。当前只把真实 Agent 工作过程作为人工参考，使用匿名参数化 fixture、现有 Flow 生命周期和纯内存 demo 能力完成验证；不建设 UUID 导入器、路径扫描、LLM 服务或额外迁移层。实施以 `docs/superpowers/plans/2026-08-21-cursor-transcript-flow-validation.md` 为准。

## 1. 目标

使用真实 Cursor Agent 对话作为经验样本，验证 CodeBridge 能否把一次完成过的任务提炼成可参数化、可追溯、可审查的通用 Flow，并通过 Web 完成 Guide → Candidate → Dry-run → Review → Published → Apply/Run → 结果回流的完整生命周期。

本设计仅使用一次真实 Cursor 工作过程做需求分析和匿名测试样本来源。产品代码、测试夹具、Flow 定义和运行时均不得依赖原 Session UUID、原始文件路径、原订单号、PID 或其他实例值。

完整执行验证只能发生在独立 simulation 环境。禁止连接线上业务写接口，禁止执行 upsert、商品状态/价格更新、缓存清理、SPU 同步或 depot 写操作。

本设计属于 P2 冷启动与验证能力，不是 V1 三通道交付门禁；Guide 不是生成或使用 Flow 的必经阶段。既有“Published Runbook 成功 Run → Candidate → Dry-run → Review → Published”主路径，以及 Web 管理、飞书/Telegram 消费、Bridge 统一领域能力、Runtime 确定性执行的三通道目标均保持不变。

## 2. Flow 通用化原则

Flow 是从一次经验中提炼出的任务定义，不是对原 Session 的录制回放。

- Session、Run、工具轨迹只作为 evidence 和 provenance；
- 订单号、PID 列表、价格、环境等实例值转为 inputs；
- 查询、计划、审批、应用、验证等稳定行为转为 steps；
- 数据库地址、账号、Token、绝对路径、原始命令和长输出不得进入 Flow；
- 无法映射到已注册 Capability/Adapter 的步骤只能停在 Guide；
- LLM 可以提出 Guide，但不能写 Catalog、批准、发布或充当 Runtime 执行器；
- Published Runbook 仍是唯一可绑定、可正式执行的一等 Flow。

原 Cursor Session ID 只允许存在于本地导入记录的 provenance 中，不参与 Flow ID、definitionRevision、参数默认值、Capability 选择或运行判断。由真实样本生成并提交到仓库的 fixture 使用匿名、合成 ID，且不引用用户本机路径。

## 3. 范围

### 3.1 本轮建设

1. 通用 Cursor 本地 transcript 读取与规范化；
2. Web 手动输入任意 Cursor Session UUID 的 Preview/Confirm 导入入口；
3. transcript evidence 脱敏、Schema 校验和持久化；
4. 从导入 evidence 生成通用 Guide 提案；
5. 匿名稳定 fixture 与独立 simulation Capability/Adapter；
6. 使用真实 Bridge、Catalog、Review、Runtime 和 Web 的全链 E2E；
7. 阻断任何线上业务写请求的测试安全门禁。

### 3.2 不在本轮

- 不为某个固定 UUID 添加特殊逻辑；
- 不自动扫描或批量灌入全部 Cursor 历史 Session；
- 不建设真实 ddproduct、depot、缓存、SPU 生产 Adapter；
- 不以 simulation 通过宣称生产 Capability 已接通；
- 不改变 Published Runbook、Guide、Candidate 的既有产品语义；
- 不让测试 Flow 写入日常开发或生产 Catalog。

## 4. 架构

### 4.1 CursorTranscriptSource

Cursor 文件格式适配收敛在 Provider/Runner 边界，不进入 Flow 领域层。

输入：

```ts
interface CursorTranscriptImportRequest {
  providerSessionId: string;
}
```

约束：

- Web 只能提供符合 UUID 格式的 `providerSessionId`，不能提交任意文件路径；
- Runner 只在配置并授权的 Cursor transcript 根目录中解析；
- 路径解析后必须仍位于授权根目录内；
- 文件大小、事件数量、单事件长度和解析耗时均设上限；
- 不识别、缺失、损坏、超限时返回稳定错误码，不进行部分成功写入。

### 4.2 SessionEvidence

Cursor JSONL 先转换为 Provider 无关的 evidence，再交给 Flow 提取器：

```ts
interface SessionEvidence {
  source: "cursor_transcript";
  providerSessionId: string;
  sourceDigest: string;
  startedAt: string | null;
  completedAt: string | null;
  messages: Array<{
    position: number;
    role: "user" | "assistant";
    text: string;
  }>;
  toolObservations: Array<{
    position: number;
    category: string;
    name: string;
    status: "completed" | "failed" | "unknown";
  }>;
}
```

`position` 保留脱敏前事件的相对顺序；导入时间线和通用化 evidence 必须按 position 合并，不能把消息与工具轨迹分批重排。

在进入 LLM 或数据库前完成脱敏。默认不保留工具参数、Shell 命令正文和工具原始输出。Provider Session ID 仅作为导入来源追溯字段；Flow 提取器不得读取它来决定定义。

导入 transcript 是“外部历史证据”，不能伪装成 CodeBridge Runtime 的 succeeded Run。proposal 明确携带 `evidence_source=provider_transcript`，Web 展示“基于导入历史”。

### 4.3 FlowGeneralizer

通用化分两步：

1. LLM 根据脱敏 evidence 提议参数、稳定步骤和不确定项；
2. Bridge 对响应做严格 Schema 与领域校验，并生成 Guide proposal。

建议合同：

```ts
interface GeneralizedGuideProposal {
  name: string;
  description: string;
  inputs: Array<{
    id: string;
    type: "string" | "integer" | "enum" | "directory" | "secret_ref";
    required: boolean;
    purpose: string;
    example?: string;
  }>;
  steps: Array<{
    id: string;
    purpose: string;
    dependsOn: string[];
    proposedCapability: string | null;
  }>;
  assumptions: string[];
  unresolved: string[];
}
```

本轮不扩张既有 Flow input type。批量标识（如 `product_ids`）使用 `string`，由 UI 以换行/逗号分隔采集并由 Capability 合同规范化；新增数组类型属于独立领域变更，不夹带进 transcript 导入。

LLM 生成的 `proposedCapability` 只是建议。只有 Registry 中真实存在且合同匹配的 Capability 才能进入 Candidate Runbook；否则该步骤保留为 Guide 语义步骤。

对于参考样本，期望得到的通用结构为：

```text
inputs:
  product_ids
  product_type
  target_price
  target_status
  environment

steps:
  查询当前商品状态
  查询关联库存/交付状态
  生成变更计划与语义 Diff
  请求高风险操作审批
  应用变更
  回查并验证 success_when
```

此结构不得包含原 PID、订单号、Session UUID 或一次性查询结果。

### 4.4 保存边界

- Preview 和提取均为只读；
- 用户点击确认后，Bridge 才保存规范化 evidence/Session；
- 用户再次确认“整理为 Guide”后，Bridge 才写 Guide Draft；
- Guide 转 Candidate 仍走既有转换、compile 和 validation；
- Definition Review、Published、apply/unbind 和 Runtime 合同保持既有唯一入口；
- Agent 和 Cursor transcript adapter 均无 Catalog 写权限。

## 5. Web 交互

### 5.1 导入入口

Web Cursor Session 管理区增加“导入本地 Cursor Session”：

1. 输入 UUID；
2. 请求 Preview；
3. 展示可导入消息数、工具类别、时间范围、脱敏提示和来源；
4. 用户可以取消或确认；
5. 确认后创建/更新 CodeBridge Session，并打开时间线；
6. 可提取时展示“整理为 Guide”。

不提供任意路径输入，不在本轮自动扫描所有本地 transcript。

### 5.2 通用化确认

Guide 保存前展示：

- 被识别为 inputs 的实例值类别；
- 稳定步骤；
- LLM 假设；
- 未解析项；
- 未注册 Capability。

用户确认的是通用任务语义，不是原对话回放。

## 6. Simulation 验证环境

Web 全链 E2E 启动隔离的测试系统：

- 临时 SQLite、临时 Catalog、临时数据目录和随机端口；
- 只注册 simulation Capability/Adapter；
- Session、Run、Flow ID 在测试时动态生成；
- 所有状态在测试结束后销毁；
- UI 明确显示“模拟环境”；
- 出站业务写请求触发测试立即失败。

simulation Capability 使用通用合同，例如：

```text
catalog.read_product_state
catalog.read_delivery_state
catalog.plan_product_change
catalog.apply_product_change
catalog.verify_product_change
```

`catalog.apply_product_change` 只修改当前测试进程中的临时状态。它可以使用 `production_write` 风险语义和 Runtime Step Approval，从而验证审批与执行编排，但永不连接生产 Adapter。

Capability ID、输入输出 Schema、risk、approval、idempotency 和 `success_when` 可与未来生产实现对齐。simulation 测试通过只证明合同与编排可用，不证明生产 Adapter 已接通。

## 7. LLM 可重复性

产品路径允许 LLM 判断“固定业务规则还是实例参数”，但自动化合并门禁不能依赖在线模型的随机输出。

- parser/redactor 使用纯确定性测试；
- LLM 合同测试注入固定响应，验证 prompt 输入已脱敏、输出 Schema 和错误处理；
- Web 全链 E2E 使用从真实对话结构匿名化得到的稳定 `SessionEvidence` fixture；
- 可选 live-LLM smoke test 只验证能生成合法 Guide，不作为合并门禁；
- fixture 使用合成 Session/Run/业务 ID，不包含原 UUID、用户路径或线上连接信息。

## 8. 错误处理

| 场景 | 结果 |
|---|---|
| UUID 格式非法 | `400 invalid_provider_session_id` |
| transcript 不存在 | `404 provider_transcript_not_found` |
| transcript 越过授权根目录 | `403 provider_transcript_not_authorized` |
| 文件损坏或格式不支持 | `422 provider_transcript_invalid` |
| 文件/事件超限 | `413 provider_transcript_too_large` |
| LLM 无法生成合法 Schema | `422 flow_proposal_invalid`，不落库 |
| 证据不足 | 返回 `unavailable` 和明确原因 |
| Capability 未注册 | Guide 可保存；Candidate validation 失败 |
| simulation Adapter 尝试外部写 | 测试立即失败并记录目标 |
| Preview 后源文件改变 | Confirm 返回 `409 provider_transcript_changed` |

Preview 返回 `sourceDigest`；Confirm 必须携带该 digest。源文件改变时必须重新 Preview，避免确认内容和实际导入内容不一致。

## 9. Web 全链验收

真实后端 E2E 至少覆盖：

1. 导入 Preview、取消、确认及错误提示；
2. Session 时间线展示规范化 evidence；
3. LLM 提取通用 Guide，实例值进入 inputs；
4. Guide 编辑、保存和 provenance；
5. 在缺失 Capability 的隔离测试配置中，Guide 转 Candidate 会展示 validation issues；
6. 在完整 simulation Registry 的独立测试配置中，生成合法 Candidate；
7. Candidate Dry-run 不修改 Session binding；
8. Definition Review 展示语义 Diff、证据、打回、重新提交和批准；
9. Published Runbook 进入消费列表，Guide/Candidate 不进入；
10. apply、unbind 与 one-shot invocation 语义；
11. Runtime Step Approval 展示和批准；
12. simulation 执行、Step、Artifact、verification 与终态回流；
13. 新 revision 发布后旧绑定返回失配提示并可重新绑定；
14. Deprecated 后不可绑定、不可执行，只能查看历史证据；
15. 页面刷新和 SSE 重连后状态保持正确；
16. 全程没有线上 upsert、缓存清理或业务写请求。

现有 `e2e/flow-loop.spec.ts` 主要使用浏览器网络 Mock。本设计新增的全链套件必须启动真实 Bridge/Runner/Runtime 测试环境；浏览器只操作生产 Web 入口，不 Mock Flow 领域 API。

## 10. Surface Matrix

| Surface | Entry | Read path | Write path | Event consumption | Error/recovery | Terminal feedback | Planned |
|---|---|---|---|---|---|---|---|
| Web | Cursor Session 管理区导入 | Preview、Session timeline、Guide/Flow API | Confirm、Guide、Review、apply/unbind | Session/Run SSE | digest 变化、校验错误、重连 | Guide、Published、Run 终态 | 本设计 |
| Bridge | import/proposal/Flow API | normalized evidence、Catalog、Registry | evidence、Guide、Review、binding | WorkItem events | 原子写入、幂等、稳定错误码 | API/SSE | 本设计 |
| Runner/Provider | UUID → transcript | 授权目录内 JSONL | 无 Catalog 写 | 无 | 目录/大小/格式门禁 | normalized evidence | 本设计 |
| Runtime simulation | Published Runbook invocation | 临时 fixture state | 仅进程内临时状态 | Runtime events | 幂等、审批、验证失败 | Step/Artifact/Run | 本设计 |
| 飞书 | 非本轮入口 | 既有 Flow consume API | 无新增 | 既有结构化回流 | 既有恢复 | 既有结果卡 | 不变 |
| Telegram | 部署关闭 | 合同保持 | 无新增 | 既有合同 | 既有恢复 | deployment disabled | 不变 |

## 11. 完成定义

- 产品与测试代码中不存在参考 UUID、原始绝对路径或原业务标识；
- 任意合法 Cursor Session UUID 可通过同一入口 Preview/Confirm；
- transcript 格式只存在于 Provider/Runner adapter；
- LLM 收到的 evidence 已脱敏，非法输出不落库；
- Guide 通用化结果通过人确认后才保存；
- 匿名 fixture 可在真实后端 Web E2E 中完成全部 16 项验收；
- 测试环境没有任何线上业务写能力或连接；
- simulation 通过不会被报告为生产 Adapter 已实现；
- 既有 Flow、Session、飞书和 Telegram 测试保持通过。
