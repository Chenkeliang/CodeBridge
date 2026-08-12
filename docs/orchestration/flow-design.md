# Flow 产品与运行时设计

- Version: `0.1.0`
- Status: `Planning baseline`
- Updated: `2026-08-12`
- 上游约束：`engine.md`（DSL 与事件模型）、`DESIGN.md`（视觉与交互）

本文档定义 Flow（可复用工作流）从**第一性原理**出发的产品形态、引擎边界与实现分期。所有实现必须与本文档一致；分歧先改文档。

## 0. 第一性原理

用户日常工作中存在大量**相同步骤序列 + 不同参数**的重复任务（权益交付、订单查询、A 股复盘、发布验证）。基本事实：

1. **LLM 擅长**理解自然语言意图、从上下文提取参数候选、解释结果。
2. **LLM 不擅长**可靠执行：会漏步骤、猜参数、误报成功、被注入带偏。
3. **Runtime 擅长**确定性执行：状态机、校验、审批、重试、审计。
4. **信任来自可追溯**：参数从哪来、跑的是哪个版本、成功由谁判定，都必须可查证。

由此推导出根本分工：

```text
LLM 提议（识别流程 / 提取参数候选 / 解释结果）
Runtime 决策（绑定 / 校验 / 授权 / 状态迁移）
Verifier 判定成功（postcondition，而非"没报错"）
```

Flow 不是"保存聊天步骤"，而是**经过参数化、安全审核、版本冻结且结果可验证的可执行契约**。

## 1. 不可违背的不变量

1. **模板不可变**：published Flow 绑定 `git_revision + content_hash`，修改只能产生新 revision，支持 supersede / 回滚 / deprecated。
2. **参数快照不可变**：每次 Run 保存 resolved inputs 全量快照（值 + 来源 + resolver 版本）。
3. **执行边界**：只有 `published` 可真实执行；`candidate` 只允许 dry-run / 沙箱执行并产出评审证据；`deprecated` 拒绝新 Run。
4. **Capability 不隐式注册**：Flow 引用未注册能力 → 校验失败。能力必须独立审核、固定 revision。
5. **审批绑定 hash**：`approval_token = hash(flow_revision + step_id + resolved_inputs + capability_revision)`，任一变化审批失效（防 TOCTOU）。
6. **副作用显式**：写步骤声明幂等键；production write 默认审批；retry 仅限 Adapter 声明 `retryable` 的错误。
7. **提示词前缀只放不可变内容**（见 §6 缓存约束）。

## 2. 引擎分层

```text
FlowDefinition        不可变模板（YAML/git 版本化）
      ↓ 结构编译（schema + DAG 校验）
PlanTemplate          步骤图 + 输入/输出契约
      ↓ 参数绑定（typed inputs + resolver）
ResolvedPlan          精确参数 + 来源 + 版本快照
      ↓ Policy / Approval
ExecutablePlan        冻结，含审批 token
      ↓
Deterministic Executor → Step Verifier → Event Store / Artifact
```

"编译"与"参数绑定"分离：结构合法性和本次参数合法性是两个独立关卡。

## 3. 参数设计

### 3.1 参数五类

| 类型 | 示例 | 存储 |
| --- | --- | --- |
| 固定常量 | capability ID、审批规则 | FlowDefinition |
| 调用输入 | 分支名、企业 ID、日期 | 声明 Input，运行时绑定 |
| 环境派生 | workspace、当前分支 | 存 resolver 规则，不固化当前值 |
| 上一步输出 | 构建产物 ID | `steps.<id>.outputs.<field>` 引用 |
| Secret | token | 只存 `secret://` 引用，永不存值 |

### 3.2 Input 声明（扩展现有 `inputs: string[]`）

```yaml
inputs:
  - id: company_id
    type: string
    required: true
    pattern: "^\\d{4,}$"
    source: user            # user | context.* | agent | step output

  - id: workspace
    type: directory
    source: context.workspace
    scope: authorized_folders

  - id: env
    type: enum
    values: [test, production]
    default: test
    confirmation:
      when: "value == 'production'"   # 该值禁止 Agent 预填
```

### 3.3 覆盖优先级与提取约束

```text
Flow 默认值 < Project Binding < 用户本次输入
```

LLM 提取值只能是 **candidate**，禁止覆盖：secret、production 环境、审批规则、capability、workspace 授权范围。有歧义必须在对话中询问，不得猜。

