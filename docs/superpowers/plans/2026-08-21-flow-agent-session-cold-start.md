# Agent Session → Flow 冷启动实施计划

**Goal:** 从不同 Agent 的真实成功 Session 生成可追溯 Guide Draft，并由 Web/通道明确确认保存；不把任意 Agent 工具调用伪装成 Candidate Runbook。

**Product source:** `docs/superpowers/specs/2026-08-21-flow-agent-session-cold-start-design.md`

## Task 1：Bridge 提案读取与 Guide 保存

- [ ] 在 `flow-api.test.ts` 写失败测试：structured plan、tool trace、unavailable、跨 Session、非成功 Run、敏感参数脱敏、幂等保存。
- [ ] 在 `flow-api.ts` 增加 proposal 纯函数和两个 API；只读取 SqliteEventStore 既有事件。
- [ ] Guide 保存固定合法状态并计算 definitionRevision；provenance 由服务端生成。
- [ ] 回归 Candidate/Review API。

## Task 2：Web 可达入口

- [ ] 扩展 Web types/api 并写合同测试。
- [ ] Workbench 加载当前 Session proposals。
- [ ] SessionTimeline 在成功普通 Agent Turn 展示“整理为 Guide”，保存中防重复。
- [ ] 保存成功刷新 manage/consume 列表并打开 Guide 详情；consume 列表保持不变。

## Task 3：真实数据验证

- [ ] 只读扫描 Cursor/Claude/Codex/Pi Session 与成功 Run 覆盖。
- [ ] 对每个 Agent 至少选一个真实 Session 调 proposal API。
- [ ] 只保存一个无敏感参数的测试 Guide，并验证 provenance/幂等/不可消费。
- [ ] Computer Use 验证 Web 活跃入口；真实飞书写操作留 P3。

## Task 4：门禁与提交

- [ ] focused tests、`pnpm test`、`pnpm lint`、`pnpm build`、`git diff --check`。
- [ ] GitNexus detect-changes；不得影响 Runtime Run/Lease 状态机。
- [ ] 独立提交并重启。
