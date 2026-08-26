# Provider Session 历史导入与 Web 防溢出设计

> Status: Implemented and verified  
> Date: 2026-08-25  
> Branch: `codex/fix-session-history-overflow`

## 1. 目标

修复两个已经在生产入口复现的问题：

1. Web 能发现 Codex、Claude、Cursor 等 Provider Session，却只展示标题和目录，无法展示已有历史；
2. Session 标题、排队消息或用户消息过长时，Footer Grid 的最小内容宽度被撑大，Queue、Composer 和操作按钮溢出可视区域。

完成后，用户可以在 Web 中明确预览并确认导入 Provider 历史，同时任何合法文本都不能把 Session 主布局撑出视口。

## 2. 已核实事实

截图中的 Session `sess_6c9d9dbc38314d32a3b957c9cebcb84a` 已绑定 Codex Provider Session `01a02312-1e44-7c80-87db-429105c04bb9`：

- Provider 原始文件存在，约 5.3 MB；
- Bridge Preview 可解析 401 条可导入事件；
- Session 的 `task_record_id` 为 `null`；
- Timeline、Session Turn 和 `provider_history_imports` 均为空。

当前 `POST /v1/sessions/import` 只发现和同步 Provider Session 元数据。真正的历史写入已经拆为：

- `POST /v1/sessions/:session_id/provider-history/preview`：只读预览；
- `POST /v1/sessions/:session_id/provider-history/import`：确认后幂等导入。

Bridge 和 Runner 能力已实现并可达，但 Web 没有调用方，因此用户链路未闭环。

## 3. 产品合同

### 3.1 发现不等于导入

- Provider Session 被发现后可以进入 Catalog 和 Session 列表；
- 发现元数据不代表历史已经写入 CodeBridge；
- Web 不得把“历史尚未导入”伪装成“新建的空 Session”。

### 3.2 GET 保持纯读取

打开 Session、读取 Timeline 和刷新页面不得隐式访问 Provider 或写 SQLite。

Web 选中带 `provider_session_id` 的 Session 后，显式调用只读 Preview。只有用户确认后，才调用 Import 写入 CodeBridge。

### 3.3 导入状态

Web 使用以下互斥状态：

| 状态 | 用户可见行为 |
|---|---|
| `previewing` | 显示正在检查 Provider 历史，不显示“新 Session”空态 |
| `available` | 显示可导入事件数量和“导入历史”按钮 |
| `importing` | 禁用重复操作，显示导入进度 |
| `imported` | 重新读取 Session 快照并展示 Timeline |
| `empty` | 明确提示 Provider 没有可导入的新历史 |
| `error` | 显示可恢复错误和“重试检查”按钮，不吞掉错误 |

每次选择 Session 只保留当前 Session 的请求结果。用户切换 Session 后，旧 Preview 或 Import 的晚返回不得覆盖新 Session 状态。

### 3.4 幂等与刷新

- 每次用户确认生成一个新的 `Idempotency-Key`；
- 同一次确认的网络重试必须复用同一个 Key；
- 导入按钮在请求中禁用；
- 导入成功后重新调用 Session Snapshot，并用返回值同时刷新 Session Catalog 行和 Timeline Store；
- 页面刷新后仍从持久化 Timeline 读取，不依赖前端临时状态。

## 4. Web 交互设计

### 4.1 历史导入卡

新增独立的 Provider History 卡片，避免继续扩大 `Workbench` 内联 JSX：

- 标题：`发现 Provider 历史`；
- 主信息：`发现 N 条可导入历史记录`；
- 次信息：历史会写入 CodeBridge Timeline，不修改 Provider 原始 Session；
- 主操作：`导入历史`；
- 错误操作：`重试检查`。

Timeline 为空时，卡片替代现有“输入目标开始当前 Session”空态。Timeline 已有内容但 Provider 又出现新增历史时，卡片作为 Timeline 上方的轻量提示展示。

Preview 返回 0 时：Timeline 为空则显示“Provider 暂无可导入历史”；Timeline 已有内容则不展示额外卡片。

不做自动写入、不做批量导入、不在打开页面时弹 Modal。

### 4.2 防溢出不变量

Web 主布局遵守以下规则：

1. 所有 Grid/Flex 可变内容列必须使用 `min-width: 0`；
2. Header 左侧标题区占剩余空间并允许收缩，运行状态和菜单固定保留；
3. Footer 的 880px 内容轨道不得被子项的 min-content 撑大；
4. Queue Row 使用 `auto minmax(0, 1fr) auto`，位置、消息、取消操作三列语义固定；
5. Queue 消息最多展示两行，支持中文、URL、代码和连续无空格字符在任意位置换行；完整内容保留在 `title`；
6. 用户消息气泡和错误文本支持任意长字符断行；
7. 禁止用页面级 `overflow-x: hidden` 掩盖问题，禁止通过隐藏取消按钮解决溢出。

## 5. 代码边界

### 5.1 新增

- `apps/web/src/components/provider-history-import-card.tsx`
  - 只负责状态展示和用户动作；
  - 不直接访问 API 或 Store。

### 5.2 修改

- `apps/web/src/lib/api.ts`
  - 增加 Preview 和 Import 客户端合同；