### 3.4 来源追溯（provenance）

每个 resolved input 记录 `source + evidence_ref`（Agent 提取的值必须链回具体 `event_id`）。UI 审批/确认界面逐项展示来源；无法追溯来源的值默认拒绝执行。

## 4. 流程准确性的编译期校验

- Step ID 唯一、依赖无环、无不可达步骤、分支覆盖 default
- 上一步输出类型与下一步输入类型兼容
- Capability 已注册且 revision 固定
- workspace 路径在授权目录内
- production write 必有审批点
- retry 仅用于 `retryable` 错误
- 每个关键步骤声明 `success_when` postcondition

步骤成功 = postcondition 通过，不是 Adapter 没抛异常。

## 5. LLM 执行边界

LLM Step 沙箱化：

```yaml
- id: analyze
  kind: llm
  prompt_revision: diagnose-v4
  allowed_capabilities: [repo.read, repo.search]
  input_schema: DiagnoseInput
  output_schema: DiagnoseResult
  max_turns: 6
  timeout: 120s
  completion_condition: output.report != null
```

规则：只注入该步所需上下文；输出必须过 JSON Schema（可带错误重试 ≤2 次）；工具仅限 allowlist；超时/不确定进入 `waiting/manual_review`；禁止以成功形态降级。

**Guide 与 Runbook 严格区分**：guide 允许边界内推理（诊断、探索）；runbook 步骤确定，LLM 只做受约束的局部转换；production write 只能出现在 runbook。

## 6. 提示词注入与缓存约束（硬性）

Agent 前缀缓存是 prefix 命中机制，注入位置决定成本与命中率：

1. **目录摘要静态化进共享前缀**：所有 published Flow 的 trigger 摘要（名称 + 一句话 + 参数名列表）放环境块，内容只随发布/弃用变化，全会话共享前缀。
2. **Flow 全文不进提示词**：前缀只放一行指针（`绑定 flow_x @ git:abc123`）；Agent 经 `flow_get` 能力懒加载定义，工具结果进历史后天然被缓存。
3. **易变内容（使用次数、成功率、时间）不注入前缀**，仅 UI 展示层使用。
4. **绑定/换绑只在会话开始**；中途换绑视为新前缀，产品上不鼓励。
5. **埋点验证**：记录 adapter 上报的 cache_read / cache_creation tokens，以缓存命中率作为该设计的验收指标之一。

## 7. 失败分类学

| 类别 | 语义 | 恢复策略 |
| --- | --- | --- |
| `infrastructure` | 超时、进程崩溃、网络 | 可重试（受 retry 声明约束） |
| `verification` | postcondition 未通过 | 回到上一步或人工 |
| `policy` | 越权、未审批、目录越界 | 只能人工，禁止重试 |
| `llm_output` | 输出不合 schema | 带错误重试 ≤2 次，再入 manual_review |

四类分开记账，否则恢复策略无从谈起。

## 8. Dry-run 语义

`POST /v1/sessions/:id/runs` 增加 `dry_run: true`：

- 只读步骤**真实执行**（预演结果有参考价值）
- `workspace_write` 及以上 mode：**模拟执行**——照常跑校验（参数合法性、目录授权、幂等键冲突），不落副作用，输出标记"模拟"
- 预演 Run 计入运行记录并标 `dry-run`
- 转正：预演的 ResolvedPlan 快照原样复用，**不重新提取参数**

## 9. 产品设计

### 9.1 使用入口（只有两个半）

1. **Composer 流程选择器**（已有，升级为绑定开关）：选中即绑定当前会话，placeholder 变为"按此流程描述你的任务…"，Session Header 显示流程章；一会话绑一个，可解绑。
2. **对话识别**：用户直接说话，Agent 靠前缀目录摘要匹配，回复"这匹配「X」流程（v3 · 47 次成功）。按流程执行，还是自由处理？"——确认即绑定+执行。
3. （半个）Flow 详情页"在当前会话使用"按钮。

明确不做：独立"运行 Flow"页面、参数编辑表单卡片、Rail 新图标。

### 9.2 对话内执行

- 缺参数 → LLM 在对话里问，不出表单
- 参数齐 → 输出执行计划摘要（对话消息形态）+ `[执行]` `[预演 dry-run]`
- 执行过程复用 WorkActivity 脊柱，头部显示"第 N/M 步"，审批步骤内嵌审批卡
- 只读类 Flow（订单查询等）走快车道：无需确认卡，结果以结构化表格卡渲染

