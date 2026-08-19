# Flow 阶段 1 真闭环：Runtime 执行主路径

- Status: Pending user review
- Date: 2026-08-19
- Branch: `feat_flow`（从 `origin/main` `84e01b3` 切出）
- Scope: `apps/bridge/src/session-runtime-api.ts`, `apps/bridge/src/flow-api.ts`, `apps/bridge/src/cli.ts`, `packages/flow-catalog`, `packages/workflow-engine`, `packages/run-executor`, `packages/policy`, `packages/work-items`
- Related: `docs/orchestration/flow-design.md`（产品北极星）, `docs/superpowers/specs/2026-08-13-flow-design.md`（契约与分期）, `docs/spec/RULES.md`（`PROTO-FLOW-*`）
- 本文件是阶段 1「跑闭环」的**目标规格**。不写实现步骤。实现计划在本文件审过之后另写。

## 0. 决策

主路径选 **A：绑定 published runbook 之后，执行权归 Runtime**。

- 不是 B：Agent 继续当执行器。验收里的「执行器只认冻结 PlanIR」「同 attribution 重放轨迹一致」在 LLM 执行下按定义不成立。B 等于宣布本轮过不了，下一刀还得改主路径。
- 不是 C：只让 `POST .../runs` 走 Runtime、聊天路径继续 Agent。本轮定义就是「用户走现在的主路径（Web 选 Flow → 发消息）系统不再撒谎」。C 留一条不诚实遗留面，摊薄焦点。

分工回归北极星：LLM 提议（抽参候选、解释结果）/ Runtime 决策（绑定、校验、执行）/ Verifier 判定（`success_when`）。阶段 2 的审批门只能挂在 Runtime 说了算的路径上。

## 1. 北极星（不改）

Flow 是参数化、版本冻结、结果可验证的可执行契约，不是保存聊天步骤。

一次成功的 **runbook** 执行必须留下：

```text
绑 published Flow
  → 缺参则机器可校验地追问（点名 missing key），禁止 LLM 替填
  → PARAM_RESOLVED（值 + 来源 + resolver 版本）
  → 从 catalog steps 完整重编译 PlanIR 并与 plan_ir_hash 比对（对不上拒绝；禁止残缺重编译）
  → ResolvedPlan
  → 确定性执行（capability adapter → success_when）
  → RUN_SNAPSHOT（含归因块）
  → 失败则 VERIFICATION_FAILED（四分类；actual ≤4KB）
```

「越用越准」靠这条证据链。阶段 2 评审/审批 token、阶段 3 推荐，本轮不算。

## 2. 本轮做完的定义

用户在 Web 选 published runbook、发消息，系统走上面那条链，不再把 Flow 当 Agent 提示词。

1. 只有 `published` 真跑；`candidate` 只能 dry-run；`deprecated` 拒绝新 Run（`PROTO-FLOW-001`）。
2. 执行点从 catalog 存储的 steps（含完整 `inputs` / `success_when`）重编译 PlanIR，计算 hash，与 `plan_ir_hash` 比对，不一致拒绝。typed `inputs` 与 `success_when` 不得在落库时丢失，否则验收 5 的篡改检测会被残缺重编译掩盖。存储的 IR 本体若存在，仅作审计参考，不作为加载入口。
3. 绑定态 runbook **禁止** Agent 执行步骤。缺 adapter / 未知 capability = 步骤失败，不是静默转交 Runner。
4. 风险从 PlanIR 步骤来，禁止把 Web 提交的 `riskLevel` 写死为 `read_only`。
5. 一次成功跑通留下 `PARAM_RESOLVED` + `RUN_SNAPSHOT`；后验失败留下带截断的 `VERIFICATION_FAILED`。
6. 同 attribution + 同 resolved_inputs 重放，决策轨迹一致。
7. 幂等键尊重 `validity_window`（窗口内去重，窗口外当新操作）。
8. dry-run 转正复用 ResolvedPlan，不重新抽参。

## 3. 地基（仓库能确认 vs 不能确认）

