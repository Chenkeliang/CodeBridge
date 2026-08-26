# Flow 待生成中心 — V1 验证证据

> 验证日期：2026-08-26（Asia/Shanghai）  
> 分支：`feat_flow_save_intent`  
> 功能基线：`b2dedf1fe684ba5a1815d9648071832a76f305aa`  
> 验证 HEAD：`79fd9deaef39db8aafefa472f4f4a394f5d27fdb`  
> Runtime：Node `v24.18.0`，pnpm `10.34.1`

## 1. 结论

Flow Save Intent 的全局“待生成”入口已完成非 Telegram V1 验证：

- pending 请求仍只存在于 canonical `FLOW_SAVE_*` 事件，不进入 Flow Catalog；
- Web 在用户停留于其他 Agent / Session 时，能从 `Flows → 待生成` 发现来源请求，且不会自动抢占当前工作；
- 待生成详情显示来源标题、Agent、Session 和用户请求，并复用既有 confirm/dismiss 命令；
- 飞书原 Run 卡准确指向 `Web → Flows → 待生成`，不增加第二张卡或通道侧写状态机；
- Web disabled 时不注入保存工具，不创建悬空请求；
- Telegram 文案与行为已实现并通过自动化测试，但生产仍禁用，因此不标记 reachable 或 closed-loop。

真实跨表面验证选择了“忽略”，避免创建不需要的真实 Candidate。Candidate 的唯一创建、详情打开和刷新收敛由活跃 Web E2E 独立验证。

## 2. 提交范围

| 提交 | 交付 |
|---|---|
| `0ebdd16` | 全局待生成中心设计 |
| `b24e071` | 可执行实施计划 |
| `2ff1204` | Event Store pending 查询、索引、分页和身份校验 |
| `59c7b93` | Bridge 全局只读 inbox API |
| `20b89f4` | Web pending 查询、轮询和竞态状态 |
| `657ce9c` | Flows 徽标、列表和待生成详情 |
| `b79742a` | confirm/dismiss、来源定位和视觉收敛 |
| `d1d0c7b` | Web-disabled 保存工具门禁 |
| `67054bd` | 飞书精确目的地文案 |
| `4a033ac` | Telegram 精确目的地文案 |
| `79fd9de` | 跨 Session Candidate 详情归属与 503 同 key 重试修复 |

相对功能基线共 37 个功能文件、4,208 行新增、74 行删除；用户已有 `AGENTS.md` 修改和 `.claude/`、`CLAUDE.md` 未跟踪文件不属于本功能，未修改、未暂存。

## 3. 自动化验证

### 3.1 合同与表面测试

| 门禁 | 首次结果 | 最终结果 | 说明 |
|---|---:|---:|---|
| WFI-V1 19 文件合同套件 | 372/372 | 372/372 | 首次通过，无失败重跑 |
| 飞书 WFI-7 聚焦套件 | 40/40 | 40/40 | live、有限重放、重启、foreign Run、终态后零写 |
| Telegram WFI-8 聚焦套件 | 28/28 | 28/28 | live/recovery、长正文 sticky notice、edit fallback、终态后零写 |
| 活跃 Web 三个 Playwright spec | 45/48 | 48/48 | 首次失败如实记录，修复后完整重跑通过 |

Playwright 首次失败的三项是：

1. confirm 后 Candidate 详情可跨 Session A 污染 Session B；
2. confirm 后 review-context 500 可在已切换的 Session B 显示；
3. 旧测试错误地期待 `503 flow_catalog_unavailable` 重试生成新 Idempotency-Key。

根因是全局 inbox 接入后，Timeline 路径原有的 `expectedSessionId` 归属门禁被遗漏，同时测试期待与既定“未知/可重试结果复用同 key”合同冲突。提交 `79fd9de` 恢复 Session 归属门禁并修正合同测试；随后目标 3/3 和完整 48/48 均通过。

活跃 Web 套件覆盖：

- 320、768、1280、1536 四个宽度；
- 100 条 pending；
- 长 UUID、路径、标题、摘要、Imported 和未知 Agent；
- document、列表、详情 `scrollWidth <= clientWidth`；
- 延迟轮询与即时刷新竞态；
- 两个 Agent / Session 间不抢占、不串详情；
- confirm 只创建一个 Candidate，dismiss/confirm 后列表收敛。

### 3.2 构建

- 受影响的 7 个包全部构建通过：Core、Work Items、Runner Host、Bridge、Web、Feishu、Telegram。
- 完整 `pnpm build` 通过 20 个 workspace 包。
- `git diff --check` 通过。
- Web 只包含已有非阻断 warning：Node built-in browser externalization、运行期字体解析和大于 500 kB chunk；无类型或打包错误。

