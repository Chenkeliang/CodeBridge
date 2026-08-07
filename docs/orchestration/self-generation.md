# 自生成与自动发现规范

## 1. 目标

系统可以从实际工作中生成三类候选资产：

1. Project Candidate：发现新的项目、部署服务、日志入口。
2. Workflow Candidate：从一次或多次任务中提炼流程草稿。
3. Skill/Eval Candidate：识别需要沉淀的领域能力和回归问题。

“自生成”只生成候选，不直接把模型输出变成生产规则、正式 Workflow 或可执行权限。

## 2. 触发事件

```text
当前目录首次出现
Git remote 未登记
DCP/SLS/APM 查询发现新服务
WorkItem 跨项目调用
同类任务重复出现
任务完成并产生稳定 Plan
工具调用失败或路由误判
```

这些事件由 WorkItem Runtime 写入 Event Log，再由后台 Discovery Task 异步处理，不阻塞当前对话。

## 3. Project Discovery 流程

```text
采集证据
  ↓
规范化标识（repo、service、log、environment）
  ↓
去重和冲突检测
  ↓
计算置信度
  ↓
写入 Candidate Store，并生成 Catalog YAML Diff
  ↓
提示用户确认
  ↓
生成 Git Diff
  ↓
注册或驳回
```

候选必须说明每个字段来自哪里：当前目录、Git remote、DCP 查询、SLS 查询、代码引用或用户输入。

高置信度不代表可以静默覆盖正式配置。默认策略仍是“自动发现、人工确认、Git 记录”。

## 4. Workflow Candidate 流程

任务完成后，系统对本次事件和 Plan 做归纳：

```text
WorkItem completed
  ↓
提取实际步骤和工具调用
  ↓
区分固定步骤与偶然步骤
  ↓
提取输入、分支、审批和验证
  ↓
生成 Workflow Candidate
  ↓
用户 Review
  ↓
加入 Git 并建立评测案例
```

候选 Workflow 必须包含：

- 适用场景和排除场景。
- 必填业务标识。
- 只读步骤和写入步骤。
- 分支事实来源。
- 预检、审批、验证和回滚。
- 至少一条真实成功案例和一条近邻反例。

不要因为一次偶然操作就固化流程。只有路径稳定、边界清晰、重复出现后，才适合发布为 Runbook。

## 5. Skill Candidate 与评测

当出现以下情况时，生成 Skill Candidate：

- 多个 Workflow 重复使用同一领域知识。
- 同一个系统的 ID 解析、查询和安全边界重复出现。
- Agent 经常把相邻 Skill 路由错误。
- 工具调用需要稳定的输入校验和结果解释。

Skill Candidate 先进入业务 Skill 的 Review 流程；必须补充正例、近邻反例和排除条件，才能进入中央 Router。

## 6. 自生成的安全边界

模型不得自动生成并启用以下内容：

- 生产凭据。
- 无审批的生产写入能力。
- 任意 Shell 脚本。
- 未验证的项目映射。
- 未经过评测的高风险 Workflow。
- 自动修改现有 Workflow 的正式版本。

生成内容统一进入 Candidate 状态，经过 Schema、静态检查、回归评测和用户确认后才成为正式资产。

## 7. 反馈闭环

```text
执行记录
  → 失败/误判/用户修正
  → 生成 Eval Candidate
  → 运行路由和 Workflow 回归
  → Review
  → 更新 Skill/Card/Workflow
```

运行时不自我改写生产行为。自生成是“提案系统”，不是“自修改系统”。
