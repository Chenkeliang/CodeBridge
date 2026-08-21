# Flow P2 / P3 实施计划

> 每项先写失败测试；修改已索引符号前执行 GitNexus upstream impact；提交前执行 detect-changes。

## Task 1：Recommendation 领域合同

- 扩展 Runner `fcb` 上下文和命令，允许 Agent 提交结构化 Flow 建议。
- Bridge 校验 consumable identity/revision/input，持久化 recommendation。
- 增加 Session recommendation 查询、dismiss/accept 合同；accept 不直接执行。
- 测试非法 Flow、stale revision、secret 输入、重复建议幂等。

## Task 2：向 Agent 提供最小 Flow 摘要

- 普通 Agent prompt 仅附加 consumable Flow 的名称、ID、revision、输入摘要和 `fcb flow suggest` 规则。
- 明确高置信、工具调用前、建议后停止；不添加关键词 matcher。
- 无 consumable Flow 时不注入。
- 覆盖 Web/飞书/Telegram prompt 合同，禁止把 Guide/Candidate 注入。

## Task 3：Web recommendation 与深链

- Timeline 查询并显示 recommendation 卡。
- 接受：进入现有 one-shot 选择/补参/确认；忽略：写 dismissed。
- 支持 `?flow=&session=` 深链并重新校验。
- Candidate pending 显示审查提醒和深链。

## Task 4：Web Guide 创作器

- Bridge 支持创建/更新合法 Guide Draft 与导入 Guide JSON。
- Web 提供名称、描述、有序 manual steps 表单。
- 保存后刷新 manage Catalog；Guide 不进入 consume。
- “升级 Candidate”只调用 Bridge，校验失败显示 issues。

## Task 5：共享通道管理合同

- Core/Ingress 增加 manage list、proposal/save Guide、review context、Candidate 摘要更新、reject、Web deep-link DTO。
- 扩展 `ChannelFlowController` 的 manage/guide save/diff/edit/review/reject/open 命令。
- 共享 controller 不含通道 I/O 和发布批准。

## Task 6：飞书与 Telegram 适配

- 飞书路由新命令并用现有 Markdown 回复。
- Telegram 复用同控制器；只做合同测试，配置保持 disabled。
- 真实飞书写操作在最终验收前按动作时确认。

## Task 7：对抗与完成门禁

- 非法状态、跨 Session Run、stale revision、重复点击、secret 泄露、通道 publish/approve 禁止。
- 全量 test/lint/build；GitNexus detect-changes。
- 重启后 API + Web Computer Use + 飞书只读验收。
- 最终提醒：Telegram 尚未正式启用，需要单独配置 token/allowed chats 并做真实闭环测试。
