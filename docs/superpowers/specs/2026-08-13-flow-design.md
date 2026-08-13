# Flow 落地设计：契约与分期

- Status: Pending user review
- Date: 2026-08-13
- Scope: `packages/flow-catalog`, `packages/workflow-engine`, `packages/run-executor`, `schemas/orchestration/*`
- Related: `docs/orchestration/flow-design.md`（产品与运行时设计愿景）, `docs/orchestration/architecture.md`（架构基线）, `docs/orchestration/engine.md`（DSL 与事件模型）, `docs/orchestration/prompt-stability.md`（缓存与稳定性规范）, `docs/spec/RULES.md`（规则注册表）

## 1. 目标

本设计把 `flow-design.md` 的愿景收敛为一条**可落地、可验证、不返工**的实现路径。核心结论：

1. Flow 是**参数化、版本冻结、结果可验证的可执行契约**，不是"保存聊天步骤"。
2. 扩展性、可移植性、可组合性都是**契约问题**，定对契约很便宜，应现在定死。
3. "越用越准确"是**证据问题**，先补证据采集（学习信号），智能（推荐/回放/优化）等数据长出。
4. 重机制（能力注册表、评审流、数据飞轮）应被真实数据的需求"拉"出来，不"推"着做（避免 YAGNI 反噬）。

## 2. 设计原则

1. **契约一次定对，机制按需生长** —— 改契约贵、做机制贵，但"定契约"本身便宜。契约现在定死，机制按需长出。
2. **先有信号，再有智能** —— 一切"越用越准确"从证据出发；没有证据采集，任何推荐/优化/回放都是空中楼阁。
3. **能力是契约，不是实现** —— Flow 只认识能力 ID（`deploy.create`），不认识具体系统（`dcp.*`）。这是可移植性的全部秘密。

## 3. 分层架构

```text
契约层（现在一次定对，改起来最贵）
  ├─ Flow DSL          typed inputs + steps + success_when
  ├─ Capability 接口   execute(输入信封) → 输出信封
  ├─ PlanIR            编译产物，执行器只认它
  └─ 事件合同          学习信号 schema

机制层（按数据飞轮需求渐进生长）
  ├─ 确定性执行器      v1 只做顺序 + 分支 + 暂停
  ├─ 能力注册表        先用"内联 manifest"，后升级注册表
  ├─ 评审流            先"自己确认"，后团队评审
  ├─ 审批引擎          先只做 production_write 强制审批
  └─ 数据飞轮          推荐 / 回放 / 负样本，有真实数据后才长
```

## 4. 落地分期

| 阶段 | 做什么 | 触发条件 |
| --- | --- | --- |
| **0 · 定契约** | 事件合同（学习信号）+ typed inputs + Capability 接口/manifest + 防漂移契约（归因哈希） | 现在，纯 schema/类型活 |
| **1 · 跑闭环** | 存为 Flow → 确定性执行 → 记学习信号 → 朴素回放 diff → 末段加 dry-run + 幂等键 | 阶段 0 完成 |
| **2 · 上安全** | 审批门（production_write 强制审批）+ 完整评审流 | 第一条要写生产的 Flow 出现 |
| **3 · 长飞轮** | 推荐、golden-run 完整回放、负样本回流 | ≥20 条带学习信号的 run 且覆盖 ≥3 条不同 Flow |

与原 `flow-design.md` 的差异：把"证据采集（学习信号）"从 P3 提前到阶段 0——它是纯 schema 活、几乎零成本，却决定未来能否"越用越准确"；晚一天采集就少一天数据。

---

## 5. 阶段 0 契约

### 5.1 事件合同：两类事件，分开对待

现有 `event.schema.json` 的"过程审计"事件（`STEP_STARTED` / `APPROVAL_GRANTED` …）**保留不动**，继续做审计。新增"学习信号"事件为数据飞轮供料：

- 过程事件：`payload` 保持宽松（审计够用）。
- 学习信号事件：`payload` **定强 schema**（脏数据没法学习）。