## 4. GitNexus 门禁

最终整段比较：

- 基线：`b2dedf1`；
- 38 个文件、179 个符号、24 条 execution flows；
- 风险：`CRITICAL`；
- 其中 1 个文件是用户已有 `AGENTS.md` 修改，功能自身为 37 个文件。

影响集中在 Event Store 查询、Bridge API、Web Workbench/命令收敛、Session 投影和飞书/Telegram 渲染。每个 HIGH/CRITICAL 编辑边界均在实施前告警，并由合同测试与对应活跃表面测试覆盖。没有新增通道侧 confirm/dismiss/Catalog 写、第二套状态机或第二条全局 SSE。

## 5. 活动部署证据

HEAD `79fd9de` 于 `2026-08-26 17:24:55 +08:00` 提交后执行完整构建，并通过受支持的 `scripts/start.sh install-launchd all` / `scripts/start.sh restart` 路径重启。launchd 参数指向本验证工作树。

| 组件 | PID / 启动时间 |
|---|---|
| Bridge | `19989`，`2026-08-26 17:32:39 +08:00` |
| Runner | `19998`，`2026-08-26 17:32:39 +08:00` |

| 产物 | mtime | SHA-256 |
|---|---|---|
| `apps/bridge/dist/flow-api.js` | `2026-08-26 16:21:32 +08:00` | `32b4b3a25172770b85d649cfe6d171c3c4fac51d51df998f6d5d0df41d4c9638` |
| `apps/bridge/dist/flow-save-inbox.js` | `2026-08-26 16:21:32 +08:00` | `0ccd6a2ccc2b40625f363e281f8a137b1f7b5a9a5dad48cf66edb6d07ec8020a` |
| `apps/web/dist/index.html` | `2026-08-26 17:25:38 +08:00` | `7992aadff57e0e3da1015a723ad6d6c6215811b081e978b8411f86d80f7bade9` |
| `packages/channel-feishu/dist/session-watcher.js` | `2026-08-26 17:06:30 +08:00` | `cffc8ce0f339e31e1408a025dac963af1c6dce59ae0061886caf7fa6360aac0a` |
| `packages/channel-telegram/dist/telegram-session-watcher.js` | `2026-08-26 17:13:07 +08:00` | `8ab9f4f03d7c8e039b1d6210e2c7af6d179c962a20d98f8bd92cf6df75b14504` |
| `packages/runner-host/dist/server.js` | `2026-08-26 11:23:41 +08:00` | `040465ed1b0159378da63a32b5a84cccd0aa3d6d6716ac8dae258a0aeebe6f60` |

活动探测：

- `GET /workbench/` → `200`；
- 未认证 inbox 请求 → `401`；
- 有效认证 `GET /v1/flow-save-requests?state=pending&limit=50` → `200`；
- 真实请求忽略并重启后 `requests.length = 0`、`next_cursor = null`；
- 活动飞书与 Telegram 产物均包含精确文案 `Web → Flows → 待生成`。

## 6. 真实跨表面链路

### 6.1 入口与发现

- 来源表面：真实飞书小 V 会话，Agent `Pi`；
- Web 验证时停留在另一条 Codex Session：`评估 FLOW 三通道闭环`；
- 用户消息：`请把刚才这套仓配异常处理流程存为 Flow。`；
- 请求：`fsr_a2b78c95daba42b28a0765a61d197baa`；
- 来源 Session：`sess_32d50957660d465f9af535b07e605f5f`；
- 来源标题：`仓配中心-发货单下发异常`；
- Agent：`Pi`。

飞书运行中和终态均在原 Run 卡显示：

> 已记录“存为 Flow”请求。请前往 Web → Flows → 待生成确认；尚未创建 Candidate。

没有独立 Save Intent 消息。Web 未自动切换到来源 Session；Flows 徽标变为 `1`，`待生成` 列表可发现该请求。打开详情后显示名称、Agent、来源 Session、来源标题和用户请求。

### 6.2 写边界与恢复

为避免创建无用真实 Candidate，本次活动链选择“忽略”：

- Flow Catalog `flows` 行数：忽略前 `11`，忽略后及 Bridge 重启后仍为 `11`；
- 全局 pending：忽略后及重启后均为 `0`；
- Session hydrate 中稳定保留 block `flow_save:fsr_a2b78c95daba42b28a0765a61d197baa`，状态为 `dismissed`；
- 重启后 Web 不再显示该 pending，证明读模型与 canonical 终态收敛。