写本规格前对着代码核对。下面每条都标明证据。**本轮目标不得建立在仓库里不存在的 adapter 或本机 sqlite 里「也许有」的 MCP 批准上。**

### 3.1 Capability：启动时空的，缺了会落到 Agent

仓库能确认：

- `apps/bridge/src/cli.ts`：`CapabilityRegistry([], { databasePath: .../capabilities.sqlite })`，`new CapabilityRuntime()` 无内建 adapter。
- 进程内真正能 `execute` 的 adapter，目前只有 MCP `approveCandidate` 之后注册的 `McpCapabilityAdapter`（`packages/mcp-runtime`）。
- `SkillCapabilityAdapter` 的 `execute` 固定 `forwardToAgent: true`，不是确定性执行。
- `RunExecutor.executeCapability`：registry 没有定义、或 runtime 没有该 adapter → **返回 `undefined`**。
- `executeStepOnce`：`undefined` 或 `forwardToAgent` → **调用 Runner（Agent）**。有真实 adapter 结果才 `return`，不进 Agent。
- `session-api.ts` 在开 Run 时对缺失 capability **隐式** `register({ adapter: "agent" })`。这只写 registry，runtime 仍没有 `"agent"` adapter，结果还是落到 Agent。对 runbook 这是兜底漏洞，不是能力覆盖。
- `compileWorkflow` **不检查** capability 是否已注册。未知 ID 可以编译、可以存 candidate、可以 published。
- `mode: manual` 步骤 `capabilityId` 为空 → `executeCapability` 返回 `undefined` → 同样落入 `runner.run`。与 4.1「绑定态只走 adapter」矛盾，故本轮 published 禁止 manual 步骤。
- 仓库里的 `equity.deliver` / `catalog.lookup` 只出现在测试夹具，**不是** Bridge 启动清单。

仓库不能确认：

- 本机 `capabilities.sqlite` 里用户是否批准过 MCP tool。那是运行时数据，不进 git，不能当本轮库存。
- 配置中心里有没有未入库的领域 adapter。没有源码就当不存在。

本轮最大交付风险因此不是「执行器会不会跑步骤」，而是：**没有可发布的领域 Flow，除非本轮自己提供可执行 adapter，或用户环境里已批准 MCP。验收不能赌后者。**

### 3.2 PlanIR：hash 在，IR 本体不在；加载路径会丢掉契约

仓库能确认：

- `POST /v1/flows/candidates` 服务端计算 `definitionRevision` 与 `planIrHash`（`PROTO-FLOW-REVISION-001` 的写入侧基本成立）。
- catalog 存 `plan_ir_hash` + `inputs` + `steps`，**不存 PlanIR JSON**。
- candidate 落库的 `steps` 映射丢掉 `successWhen`（`flow-api.ts` 的 `plan.steps.map`）。`FlowStep` 类型也没有该字段。
- 主路径 `session-runtime-api.ts` 的 `flowDefinition()` 与旧路径 `toWorkflowDefinition()` 都把 `inputs: []`，再 `compileWorkflow`。执行点重编译，且编译输入残缺。
- `toApiFlow` 不返回 `plan_ir_hash` / `inputs`。
- `POST /v1/flows/:id/review` approve 把 `definitionRevision` 改成 `git:…`，覆盖内容 hash，和 `PROTO-FLOW-REVISION-001` 冲突。本轮不修完整评审流，但 **禁止再把内容 hash 覆盖成 git 指针**；`git_revision` 只作为并列字段。

### 3.3 门禁：只拦 deprecated

仓库能确认：

- `apply`、session 发消息、旧 `POST .../runs` 都只 409 `flow_deprecated`。`candidate` 可以绑定并开 Run。
- Web 提交 `workItem.riskLevel: "read_only"` 写死，Plan 外的 `production_write` 等待不会在主路径触发。
- 有 Plan 时 RunExecutor 逐步跑；无 adapter 时每步仍进 Agent，门禁形同虚设。

### 3.4 学习信号：类型在，生产者几乎没有

仓库能确认：