四类学习信号，一一对应四个"越用越准确"维度：

**① `PARAM_RESOLVED` —— 参数提取越来越准**

```yaml
- type: PARAM_RESOLVED
  payload:
    flow_id / flow_revision
    field: company_id
    candidate_value: "8821"          # LLM 提取的候选
    final_value: "88214"             # 最终敲定值
    resolution: edited | picked_alternative | confirmed
    source: agent_extracted | user | context.* | step_output | default
    evidence_ref: evt_xxx            # agent_extracted 必须链回具体对话事件
    context: "权益交付，企业简称'得到'"
```

- `confirmed` 是正样本（提取准确），`edited` 是负样本（错了被改）；两者一起才能算出"提取准确率"。

**② `FLOW_RECOMMENDED` / `FLOW_REJECTED` —— 匹配推荐越来越准**

```yaml
- type: FLOW_RECOMMENDED
  payload: { flow_id, flow_revision, match_reason, confidence }
- type: FLOW_REJECTED              # 未采用推荐 = 负样本
  payload:
    flow_id
    reason: wrong_intent | missing_capability | bad_timing | other   # 枚举，可聚类
    note: "..."                     # 可选备注
```

**③ `VERIFICATION_FAILED` —— 流程定义越来越准 + 执行成功率越来越高**

```yaml
- type: VERIFICATION_FAILED
  payload:
    step_id
    category: verification | infrastructure | policy | llm_output   # 四分类分开记账
    postcondition: "output.equity_order_id != null"
    actual: { ... }                  # 实际输出摘要，≤4KB 截断 + truncated: true
```

**④ `RUN_SNAPSHOT` —— 回放对比 + golden-run 的共同根基**

```yaml
- type: RUN_SNAPSHOT
  payload:
    flow_id / flow_revision
    resolved_inputs: { ... }         # 参数全量快照（值+来源+resolver 版本）
    steps: [{ step_id, capability_id, capability_revision, output_ref, verification_status }]
    outcome: succeeded | failed
    attribution: { ... }             # 见 5.2 归因块
```

- `output_ref` 必须是 `artifact://` 引用，禁止内联大值。
- `PARAM_RESOLVED` 携带 `flow_revision` 与 `resolver_version`；`VERIFICATION_FAILED` / `RUN_SNAPSHOT` 通过 `run_id` 关联，完整 `attribution` 块由 `RUN_SNAPSHOT` 承载（它是执行产物）。

### 5.2 防漂移契约：归因哈希

回答"这次效果变了，是参数变了、prompt 变了、工具 schema 变了，还是能力实现变了"：

```yaml
attribution:
  flow_revision: <plan_ir_hash>          # 执行产物 hash（见 6.2），非 YAML hash
  prompt_revision: <prompt 模板 content_hash>
  tool_schema_revision: <工具/能力 schema 集合 hash>
  capability_revisions: { equity.deliver: <注册方自报 capability_version> }
  resolver_revision: <参数 resolver 版本>
  authorization_revision: <授权记录 hash>   # workspace 授权范围变化会改变行为
```

**canonical form（写死，不许实现自由发挥）：**

- 结构化内容（schema / flow 模板）→ RFC 8785 (JCS) 规范化 → sha256。
- prompt 模板 → 原文字节 → sha256（空白对模型有语义，不规范化）。

**比较域 = 决策轨迹**：capability 调用序列 + 每调用 input + verification 结果。**不比较文本输出**（LLM 天然非确定）。此比较域仅适用于 `runbook`；`guide` 型 Flow 自动退出回放断言（它本就不是确定性执行对象）。

**归因规则**：同 input + 同 `attribution` → 决策轨迹必须一致。不一致 = 存在未纳入哈希的非确定性（真 bug）。

**冻结策略（谁进哈希）**：进哈希——prompt 模板、工具/能力 schema、adapter 实现、resolver 逻辑、Flow 模板、授权范围；不进哈希——时间戳、用户输入、统计、缓存状态。