- `apps/web/src/lib/types.ts`
  - 增加 Provider History 返回类型；
- `apps/web/src/components/workbench.tsx`
  - 管理当前 Session 的 Preview/Import 状态；
  - 过滤切换 Session 后的陈旧响应；
  - 导入成功后刷新 Snapshot；
- `apps/web/src/components/session-chrome.tsx`
  - 固定 Header 收缩边界；
- `apps/web/src/components/session-queue.tsx`
  - 修正 Grid 最小宽度和长文本行为；
- `apps/web/src/components/conversation.tsx`
  - 修正用户消息的连续长字符断行；
- 相应单元、合同与浏览器测试。

### 5.3 不修改

- `ProviderHistoryImporter` 的领域逻辑；
- Provider 原始 Session 文件；
- Bridge GET 的纯读取语义；
- 飞书和 Telegram 渲染；
- Session、Flow 或 Runtime 状态机。

## 6. Surface Matrix

| Surface | Entry | Read path | Write path | Event consumption | Error handling | Recovery | Terminal feedback | Planned landing | Final state |
|---|---|---|---|---|---|---|---|---|---|
| Web | 选择 Provider Session | Preview + Session Snapshot | 用户确认后 Import | N/A：同步请求/响应后刷新 Snapshot | 互斥错误卡与准确恢复动作 | 重试 Preview；未知结果复用同 Key；拒绝陈旧响应 | Timeline + 已导入数量，刷新后保留 | H1–H3、E1 | implemented + reachable + closed-loop |
| Backend | Preview/Import API | Runner History Loader | ProviderHistoryImporter | N/A：同步写 canonical Timeline | 固定 status/code 矩阵 | 既有幂等与 cursor/prefix 防护 | 导入位置、事件数与持久 Snapshot | C1 | implemented + reachable + closed-loop |
| Agent/Provider | 本地 Provider Session | Runner Loader | 无 | N/A | Loader 错误返回 Bridge | Provider 原始数据不变 | 原始历史仍可读取 | C1 regression only | implemented + reachable；只读源 |
| 飞书 | 无历史导入入口 | 无 | 无 | N/A | N/A | N/A | N/A | Out of scope | 非本次目标 |
| Telegram | 无历史导入入口 | 无 | 无 | N/A | N/A | N/A | N/A | Out of scope | 非本次目标 |

## 7. 测试策略

### 7.1 合同层

- API 客户端使用正确路径、`confirm: true` 和 `Idempotency-Key`；
- Preview、Import 和错误响应类型完整；
- Import 成功后快照包含持久化 Timeline。

### 7.2 组件层

- `previewing/available/importing/empty/error` 各状态只显示合法操作；
- 重复点击不会产生第二次 Import；
- Session A 的晚返回不会污染 Session B；
- Header 状态和菜单在超长标题下仍可见；
- Queue 的取消按钮在超长消息下仍可见且可点击。

### 7.3 对抗性活跃表面

浏览器分别在 320、768、1280、1536 宽度验证：

- 10,000 字中文；
- 10,000 字英文；
- 10,000 个连续无空格字符；
- URL、JSON、Markdown 和反引号代码；
- 100 条 Queue Turn；
- Preview 返回 0、401 和大数量；
- Provider 失败、Prefix Drift、重复确认、网络重试；
- Preview 或 Import 期间快速切换 Session；
- 导入成功后刷新页面，Timeline 仍存在；
- `documentElement.scrollWidth === documentElement.clientWidth`；
- Header 菜单、Queue 取消按钮和 Composer 始终在可视区域内。

## 8. 验收标准

1. 截图中的 Provider Session 能预览出 401 条历史并由用户确认导入；
2. 导入后 Timeline 可见，刷新页面仍保留；
3. 未确认前不写数据库；
4. 任意测试文本和 Queue 数量均不产生页面级横向滚动；
5. 不通过裁剪操作按钮或吞掉错误实现“看起来不溢出”；
6. 合同测试、组件测试和真实浏览器测试全部通过；
7. 完成前重新产出 Surface Matrix，并用 GitNexus 检查实际变更范围。

## 9. 非目标

- 自动导入所有 243 个未绑定 Provider Session；
- 在飞书或 Telegram 中管理 Provider 历史；
- 重写 Provider History 导入算法；
- 建设全局批量迁移页面；
- 改变 Provider Session 原始文件。

## 10. Implementation verification（2026-08-25）

- 真实 Session `sess_6c9d9dbc38314d32a3b957c9cebcb84a` 在重启后的活跃 Bridge 上只读 Preview：`importedPosition=0`、`providerPosition=401`、`importableEvents=401`；自动化未点击 Import。
- 活跃 Web 已选中该 Session，并展示“发现 401 条可导入历史记录”和唯一确认按钮。
- 320px 活跃页面实测 `documentElement.scrollWidth === documentElement.clientWidth === 320`，Import 按钮仍可见。
- 对抗性浏览器矩阵在 320/768/1280/1536 四个宽度执行三轮，30/30 通过；Flow 主路径回归 1/1 通过。
- 聚焦合同/组件测试 157/157 通过；Web 与 Bridge production build 通过。
- 自动化只覆盖“发现、预览、确认入口和合同”；真实 Provider Session 的 Import 仍由用户点击确认，写边界未被绕过。
