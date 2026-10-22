# 自生成与自动发现规范

## 1. 目标

系统从当前 Session 的实际工作中生成临时 Flow，并在具备复用价值时提议沉淀为正式资产：

1. Project Candidate：发现新的项目、目录、服务或外部入口。
2. Flow Candidate：从一次或多次 Run 中提炼可复用流程草稿。
3. Skill/Eval Candidate：识别需要沉淀的领域能力和回归问题。

生成过程先服务当前 Session，再决定是否进入共享 Catalog。当前工作可以立即获得结构化计划，不必预先知道标准流程。

## 2. 触发事件

```text
用户在 Session 输入新的目标
当前目录首次出现
Git remote 或外部资源未登记
Run 产生新的稳定分支
同类目标重复出现
Run 完成并形成稳定 Plan
工具调用失败或路由被用户修正
```

新目标进入 Session 后，Agent 首先提出 `ephemeral Flow`；Project Discovery、Flow Candidate 和 Skill/Eval Candidate 由 Run Event Log 触发异步任务，不阻塞当前对话。

## 3. Project Discovery 流程

```text
采集证据
  ↓
规范化标识（目录、repo、service、environment）
  ↓
去重和冲突检测
  ↓
计算置信度
  ↓
写入 Candidate Store，并生成 Catalog YAML Diff
  ↓
在当前 Session 的上下文面板提示
  ↓
用户确认
  ↓
生成 Git Diff 并登记
```

候选必须说明每个字段来自哪里：当前目录、Git remote、运行时引用、外部查询或用户输入。

高置信度表示证据充分，正式登记仍由用户确认完成。

项目字段不会因为下一次扫描而静默改写。发现任务会读取可移植的
`.codebridge/project.json`（也支持仓库根目录的 `codebridge.project.json`）来补充
`deploy_service`、`log_service`、`apm_service` 和 `dependencies`；没有证据的字段保持为空。
已登记项目出现新值时，Catalog 保存 `ProjectDrift`，Web/API 可以先预览
`catalog/projects.yaml` 的 diff，再显式选择“应用”或“仅确认”。这使代码更新、服务迁移和
依赖变化不会直接把后续工作带入错误映射。

当配置 `orchestration.projectCatalog` 后，候选可以进入真实 Git 提案流程：

```text
Candidate
  → POST /v1/projects/candidates/{id}/proposals
  → 从配置的 baseRef 创建一个新 commit 和 feature branch
  → 人工 Review
  → POST /v1/projects/catalog/sync { ref }
  → SQLite 更新为该 Git revision 的运行时投影
```

提案通过临时 Git index 和 plumbing 命令生成，不切换 CodeBridge 当前 checkout，也不写入
`main`。分支名必须由调用方显式提供，已存在的分支不会被覆盖。同步时，Git Catalog 中缺失的
既有项目只标记为 `deprecated`，不删除历史记录；因此 Git 是正式定义来源，SQLite 是可恢复的
查询投影。

## 4. 临时 Flow 生成

```text
用户目标
  ↓
Agent 理解目标、上下文和风险
  ↓
生成 ephemeral Flow
  ↓
Schema / Policy 校验
  ↓
显示步骤、分支、待确认项
  ↓
用户继续调整或创建 Run
```

临时 Flow 至少记录：

- 来源 Session 和 Run。
- Agent Profile 和模型。
- 输入摘要和上下文版本。
- 步骤、分支和能力 ID。
- 每一步的风险和审批条件。
- 生成时间和内容摘要。

临时 Flow 不自动写入共享 Workflow Catalog，也不自动获得新的能力权限。

## 5. Flow Candidate 晋级

当用户选择“保存为 Workflow”，或系统发现同一类 Flow 重复出现时，生成 Candidate：

```text
ephemeral Flow
  ↓
提取稳定步骤、分支、输入和边界
  ↓
生成 Flow Candidate
  ↓
Schema 校验、静态检查、回归评测
  ↓
用户 Review
  ↓
Git 提交并发布 Workflow
```

Candidate 必须包含：

- 适用范围和排除条件。
- 输入和上下文来源。
- 只读、工作区写入、Git 写入和生产写入边界。
- 分支事实来源。
- 预检、审批、验证和回滚要求。
- 生成来源、内容摘要和版本。

一次偶然的 Agent 操作只能形成 ephemeral Flow；重复出现、边界清晰且通过评测后，才适合发布为 Workflow。

## 6. Skill Candidate 与评测

当出现以下情况时生成 Skill Candidate：

- 多个 Workflow 重复使用同一领域知识。
- 同一个系统的 ID 解析、查询和安全边界重复出现。
- Agent 经常把相邻 Skill 路由错误。
- 工具调用需要稳定的输入校验和结果解释。

Skill Candidate 先进入 Skill Review；补充正例、近邻反例和排除条件后，才能进入中央 Router。

## 7. 自生成安全边界

生成内容统一经过以下边界：

```text
生成
  → Schema
  → Policy
  → 风险和权限检查
  → 用户确认或 Review
  → Git 版本化
  → 发布
```

模型生成的 Flow 不能自行创建凭据、提升生产权限、写入未验证的项目映射或修改已发布 Workflow。运行时不自我改写生产行为；自生成是提案和沉淀机制。

## 8. 反馈闭环

```text
Session / Run 事件
  → 失败、误判或用户修正
  → Flow / Eval Candidate
  → 路由和 Flow 回归
  → Review
  → 更新 Skill / Flow / Workflow
```
