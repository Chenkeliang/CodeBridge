# 飞书群内回复与引用续聊

用户已确认：群内直接回复并 @ 本轮发送者；沿引用关系共享会话；先实现验证，不推送、合并或上线。

## 实施与依赖

P1：复用现有 SDK Channel、会话入口、SQLite Turn/Delivery。独立群消息以消息 ID 隔离后台会话，引用命中历史 Turn/Delivery 则续接，查询同时校验群。
P2：每轮 replyContext 随已有 Turn.message_json 原子保存；卡片创建、排队、重启恢复始终使用该轮提问者及话题标记。普通群不创建话题。
P3：已配置群的所有成员可提问；私聊访问限制和操作命令权限独立保留，告警审批继续走已有门禁。
P4：隔离 API/SQLite/飞书适配器集成测试、现有告警/Web/Telegram 回归、全量测试、build、lint；不调用真实飞书或模型，不修改运行配置。

复用 @larksuiteoapi/node-sdk 1.68.0、SQLite、现有 Agent 与队列，无新增运行依赖。非 @ 回复触发及群引用读取依赖飞书群消息读取权限；尚未检查线上授权。

## Surface Matrix（实施前）

| Surface | entry | read path | write path | event consumption | error handling | recovery | terminal feedback | planned |
|---|---|---|---|---|---|---|---|---|
| 飞书 | planned：P1 群消息 | planned：P1 引用查询 | planned：P2 回复与 @ | planned：P4 入站/投递 | planned：P4 失败反馈 | planned：P2 重建适配器 | planned：P4 卡片终态 | P1-P4 |
| Agent | implemented：既有入口 | planned：P1 同会话续聊 | planned：P2 身份元数据 | implemented：既有执行流 | planned：P4 回归 | planned：P4 排队 | planned：P4 结果投影 | P1/P2/P4 |
| Web | implemented：既有入口 | planned：P4 会话 API 回归 | planned：P4 可选字段兼容 | planned：P4 事件回归 | planned：P4 错误回归 | planned：P4 恢复回归 | planned：P4 终态回归 | P4，不新增 UI |
| Telegram | implemented：既有入口 | planned：P4 原路由回归 | planned：P4 无新字段兼容 | planned：P4 投递回归 | planned：P4 错误回归 | planned：P4 恢复回归 | planned：P4 回复回归 | P4，不改通道策略 |

源码路径为本地实现证据；未部署前不声明线上 reachable/closed-loop。GitNexus 当前索引基于 fae0cdc，runner 身份 current、incompleteReasons 为空；共享存储及卡片路径影响为 HIGH/CRITICAL，按可选字段兼容并回归。

## 完成与验证

- 新的普通群请求使用独立后台 conversation；不创建可见话题。引用原提问或回复时通过既有 Delivery 查询续接同一会话；已有原生话题保持原位置。
- replyContext 仅作为已有 session_turns.message_json 的可选字段保存，与 Turn/Delivery 同事务落库；没有新增表或另建会话存储。恢复和排队沿用现有 watcher。
- 主卡片创建、刷新、终态重放保留同一 recipient 元素，原生 @ 当前轮次的提问者；不由模型猜人或另发提醒。
- Agent 主动发消息和文件的来源由当前 Run 的持久 Delivery 传递，经现有出站 API 和 CLI 适配直达飞书；请求体不能用后续消息覆盖来源，Telegram 仍走原有参数路径。
- 已配置群可以让成员参与，私聊白名单保持原判定；普通群操作命令检查管理员/原允许用户，既有告警审批继续由告警入口处理。业务工具执行仍沿用既有权限机制；本次不新增通用业务授权系统。
- 消息精确查询使用既有 Delivery 上的两个新增复合索引；真实查询计划验证按 source/surface message ID 精确查找，避免仅按 channel 扫描全部消息。
- 无新增 npm 依赖、无锁文件变更。ChainTopicTracker 已退出生产路由，其独立旧文件保留，本次不做额外清理。

本地验证命令（工作目录 /Users/demo/projects/CodeBridge）：

```sh
pnpm build
pnpm exec vitest run apps/bridge/src/feishu-group-reply.test.ts apps/bridge/src/outbound-api.test.ts packages/channel-feishu/src apps/bridge/src/feishu-alert-surface.test.ts apps/bridge/src/channel-ingress.test.ts packages/session-coordinator/src/delivery.test.ts
pnpm test
pnpm lint
git diff --check
```

结果：构建通过；定向 30 文件 / 276 测试通过；全量 149 文件 / 1403 测试通过；lint 0 errors、7 条既有 Web warnings；diff 检查通过。

12 个新增适配器集成场景覆盖：独立请求隔离、自动 @、跨成员引用、Bridge 重建、普通聊天过滤、群成员/私聊/操作命令边界、队列启动、终态恢复、跨群隔离、伪造接收者拒绝、当前 Run 主动出站、其他机器人回复查询、SQLite 重开、精确索引、已存在话题及新原生话题对旧引用的续接。部分场景在同一测试内联合验证。

已把原版 Bridge 临时替换进同一测试夹具运行两项核心回归：独立问题混用同一 Session、无 @ 引用无法续接，两项均失败；恢复本次实现后通过。恢复操作放在 finally，原源码与当前候选均有临时备份，未触碰服务。

测试使用真实会话 API、临时 SQLite、Coordinator 和卡片投递代码；飞书传输模拟，Agent 执行不启动真实模型。所有验证不向真实群发送消息。

## Surface Matrix（完成时）

| Surface | entry | read path | write path | event consumption | error handling | recovery | terminal feedback | planned 落点 |
|---|---|---|---|---|---|---|---|---|
| 飞书 | implemented：实际入站适配器 | implemented：引用精确查 Delivery | implemented：回复及 recipient | implemented：真实入队/去重路径 | implemented：权限拒绝与旧错误回归 | implemented：Bridge 重建/队列/SQLite 重开 | implemented：恢复终态并确认 Delivery completed | P1-P4 完成；群内真实验收待上线 |
| Agent | implemented：现有 submit | implemented：同会话与身份上下文 | implemented：当前 Run 原始提问出站 | implemented：队列及卡片事件路径 | implemented：既有测试回归 | implemented：队列与结果恢复 | implemented：终态重放及固定提问者 | P1/P2/P4 完成；真实模型不在本轮验证范围 |
| Web | implemented：入口未改 | implemented：会话 API 回归 | implemented：可选字段兼容 | implemented：全量事件/UI 测试回归 | implemented：既有错误测试 | implemented：既有恢复测试 | implemented：既有终态渲染测试 | P4 完成；未做浏览器真实交互验收 |
| Telegram | implemented：入口未改 | implemented：原会话策略回归 | implemented：原参数路径回归 | implemented：原事件测试回归 | implemented：既有失败测试 | implemented：既有恢复测试 | implemented：既有回复测试 | P4 完成；未向真实 Telegram 发送 |

本轮只确认本地 implemented 与隔离环境的交互闭环，不声明生产 reachable 或真实平台 closed-loop。

## 后续上线验收边界

尚未推送、合并、部署或重启服务；未改本机运行配置或飞书权限。未来上线需核对目标群和应用权限，尤其非 @ 续聊与引用读取所需权限，随后在测试群确认实际展示位置、原生 @ 通知、多人引用及重启后续聊。上线与真实消息发送另行授权。