**capability_version 来源**：由注册方在 manifest 里自报，不自动算代码 hash（外部 adapter 无法算）。已知 trade-off：注册方忘更新版本 → 假归因；接受此成本，不搞 hash 双轨。

**归因哈希与缓存命中的关系**：同一件事的两面。`prompt-stability.md` 追求前缀逐字节稳定（省钱），归因哈希追求影响输出的变量可版本化（能解释差异），两者的冻结策略完全重合——模板 revision 既是缓存键的一部分，也是 `attribution.prompt_revision`。

### 5.3 Typed Inputs

从 `inputs: string[]` 升级为 typed 对象数组：

```yaml
inputs:
  - id: company_id
    type: string
    required: true
    pattern: "^\\d{4,}$"
    source: user                  # user | context.* | agent | step_output
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
  - id: package_id
    type: string
    source: step_output
    from: steps.check.outputs.package_id
```

- 类型系统只五种：`string` / `integer` / `enum` / `directory` / `secret_ref`。不引入更复杂类型（先用真实 Flow 反推）。
- `secret` 值只存 `secret://` 引用，永不存值。

**来源追溯（provenance）**：每个 resolved input 落库时必须带：

```yaml
resolved:
  field: company_id
  value: "88214"
  source: user | context.workspace | agent_extracted | step_output | default
  evidence_ref: evt_xxx          # agent_extracted 必须链回具体对话事件
  resolver_version: v1
  authorization_ref: <授权记录 ref>   # directory 类型必带
```

**覆盖优先级（配置期 vs 运行期二分）：**

- 配置期参数（`user`、`default`、`project binding`）→ 走优先级 `default < project binding < user`。
- 运行期参数（`step_output`、`context.*`）→ 不走优先级，执行期直接注入、天然覆盖一切。

**禁 LLM 预填名单**：`secret`、production 环境值、审批规则、`workspace` 授权范围。`agent_extracted` 的值永远是 candidate，必须过 `PARAM_RESOLVED` 确认；有歧义必须回问，不得猜。

---

## 6. 阶段 1 最小闭环

### 6.1 闭环链路

```text
用户说任务
  → LLM 提取参数候选（agent_extracted，永远是 candidate）
  → 参数确认 → 记 PARAM_RESOLVED
  → 编译 Flow 模板 → PlanIR
  → 绑定参数 → ResolvedPlan（provenance 齐全）
  → 确定性执行：每步 = capability 调用 → verification(success_when)
  → 记 RUN_SNAPSHOT（含 attribution 块）
  → 失败则记 VERIFICATION_FAILED（带四分类）
```

### 6.2 编译点冻结：四元组

"存为 Flow"的产物**不是 YAML**，而是四元组落库：

```text
(flow_id, definition_revision, plan_ir_hash, compiled_at)
```

- `definition_revision` = YAML 内容 hash（人类可读源版本）。
- `plan_ir_hash` = 编译产物 hash（实际执行的东西）。
- 执行器只认 PlanIR，运行时**不重新解析 YAML**；版本冻结发生在编译点，不是执行点。
- 回放按 `plan_ir_hash` 取冻结 IR，不碰 YAML；旧 revision 的 RUN_SNAPSHOT 永远可回放。
- 归因链：`YAML → definition_revision → 编译 → plan_ir_hash → 执行`。"YAML 改了没编译"的中间态靠两个 hash 对不上查出。

### 6.3 成功判定：success_when

- 步骤成功 = postcondition 通过，**不是"没报错"**。
- 表达式语言选最小集：**JSONPath + 5 个比较运算符**（`!=` / `==` / `>` / `contains` / `exists`），不引入通用表达式引擎。
- 断言必须是**纯函数**：只读 output 快照、无副作用、无外部调用（否则回放 diff 无可比性）。
- 可静态解析、可序列化进 PlanIR；将来换更强的表达式引擎是兼容升级。

### 6.4 dry-run（adapter 契约级，PROTO-CAP-003 落地）

任何 `side_effects: true` 的能力，adapter 必须实现 dry-run 分支：

