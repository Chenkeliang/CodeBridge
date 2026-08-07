# 项目规范

## 1. 事实源和职责

| 内容 | 唯一事实源 |
|---|---|
| Go/Python 项目代码 | 各自项目的 Git 仓库 |
| 业务 Skill | `keliang-business-skills` |
| Skill 校验、路由评测、发布编译 | `skill-control-plane` |
| Agent/Workspace/Catalog/Workflow 定义 | CodeBridge Git 仓库 |
| Session/TaskRecord/Run 状态 | CodeBridge Runtime SQLite |
| 日志/APM/DCP 线上事实 | 对应线上平台 |

不要把运行时状态写回 Git，也不要把 Skill 内容复制到多个项目后分别维护。

## 2. 标识符规则

- `project_id`、`workflow_id`、`skill_id`、`agent_id` 使用小写 kebab-case。
- 业务订单号、SKU、UID 等外部标识原样保存，不做隐式截断或格式化。
- 任何从自然语言推断的标识都必须保存 `source`、`confidence` 和 `observed_at`。
- 不能用展示名称替代稳定 ID；展示名称可以变化，ID 不应随意变化。

## 3. 配置规则

- 不写本机绝对路径；使用 `host_binding`、环境变量或项目目录别名。
- 不在 Workflow 里写凭据、Token、生产连接串。
- 不在核心代码里硬编码项目之间的调用路径。
- 能力通过 `capability_id` 引用，由运行时绑定到 Skill、MCP、CLI 或 HTTP Adapter。
- 每个定义包含 `schema_version`，变更采用向后兼容或显式迁移。

## 4. 风险规则

```text
read_only        查询、代码阅读、日志、APM
workspace_write  修改工作区和本地测试
git_write        commit、push、创建 MR
production_write 配置、发布、回滚、第三方回写
```

风险级别由能力定义决定，不能仅由用户选择的 Workflow 决定。高风险动作必须经过预览、审批、幂等检查和结果验证。

## 5. 变更规则

每个 Workflow/Catalog 变更必须包含：

- 变更原因。
- 影响的 ID。
- 兼容性说明。
- 至少一个正例和一个近邻反例。
- 需要执行的校验命令。

运行时发现项目新信息时，先写入 Candidate Store，并生成面向 CodeBridge Catalog 的 Git diff；正式注册需要 Review。不要因为一次 Agent 查询就直接覆盖正式配置。

## 6. Git 分支和提交规则

每个小功能、修复或规范变更都必须拥有独立的特性分支。分支从生产基线创建：优先使用 `main`，没有 `main` 时使用 `master`；不能从 `develop`、`release` 或其他集成分支派生。

- 开始工作前确认当前分支；禁止直接在 `main`、`master`、`develop`、`release` 等共享分支修改。
- 一个小功能完成并通过对应校验后，先提交到自己的特性分支；提交内容保持单一目的，不混入无关改动。
- 功能尚未完成时可以继续在特性分支追加提交，不把半成品提交到 `main`。
- 功能完成后，由用户确认或明确授权，才允许将特性分支合并或提交到 `main`。
- 用户未授权时，只保留特性分支和本地提交，不执行 push、合并或对共享分支的写入。
- 多个互不依赖的小功能使用不同分支；跨功能依赖必须在变更说明中标注。

推荐流程：

```text
main/master
    ↓
feat/<small-feature>
    ↓  每个小功能完成后提交并验证
用户确认 / 明确授权
    ↓
main
```

## 7. 失败和恢复

- 每个 Step 需要唯一 `idempotency_key`。
- 工具调用必须产生事件，不以聊天文本作为状态事实。
- 进程重启后从 SQLite Event Log 恢复未完成的 Run，并更新关联 TaskRecord。
- 不确定的分支进入 `manual_review`，不自动猜测。
- 厂商 Agent Session 负责原生会话恢复；Run 的进度和证据恢复依赖 ContextSnapshot 与 Event Log。