### 9.3 流程展示页

Flows 面板分组：**待评审**（红点计数置顶）/ **已发布**（版本 + 次数 + 成功率 + 最近运行）/ **已弃用**（折叠）。行内风险色点：只读 faint / 写工作区 muted / git 写 warning / 生产写 danger。

详情页主区三段（复用现有视觉语言，不做 DAG 编辑器）：

- **步骤脊柱**：像素方块节点串联（审批点 = 菱形 + 虚线警示边框），每步可见输入输出契约、success_when、幂等键
- **参数表**：类型、默认、来源（用户/上下文/Agent 提取+事件链接）、约束
- **运行记录**：状态、耗时、revision、失败步骤

### 9.4 评审

候选详情 = 语义 Diff（与上一版本，复用红绿 Diff 组件）+ 校验结果 + 来源 Run 证据。操作条：`[通过并发布]`（自动写 git 仓、取 HEAD revision，用户无感知）/ `[打回]`（必填原因，回流为推荐负样本）。校验失败禁用通过。

## 10. 能力契约（Capability Contract)

**目标**：能力体系是通用的。DCP、SLS 日志、飞书通知是磐石环境的插件；其他部署方没有这些系统时，按契约实现自己的 adapter、注册同名 capability，Flow 定义零改动。可移植性来自契约，不来自适配。

### 10.1 三层模型

```text
Capability ID       稳定语义名,Flow 只引用它       如 equity.deliver
  └─ Capability     注册表条目:风险、环境、schema   治理层,审核后生效
       └─ Adapter   执行实现:本环境的具体系统       插件层,可替换
```

Flow → Capability ID → 注册表查治理规则 → Runtime 找当前环境绑定的 Adapter 执行。**Flow 永远不知道 DCP 存在**。

### 10.2 命名规范（注册时强校验）

`<domain>.<action>`,domain 白名单制,小写蛇形:

- 通用域（任何部署都可有）:`fs.*`、`git.*`、`http.*`、`agent.*`、`flow.*`
- 领域域（按业务注册）:`equity.*`、`order.*`、`notify.*`、`deploy.*`、`log.*`
- 禁止厂商/系统名直接做域:~~`dcp.*`~~ → 用 `deploy.*`;~~`sls.*`~~ → 用 `log.query`。**DCP 是 `deploy.*` 的一个 adapter,不是能力本身**

### 10.3 Capability Manifest（注册时必须提供）

```yaml
id: equity.deliver
version: 1
description: 向企业交付权益包
risk: production_write           # read_only | workspace_write | git_write | production_write
environments: [production]
resources:                       # 资源作用域:风险是参数敏感的(见 §10.6)
  company_id: { pattern: "^\\d{4,}$" }
input_schema:                    # JSON Schema,Runtime 强校验
  type: object
  required: [company_id, package_id, duration_months]
  properties:
    company_id: { type: string }
    package_id: { type: string }
    duration_months: { type: integer, minimum: 1, maximum: 36 }
output_schema:                   # 成功时的输出契约,供下一步引用与校验
  type: object
  required: [equity_order_id]
  properties:
    equity_order_id: { type: string }
idempotency:
  key: ["company_id", "package_id"]   # 由这些输入派生幂等键
retryable_errors: [rate_limited, upstream_timeout]
side_effects: true
timeout_ms: 30000
adapter_hint: [function, http, mcp]   # 声明可承载的 adapter 类型
```

`input_schema` / `output_schema` 是**强约束**:入参不过 schema 不执行;出参不过 schema 记 verification failed,不进入下一步。

### 10.4 统一出入参信封

所有 adapter 的 execute 输入输出遵守同一信封（扩展现有 `CapabilityInvocation`):

```yaml
# 输入 envelope(由 Runtime 构造,adapter 不感知 Run 细节之外的东西)
input: { ... }                 # 已过 input_schema 的参数
context:
  run_id / step_id / attempt
  workspace: { root, authorized_paths }
  environment: test | production
  secrets: { dcp_token: "secret://..." }   # 仅注入声明了的 secret 引用
  dry_run: true | false                     # true 时写类 adapter 必须只校验不落副作用
  idempotency_key: "flow:…/step:…/hash:…"
  signal: AbortSignal

# 输出 envelope
output: { ... }                # 必须过 output_schema
artifacts: [{ name, artifact_ref, mime_type }]   # 大内容只存引用
verification: { status, summary }               # adapter 的自证
logs_ref: artifact://…         # 执行日志引用,不内联
dry_run_report:                # 仅 dry_run 时返回
  would_do: "向企业 8821 写入年度大会员 × 12 个月"
  checks: [{ name: 幂等键冲突, passed: true }]
```