```yaml
# dry_run=true 时写类 adapter 返回
output: { ... }              # 不落副作用，只返回校验过的参数
dry_run_report:
  would_do: "向企业 8821 写入年度大会员 × 12 个月"
  checks: [{ name: 幂等键冲突, passed: true }, { name: 目录授权, passed: true }]
```

- 只读步骤：dry-run 与真跑一致。
- 写步骤：照跑校验（参数合法性、目录授权、幂等键冲突），不落副作用。
- **转正**：预演过的 ResolvedPlan 快照原样复用，不重新提取参数。

### 6.5 幂等键（写步骤去重）

manifest 声明 `idempotency.key`（由哪些输入派生）与 `idempotency.validity_window`：

```text
idempotency_key = hash(flow_id + step_id + key 字段的规范化值)
validity_window: 24h | 7d | permanent   # manifest 声明
```

- 窗口内同 key 已成功 → 直接返回上次结果，不重复副作用。
- 窗口外同 key → 视为新操作（区分"重复交付要拦"与"隔天合法重发不拦"）。
- 这是"回放 diff 不造成重复写"的根基。

### 6.6 回放 diff（确定性验证）

对已成功的 `runbook` RUN_SNAPSHOT，按 `plan_ir_hash` 取冻结 IR + 同 resolved_inputs 重放：

```text
重放执行（写步骤强制 dry-run，靠幂等键识别）
  → 比较决策轨迹：capability 调用序列 + 每调用 input + verification 结果
  → 轨迹一致 = 确定性验证通过
  → 轨迹不一致 = 执行器存在未纳入 attribution 的非确定性（真 bug）
```

比较的是"调了什么、传了什么、判定结果"，不是"副作用实际效果"；副作用靠幂等键保证不重复发生。

---

## 7. 阶段 2 / 阶段 3（骨架，细节待展开）

### 7.1 阶段 2 · 上安全

- **审批门**：production_write 强制审批；审批 token 绑定 `hash(flow_revision + step_id + resolved_inputs + capability_revision)`，任一变化审批失效（防 TOCTOU）。
- **评审流**：candidate → 语义 diff（与上一版本）+ provenance + 校验结果 → 通过并发布 / 打回（必填原因，回流为负样本）。
- 触发条件：第一条要写生产的 Flow 出现时才做。

### 7.2 阶段 3 · 长飞轮

- 推荐：重复价值检测 + 推荐卡（含 FLOW_RECOMMENDED 事件与负样本回流）。
- golden-run 完整回放对账：新版本离线回放历史成功 Run 验证语义等价。
- 参数准确率统计：PARAM_RESOLVED 的 confirmed/edited 比率。
- 触发条件：≥20 条带学习信号的 run 且覆盖 ≥3 条不同 Flow。

---

## 8. 验收标准

1. 一条 runbook Flow 端到端跑通，留下完整学习信号（PARAM_RESOLVED + RUN_SNAPSHOT + 必要时 VERIFICATION_FAILED）。
2. 同 `attribution` 重放，决策轨迹一致（确定性验证通过）。
3. 参数提取准确率可计算：PARAM_RESOLVED 同时含 confirmed（正样本）与 edited（负样本）。
4. 失败可归因：VERIFICATION_FAILED 带四分类，且 actual ≤4KB 截断。
5. dry-run 转正不重新提取参数（ResolvedPlan 快照复用）。
6. 幂等键窗口内去重、窗口外视为新操作。
7. "YAML 改了没编译"能被四元组两个 hash 对不上查出。
8. 缓存命中率不下降（遵循 prompt-stability.md 与 PROTO-PROMPT-*）。

## 9. 非目标

- v1 不做循环、并行、补偿、定时器。
- 不做 DAG 可视化编辑器 / 拖拽编排。
- 不做跨 Agent 自动移植（只做可移植性校验）。
- 不做自动推荐（阶段 3 前）；不引入通用表达式引擎（只用 JSONPath + 5 运算符）。
- 不自动算 capability 代码 hash（统一注册方自报版本）。
