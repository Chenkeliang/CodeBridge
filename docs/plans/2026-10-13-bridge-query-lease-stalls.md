# Bridge 慢查询与停顿后续租修复

## 目标与范围

定位线上实际阻塞 SQL，消除 Agent 事件投影时跨 Run 扫描历史块；允许仍由本进程执行且未取消的任务在主线程停顿后恢复自己的租约。保持其他 owner 接管、provider 会话被占用、取消与终态的拒绝语义。用户已授权验证后合并 main、推送、上线。

## 线上证据

运行版本 8e3a0a0。17:11 的原生采样中主线程 252 次均在 StatementSync::All，246 次等待 pread。随后短时 V8 CPU 采样定位 completeOpenThoughtBlocks → projectAgentEvent → appendLeasedRunEvent；同一采样也命中 sealOpenSegmentsForRun。诊断仅对本机进程短时开启 inspector，完成后关闭；无服务重启、无业务消息。

线上 session_timeline_blocks 约 7.6 万条，run_id 无索引。completeOpenThoughtBlocks 按 run_id/kind/status 查询，EXPLAIN 为 SCAN session_timeline_blocks。session_timeline_turns.run_id 唯一索引、blocks(turn_id,block_index) 唯一索引已存在；全部历史块的 run_id→turn_id 映射一致（错配 0）。同一线上库只读对照（三次中位数）：completeOpenThoughtBlocks 2097.021ms → 0.285ms；resolveThoughtBlockId 49.968ms → 0.098ms；closeRun 的块查询 82.157ms → 0.036ms，查询结果一致。四条查询计划均从 SCAN 改为基于 turn_id 的索引 SEARCH；UPDATE 只检查计划，没有对线上执行。这不是此前 76 秒停顿的精确耗时重放。

## 方案

1. completeOpenThoughtBlocks、resolveThoughtBlockId、closeRun、sealOpenSegmentsForRun 按原 Run 唯一对应的 turn_id 查询，复用现有索引。无表结构、索引、数据迁移，不修改输出语义。
2. RunExecutor 将心跳和 Agent 事件的 Run 续租统一：正常续租失败时，仅自己仍在执行的任务可尝试 reclaimOwn；数据库继续按 owner、running 状态比较更新，provider 租约验证保持原行为。终态持久化仍由原路径负责。
3. 回归覆盖执行计划不全表扫描、跨 Run 隔离、思考块与片段收尾；心跳/Agent 事件/恢复扫描先到三种顺序，及 owner 接管、provider 接管和取消。
4. 运行定向与全量测试、build/lint；核对发布差异后合并推送，通过发布器上线并核验线上版本、飞书和运行任务。

## Surface Matrix

| Surface | entry/read/write | event/error/recovery/terminal | implemented/reachable | closed-loop | 验证落点 |
| --- | --- | --- | --- | --- | --- |
| Agent | Runner→RunExecutor→SQLite 投影 | 心跳、provider 租约、取消、终态保护 | 现有线上路径，候选修复已实现 | 本地真实执行器与内存库回归通过；线上待发布验收 | RunExecutor、projector 合同测试 |
| 飞书 | 入站话题→Session Runtime→事件流→session-watcher | 既有卡片状态、错误、恢复与终态 | 现有线上路径，候选修复已实现共享逻辑 | 不用其他表面结果替代真实飞书验收 | 飞书表面回归；发布后健康检查及自然流量观察 |
| Web | Session API→同一投影与执行器 | 原有事件流、终态与取消 | 既有入口，UI 无改动 | 未做真实浏览器交互 | Session API、timeline 回归 |
| Telegram | ingress→同一投影与执行器 | 原有 watcher、终态与取消 | 既有入口，通道无改动 | 未做真实 Telegram 消息交互 | 既有 Telegram 测试 |

## 影响检查

GitNexus 已在 8e3a0a0 重建索引。completeOpenThoughtBlocks、resolveThoughtBlockId 为 LOW；closeRun、sealOpenSegmentsForRun、RunExecutor.execute/executeStepOnce 为 HIGH，已告知用户。改动限于上述热路径及回归测试，不扩大到整体数据库异步化。

## 验证与交付

`pnpm build` 通过；`pnpm lint` 通过（7 条既有 Web warning）；`pnpm test` 147 文件 / 1385 测试通过。定向 projector、executor、recovery 52 测试通过。新增 SQL 计划与事件过期续租回归在旧代码下失败，修复后通过；心跳先到、恢复先到、事件先到，以及其他 owner 接管、停顿期间 provider 被接管、既有取消测试均通过。

只读性能验证针对线上数据库，业务回归仅使用内存或临时数据库与模拟 Runner，不调用模型、不发送外部消息。inspector 已关闭。分支 fix_bridge_sqlite_lease_stalls 基于 fetch 后的 origin/main（8e3a0a0），创建时独有提交数为 0；用户已授权合并推送与部署，部署结果以发布器状态和线上健康检查为准。
