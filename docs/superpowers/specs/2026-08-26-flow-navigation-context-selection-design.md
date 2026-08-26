# Flow 导航与 Session Candidate 上下文选择设计

状态：Accepted

日期：2026-08-26

## 1. 问题与事实

活跃 Web 中，点击左侧 `Flows` 只更新 `area` 和左栏，主区仍因存在 `selectedSession` 而渲染 `Session conversation`。显式点击 Candidate 虽然更新了 `detailFlow`，详情仍被插入会话时间线顶部，用户位于底部时看不到任何变化。

`detailFlow` 又会保留上一次选择，因此从仓配 Session 进入 Flows 时，另一个 Session 的 `channel-package-build-compare` 被继续高亮，看起来像 Candidate 串线。

数据库与活跃 API 已核验：仓配 Candidate `flow_save_497fd225fbde4d6297b1707e64752646` 的 `source_session_id`、`source_run_id`、`source_request_id` 均正确；错误只在 Web 导航与选择状态，不修复 Catalog、不重建 Candidate。

## 2. 不变量

1. `area=flows` 时，主区必须是 Flow 工作区，不能继续显示 Session conversation。
2. 进入 Flows 不删除或改写当前 Session 选择；返回 Agent 后仍回到原 Session。
3. 从活跃 Session 进入 Flows 时，优先打开该 Session 最新更新的 Candidate。
4. 没有关联 Candidate 时显示明确的 Flow 选择态，不复用其他 Session 的旧高亮。
5. 显式打开 Candidate 时，以用户选择的 `flow_id` 为唯一身份，并切换到 Flow 工作区。
6. Candidate 加载失败时不保留错误 Candidate 的选中态；现有已成功详情不被错误响应覆盖。
7. 不改变 Flow Save Intent、Catalog、Agent、飞书或 Telegram 合同。

## 3. 方案

### 3.1 Flow 工作区路由

Workbench 的主区按 `area` 优先路由：

- `skills`：Skill Control Plane；
- `settings`：设置；
- `flows`：待生成详情、Flow 详情或空选择态；
- `agents`：Session conversation 或 Agent 空态。

`selectedSession` 只决定 Agent 工作区的内容，不再阻止 Flow 工作区显示。

### 3.2 上下文 Candidate 选择

点击全局 `Flows` 时：

1. 保留 `selectedSessionId`；
2. 清除待生成请求的局部选择；
3. 从当前已加载的 `flows` 中筛选 `status=candidate` 且 `provenance.source_session_id === selectedSessionId`；
4. 按 `updated_at DESC`、`flow_id` 稳定排序，选择最新一条；
5. 找到时通过现有 `openFlow(flow_id)` 读取 review context；找不到时清除旧 `detailFlow`，显示选择态。

点击 Flow 列表或 Session 中的“打开并预演”时，`openFlow` 成功后将 `area` 切到 `flows`。请求期间不提前提交错误选中态；失败沿用现有错误展示。

### 3.3 空选择态

Flow 工作区没有待生成请求或 `detailFlow` 时，显示“从左侧选择 Flow 或待生成请求”。不自动选择无关 Flow，不清空 Session。

## 4. 错误与竞态

- `openFlow` 继续使用现有 `expectedSessionId` 门禁，Session 切换后的晚响应不得覆盖新上下文。
- 从全局 Flows 入口发起的上下文选择捕获当时的 Session ID；若选择变化，晚响应丢弃。
- 关联 Candidate 加载失败时显示错误，但 `detailFlow` 保持为空，避免旧 Flow 继续高亮。
- 直接点击另一个 Flow 是显式用户动作，不受来源 Session 过滤。

## 5. 测试与验收

合同层：

1. active Session + 关联 Candidate：点击 Flows 后主区显示该 Candidate，Session conversation 不存在。
2. 多个关联 Candidate：选择 `updated_at` 最新者；时间相同按 `flow_id` 稳定决定。
3. 无关联 Candidate：主区显示空选择态，旧 Candidate 不高亮。
4. 点击任意列表 Candidate：显示精确 `flow_id` 的详情。
5. Session 卡片“打开并预演”：切到 Flow 工作区并显示精确 Candidate。
6. 返回 Agent：原 Session 仍选中。
7. 加载失败与 Session 切换晚响应：不污染选择。

活跃表面：在运行中的 Workbench 复现仓配 Session，点击 Flows 后应自动选中“仓配发货单下发异常通用排查修复”，主区出现 Flow 管理详情；不得继续高亮 `channel-package-build-compare`。

## 6. Surface Matrix

| Surface | entry | read path | write path | event consumption | error/recovery | terminal feedback | 状态与落点 |
|---|---|---|---|---|---|---|---|
| Web | Flows rail、Candidate 列表、打开并预演 | `GET /v1/flows?view=manage`、review-context | 既有 review/save/apply；本设计不新增 | 既有 Session/Inbox 消费不变 | expectedSession 门禁、错误提示、空选择态 | Candidate 详情/管理面板 | implemented + reachable；本任务完成后 closed-loop |
| Agent | 无新增入口 | N/A | N/A | N/A | N/A | N/A | 既有能力不变 |
| 飞书 | 既有“Web → Flows → 待生成” | N/A | N/A | 既有 FLOW_SAVE_REQUESTED | N/A | 跳转目的地由 Web 修复 | implemented/reachable，不复制导航逻辑 |
| Telegram | 既有提示，当前禁用 | N/A | N/A | 既有实现 | N/A | N/A | implemented/tested/planned，保持 disabled |

## 7. 非目标

- 不修改 observed trace 的步骤提取质量。
- 不迁移、删除、重建已有 Candidate。
- 不改变 Flow Save Intent 状态机、幂等键或事件载荷。
- 不启用 Telegram。
