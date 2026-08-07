# 交互建议

## 1. 产品定位

Web 是完整工作台；飞书和 Telegram 是轻量入口、进度通知和审批通道。三者共享同一个 Conversation、WorkItem 和 Event Stream。

## 2. Web 核心页面

### 新建 Work

```text
Agent       Pi Investigator / Pi Developer / Claude Reviewer
Workspace   已注册项目或“自动发现”
Workflow    已发布 Guide/Runbook，或“不选择”
Mode        调查 / 修改 / 发布计划
```

不选择 Workflow 时，应明确显示“探索模式”，让用户知道流程会由 Agent 在调查后生成。

### Workbench

建议使用三栏，而不是堆叠很多卡片：

```text
左：Conversation / WorkItem 列表
中：对话和当前任务进度
右：Context、项目、证据、Plan、审批、Diff
```

右侧面板可以切换：

- Context：目标、标识、假设、待确认问题。
- Projects：已注册项目和新发现候选。
- Plan：步骤、当前分支、下一步。
- Evidence：日志、SQL 结果、代码位置、线上版本。
- Changes：Git diff、测试结果、ReleaseSet。

### 项目发现卡片

```text
发现新项目 equity-center
代码：已从 Git remote 确认
DCP：已找到对应服务
日志：已找到 LogStore
置信度：高

[加入当前 Work] [注册到 Catalog] [查看证据] [忽略]
```

用户不需要手工填写字段，只有冲突字段才进入编辑状态。

### 审批交互

审批必须显示：

- 将要执行的动作。
- 目标项目和环境。
- 输入摘要和影响范围。
- 预期结果。
- 回滚方式。
- 过期时间。

按钮使用明确动词：`批准执行`、`拒绝`、`修改计划`，避免只显示“确定”。

## 3. 飞书和 Telegram

建议支持：

```text
/task 新问题：...
/status
/plan
/approve
/reject
/projects
/save-workflow
```

长内容、代码 Diff 和证据详情提供 Web 链接；消息通道只显示摘要、进度和需要用户决定的内容。

## 4. 任务边界

如果检测到目标、项目或环境明显变化，提示：

```text
这可能是一个新 WorkItem：
当前：会员权益排查
新输入：生产改价

[继续当前任务] [创建新任务]
```

不能因为模型判断就静默切换任务。

## 5. 必备状态

所有异步操作都需要完整状态：

```text
queued / running / waiting / succeeded / failed / cancelled
```

每个状态都要有：

- 当前阶段。
- 最近一次事件。
- 下一步动作。
- 预计是否需要用户输入。
- 失败时的恢复建议。

## 6. 空、加载和错误状态

- 空状态：说明如何创建第一个 WorkItem，不显示无意义的占位数据。
- 加载状态：使用与内容结构一致的 Skeleton，不使用无限旋转掩盖等待。
- 错误状态：说明失败对象、已完成步骤、可重试性和人工处理入口。
- 权限等待：明确显示“等待系统目录授权”或“等待生产审批”，不能只显示连接中。