- `PARAM_RESOLVED` / `RUN_SNAPSHOT` / `VERIFICATION_FAILED` 等类型在 `packages/work-items`。
- 过程事件有 `FLOW_SELECTED` / `FLOW_SAVED_AS_CANDIDATE`。
- 执行路径会发 `VERIFICATION_FAILED`，但 `category` 固定 `verification`，`truncated: false`，`actual` 不截断。
- `PARAM_RESOLVED` / `RUN_SNAPSHOT` **没有 append 生产者**。
- 幂等键用 `workItem.identifiers`；注释写明 `no ResolvedPlan producer yet`；`validity_window` 未过期。

## 4. 三条必须钉死的边界

### 4.1 绑定后 Agent 降权

会话状态机（runbook）：

| 状态 | 谁跑 | Agent 允许做什么 | Agent 禁止做什么 |
| --- | --- | --- | --- |
| 未绑定 | Runner 现路径 | 自由对话 | 不得因为用户口头描述就像某 Flow 就去执行该 Flow 的步骤 |
| 已绑定、参数未齐 | **不**调 Runner 执行 PlanIR | 可选：只输出 JSON 参数候选（永远是 candidate） | 调用工具/改文件/「顺手把流程跑了」；把 candidate 当 final |
| 已绑定、参数已齐、published | 只走 RunExecutor + adapter | 执行结束后解释 `RUN_SNAPSHOT`（只读事件） | 执行步骤；缺 adapter 时顶上 |
| 已绑定 candidate | 只允许 dry-run | 同上解释 | 真跑副作用 |
| 已绑定 deprecated | 拒绝 | 无 | 无 |

硬规则：

- `executeStepOnce`：runbook 步骤在 capability 未执行成功时 **不得** 进入 `runner.run`。缺定义 / 缺 adapter = 失败（`unknown_capability` 或等价），不是 Agent 兜底。
- 禁止再为 runbook 隐式 `register({ adapter: "agent" })`。
- `SkillCapabilityAdapter`（`forwardToAgent`）**不算** runbook 覆盖。含 skill 步或 **manual 步** 的 Flow 不能 published（见 4.2）。manual 的暂停/人工确认语义本轮不定。
- **guide** 本轮不走确定性执行器。绑定 guide 的语义保持「指针 + Agent 参考」，不宣称可重放。guide 不得标 `production_write`。本轮验收只认 runbook。
- 未绑定消息维持现 Agent 路径。用户在未绑定会话里复述某 runbook 的步骤，Runtime 仍不当 Flow 执行。

### 4.2 Capability 覆盖是发布门槛

发布（`status: published`）当且仅当：

1. `kind === "runbook"`。
2. **不得含 manual 步骤**（与 skill 步同等：candidate 可存，不得 published）。每个非 branch 步骤的 `capabilityId` 在 **CapabilityRegistry 有定义**，且 **CapabilityRuntime 有 adapter**。
3. 该 adapter 的 `execute` 在非 dry-run 下能完成步骤（不得依赖 `forwardToAgent`）。
4. 每步声明 `success_when`，且能静态通过 `validatePostcondition`。
5. 写步骤（`side_effects: true`）的 adapter 实现 dry-run 分支；否则该 Flow 禁用预演，也不得在需要预演的发布通道过关。本轮 fixture 用只读 adapter，避免这条挡住验收。
6. 从 catalog 存储的完整 steps 重编译，所得 hash 与 `plan_ir_hash` 一致。不把存储的 IR 本体当加载入口。

不满足 → 留在 `candidate`，只许 dry-run（无 adapter 时 dry-run 也失败，必须把失败暴露出来，不得转 Agent）。

**本轮 capability 清单（验收用，写进仓库，不依赖本机 MCP）：**

| ID | 用途 | kind | risk | side_effects | 本轮是否提供 adapter |
| --- | --- | --- | --- | --- | --- |
| `demo.echo` | 原样返回输入 `text` | function | read_only | false | **是，Bridge 启动注册** |
| `demo.concat` | 把 `prefix` + 上步/`text` 拼成 `result` | function | read_only | false | **是，Bridge 启动注册** |