**dry_run 是契约级要求**:任何 `side_effects: true` 的 adapter 必须实现 dry-run 分支（校验 + 描述将做什么）,否则该能力不能标记为可预演,Flow 含它时禁用预演按钮。

### 10.5 内建 Adapter 类型与扩展点

| kind | 用途 | 举例 |
| --- | --- | --- |
| `function` | 进程内函数 | 内部直连接口 |
| `http` | 受控 HTTP(allowlist host + 方法 + 头) | 内部 REST 服务 |
| `mcp` | MCP server tool | 标准协议接入第三方 |
| `cli` | 无 shell spawn,JSON stdin | 本地命令行工具 |
| `skill` | SKILL.md 注入为 Agent 上下文(不执行脚本) | 知识型能力 |

扩展点只有一个：**实现 `CapabilityAdapter` 接口 + 提供 manifest**。别人接入自己的部署系统 = 写一个 `kind: http` 的 adapter,manifest 里注册 `deploy.create`——磐石的 DCP adapter 和这个自定义 adapter 平级,Flow 无感知。

### 10.6 风险与资源作用域（修正四档枚举的不足）

风险不只是静态等级,是 `f(capability, 参数)`:

- manifest 的 `resources` 声明参数级约束(如 `notify.send` 的 `channel` 必须在白名单)
- `risk` 是静态底线;命中敏感参数模式时 Runtime 动态升级审批(如 `env=production` 强制审批,即使 capability 只是 `workspace_write`)
- 会话授权目录是 `fs.*` 能力的硬边界,与 capability 审核独立叠加

### 10.7 版本与演进

- Capability 内容 hash + adapter revision 记入每次 Run;manifest 变更 = 新 version,Flow 可pin `equity.deliver@1`
- 已注册能力被修改风险等级/schema 时,引用它的已发布 Flow 标记 `stale`,需重新评审——防止"流程没变,脚下的能力变了"

## 11. 实现边界（明确不做）

- v1 不做并行、循环、补偿、定时器（engine.md §9 既定）
- v1 不做 DAG 可视化编辑器 / 拖拽编排
- v1 不做自动推荐；先手动"存为 Flow"攒数据，推荐策略由真实数据驱动
- 冷启动锁死 `production_write`（引擎层禁用），仅开放 read_only / workspace_write / git_write
- 不做跨 Agent 自动移植；只做**可移植性校验**（Flow 声明能力集 vs 目标 Agent Adapter 覆盖度，不足则置灰）
- 对话内不做就地参数编辑表单

## 12. 分期

### P0 · 引擎安全底线

- typed inputs + resolved snapshot（含 provenance）
- published/candidate/deprecated 执行门（修现状：目前仅拦 deprecated）
- capability 引用必须已注册，禁止隐式注册
- 审批 token 绑定参数 hash
- dry-run 执行路径（mock adapter + 校验器）

### P1 · 手动闭环

- Session "存为 Flow" → `/v1/flows/candidates`（含自动参数化：绝对路径、日期、ID 识别为输入）
- 评审 UI（语义 Diff + provenance + 通过/打回）
- Flow 展示页 + Composer 绑定 + 对话执行卡

### P2 · 对话识别与快车道

- 目录摘要前缀注入 + `flow_get` 懒加载
- 意图识别确认消息 + 对话补参
- 只读 Flow 快车道（结果表格卡）
- 缓存命中率埋点验收

### P3 · 数据驱动优化（有 20+ 真实 Flow 后）

- 重复价值检测与推荐卡（含 FLOW_RECOMMENDED 事件与负样本回流）
- golden-run 回放对账（新版本离线回放历史成功 Run 验证语义等价）
- 资源互斥 lease、跨 Agent 移植性检查完善

## 13. 验收指标

- 缓存命中率：注入改造前后 adapter 上报 cache_read 占比不下降
- 参数准确率：评审中被打回原因分布；Agent 提取参数的改错率
- 流程成功率：published Flow 的 verification 通过率 ≥ 95%（低于此值的 Flow 应触发复审）
- dry-run 转化率：预演 → 真跑的比例（低说明预演不可信或流程不稳）