“确认只创建一个 Candidate、pending 消失并打开 Candidate 详情”的写路径由 48/48 活跃 Playwright fixture 验证；真实环境没有为验收制造 Candidate 数据。

## 7. Surface Matrix

| Surface | entry | read path | write path | event consumption | error handling | recovery | terminal feedback | 四态结论 / planned |
|---|---|---|---|---|---|---|---|---|
| Bridge | `GET /v1/flow-save-requests` | Event Store 单 SQL + Session 每页批量读取 | 只读；confirm/dismiss 仍走既有领域服务 | canonical `FLOW_SAVE_*` | 400/401/游标与身份 fail-closed、结构化告警 | 持久事件 + 重启后重建 read model | 请求从 pending 消失，命令返回 canonical 状态 | implemented、reachable、closed-loop；WFI-1/2/V1 |
| Web | `Flows → 待生成` | inbox API + Catalog + Session hydrate/SSE | 既有 confirm/dismiss API | 当前 Session SSE + 全局单请求轮询 | 保留最后快照、同 key 重试、generation/Session 竞态门禁 | 立即刷新、可见性恢复、15s 轮询、重启 | dismiss 移除；confirm 打开唯一 Candidate | implemented、reachable、closed-loop；WFI-3/4/5/V1 |
| Agent | Pi / ACP 自然语言保存工具 | dispatch-time source availability | 只创建 Save Intent，不写 Catalog | `AGENT_EVENT` → canonical request | 严格工具身份、固定错误码、无来源 fail-closed | tool replay 幂等 | 只声明请求已记录、尚无 Candidate | implemented、reachable；跨表面闭环目的地已验证；WFI-6 |
| 飞书 | 原 Run 卡 | matching Run canonical event | 无 confirm/dismiss/Catalog 写 | live、有限 replay、restart recovery | 沿用原卡错误与 Delivery 对账 | 同卡恢复，不开第二 Delivery | 精确指向 `Web → Flows → 待生成`，原 Delivery 正常完成 | implemented、reachable；通过 Web handoff closed-loop；WFI-7/V1 |
| Telegram | 原 pending/terminal message | canonical channel event | 无 confirm/dismiss/Catalog 写 | live/recovery 自动化测试 | 原消息 edit/fallback | Delivery recovery | 与飞书同文案，sticky notice 不形成第二状态面 | implemented、tested、planned；生产禁用，不 reachable/closed-loop；启用后真 Bot 验收 |

## 8. 完成定义审计

| # | 门禁 | 证据 | 结果 |
|---:|---|---|---|
| 1 | 另一 Session 被选中时仍可发现 pending | 真实飞书 Pi A → Web Codex B，徽标和列表出现 | pass |
| 2 | 打开详情不切换 Session | 真实 Web 与跨 Agent E2E | pass |
| 3 | confirm 前 Catalog 零写 | 领域/API 测试；真实 dismiss 前后 Catalog 均 11 | pass |
| 4 | confirm 只创建一个 Candidate | 幂等领域测试 + 活跃 Playwright | pass |
| 5 | dismiss/confirm 与刷新/重启收敛 | 真实 dismiss + Bridge 重启；confirm E2E | pass |
| 6 | Session 删除后隐藏、结构化告警、零写 | Event Store/API 合同测试 | pass |
| 7 | Agent 名使用现有 Profile，未知回退原始 ID | Web/API 测试与 100 pending E2E | pass |
| 8 | 陈旧轮询不覆盖即时刷新 | state 单测 + 延迟响应 E2E | pass |
| 9 | 飞书精确目的地可达 | 真实原 Run 卡 → 活动 Web Flows 待生成 | pass |
| 10 | Web disabled 时零工具、零请求、零死链声明 | RunnerHost/Bridge WFI-6 回归 | pass |
| 11 | 320–1536、100 pending 无横向溢出 | 活跃 Playwright，document/list/detail scrollWidth 断言 | pass |
| 12 | Telegram 状态诚实 | 配置仍禁用；仅实现与自动化测试，真 Bot 后置 | pass |
| 13 | 活动进程匹配已验证提交与产物 | 完整构建、launchd 工作树路径、PID/start time、hash、live endpoint | pass |

## 9. 剩余边界

- Telegram 启用后的真实 Bot 验收仍为 planned；在完成前不得提升为 reachable/closed-loop。
- 本 V1 没有在真实 Catalog 创建 Candidate；该写路径由活跃 E2E 验证，真实链使用 dismiss 保持数据干净。
- 本地 launchd 当前指向验证工作树。合入/切换部署分支后必须重新完整构建并通过受支持路径重启，不能把本次 PID/产物证据外推到未来提交。