验收 Flow：`flow_demo_echo`（runbook）。输入至少一个 required string（如 `text`）。两步：`echo`（`demo.echo`，`success_when: output.text exists`）→ `concat`（`demo.concat`，`success_when: output.result exists`）。无 manual / skill 步骤。`success_when` 必须是编译期静态表达式，不得把本次 Run 的参数值写进表达式。不引用 `equity.*` / `order.*` / `deploy.*` / `dcp.*`。

领域 Flow（权益、仓配、发布）**允许**存 candidate，**不允许**在本轮 published，直到对应 capability 以同样门槛注册。本规格不假装那些 adapter 已存在。

MCP 批准的 tool：可以计入「该环境的覆盖」，用于用户本机发布，**不计入 CI 验收**。CI 只认 `demo.*`。

### 4.3 缺参确认流（机器可校验）

Runtime 在开执行之前计算：

```text
missing = required inputs − 已绑定 resolved inputs − 可注入的 context/default
```

> context/default 注入机制本轮不实现（本轮 fixture 全部 `source: user`）。`source: "context"` 或 `"default"` 的 required input 若出现在未来的 Flow 中，须在**阶段 2** 先定义注入机制再发布；本轮将其视为未覆盖输入，不静默放行。

`missing` 非空：

- 不创建执行 Run（或不进入 `executePlan`）。
- 返回结构化错误，例如 `409 missing_inputs`，body 列出 `{ id, type, source, reason }`。
- **禁止**调 Runner 让 LLM 猜值写入 ResolvedPlan。
- Agent 抽参若做：输出只能是 `candidate_value` 列表；必须再经用户确认才变成 `final_value`。本轮验收 **不依赖** Agent 抽参。

用户补参：下一条消息或专用确认请求带 `inputs: { text: "..." }`（机器字段，不是自然语言解析当唯一来源）。绑定成功后写 `PARAM_RESOLVED`：

- `source: user` 且未改默认 → `resolution: confirmed`
- 改过候选/默认 → `resolution: edited`
- `agent_extracted` 未确认 → 不得进入 ResolvedPlan

禁 LLM 预填仍有效：`secret_ref`、production 环境值、审批规则、workspace 授权范围。

## 5. 执行与冻结

- 编译点：保存 candidate / 发布前重编译。产物是四元组 `(flow_id, definition_revision, plan_ir_hash, compiled_at)`。落库的 `inputs` + `steps` 必须足以无损重编译（含 `success_when`）。存储的 IR 本体仅作审计参考，不作为加载入口。
- 执行点：从 catalog 存储的 steps 重编译 → 计算 hash → 与 `plan_ir_hash` 比对，不一致拒绝执行。禁止 `flowDefinition()` / `toWorkflowDefinition()` 那种残缺重编译。存储的 IR 本体仅作审计参考，不作为加载入口。
- 若有人改了 catalog steps 但没更新 `plan_ir_hash`：重编译 hash ≠ `plan_ir_hash` → 拒绝执行（验收 5）。盲信存储 IR 本体则检测不到这次篡改。
- `definition_revision` 保持内容 sha256。`git_revision` 若需要，只并存，不替换。
- ResolvedPlan：每个 input 带 `value + source + resolver_version`（及 directory 的 `authorization_ref`）。幂等键从 ResolvedPlan 字段派生，不再从 `workItem.identifiers` 凑。
- dry-run：candidate 预演必须走 `executeCapability` 且 `context.dry_run: true`，与真跑共享同一执行函数；禁止经 `replayPlan` 或任何 continue-skip 路径。缺 adapter 预演同样失败（`unknown_capability`），禁止跳过、禁止转 Agent。转正时同一 ResolvedPlan，不重抽参。`replayPlan` 仅用于验收 6 的 SNAPSHOT 重放，不是预演入口。
- 幂等：读 `validity_window`；过期后同 key 视为新操作。本轮 fixture 只读，窗口行为用带 `side_effects: true` 的测试 adapter 覆盖，不必上生产写。

## 6. 学习信号（本轮必须真正写入）

| 事件 | 何时写 | 本轮最低字段 |
| --- | --- | --- |
| `PARAM_RESOLVED` | 每个 input 从 candidate 变为 final | spec §5.1；`flow_revision` = `plan_ir_hash` |
| `RUN_SNAPSHOT` | runbook 终态（成功或失败） | `resolved_inputs`、步骤轨迹、`outcome`、attribution；`output_ref` 必须 `artifact://` |
| `VERIFICATION_FAILED` | `success_when` 未通过，或 adapter/基础设施/策略失败 | 四分类；`actual` JSON 序列化 >4KB 则截断且 `truncated: true` |

`FLOW_RECOMMENDED` / `FLOW_REJECTED` 本轮不生产（阶段 3）。过程事件 `FLOW_SELECTED` 等保留。

归因块：`flow_revision` = `plan_ir_hash`。本轮 fixture 无 prompt 模板、无工具 schema 变化：`prompt_revision` / `tool_schema_revision` 可用固定占位 hash（文档写死占位规则），但字段必须存在。`capability_revisions` 用注册方自报版本（`demo.*` 在代码里写死 `1`）。

## 7. 非目标

- 阶段 2：审批 token 绑四元组防 TOCTOU、评审 UI 语义 diff、打回原因回流。编译期 `production_write ⇒ approval: required` 已有，保持；本轮 **不上** 生产写 Flow。
- 阶段 3：推荐、golden-run 产品化对账、准确率看板。`replayPlan` 仅作 SNAPSHOT 确定性重放（验收 6），不是 candidate 预演入口。
- DAG 编辑器、对话识别前缀注入、`flow_get` 懒加载、独立「运行 Flow」页、参数表单卡片。
- 为磐石业务实现 `equity.*` / `order.*` / `deploy.*` adapter。
- 把 guide 改造成可重放 runbook。
- 循环、并行、补偿、定时器。

## 8. 验收

CI / 本地可重复，不依赖本机 MCP sqlite：

1. 启动后 registry+runtime 含 `demo.echo`、`demo.concat`。缺少任一条的 Flow 不能 published。
2. 发布 `flow_demo_echo`；Web 主路径（`POST /v1/sessions/:id/messages`）绑定后补齐 `text`，不经过 Runner 执行步骤，跑完有 `PARAM_RESOLVED` + `RUN_SNAPSHOT`。
3. 缺 `text` 时 409 `missing_inputs`，且该次请求不创建 Agent run。
4. `candidate` 同 Flow 真跑被拒；dry-run 走 `executeCapability` + `dry_run: true`，可跑只读步骤；不得调用 `replayPlan` 充当预演。
5. 改 catalog steps 但不更新 `plan_ir_hash` → 执行拒绝（重编译比对，不读存储 IR 本体）。
6. 同 SNAPSHOT 重放，决策轨迹一致。
7. 人为让 `concat` 的 `success_when` 失败 → `VERIFICATION_FAILED`，`category: verification`，超长 `actual` 截断。
8. 测试用写 adapter 覆盖：窗口内幂等命中、窗口外新操作；dry-run 转正不重抽参。
9. 未绑定会话发消息仍走现 Agent 路径（回归：不把所有消息改成 Flow 执行）。

## 9. 与旧文档的关系

- `flow-design.md` 北极星与不变量有效。其 P0 里的「审批 token」仍属阶段 2，本轮不做。
- `2026-08-13-flow-design.md` 阶段 0 契约与阶段 1 **积木**已在 main；阶段 1 **闭环验收**以本文件为准。旧计划 checkbox 未勾不代表已闭环。
- `PROTO-FLOW-*` 继续有效。本轮补的是执行与门禁，不是改契约形状。

## 10. 自审

- 无 TBD：capability 清单、主路径、Agent 降权、缺参协议、非目标均已选定。
- 不假设本机 MCP 库存。
- guide / 未绑定 / 领域 Flow 的行为已分开，避免 A 被 Agent 兜底掏空。
- published 禁止 manual / skill；预演禁止走 `replayPlan`；执行点禁止盲信存储 IR。
