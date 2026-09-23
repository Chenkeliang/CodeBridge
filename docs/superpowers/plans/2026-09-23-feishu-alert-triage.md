# 飞书告警自动排查（实施及验证记录）

## 用户目标和边界

小 V 在指定飞书群增量读取其他机器人 webhook 告警，自动只读排查；在原消息话题中反馈。每次需要业务写操作时，必须原生 @ 配置的负责人，列出具体动作并等待本人在该话题回复；历史批准、告警文本和其他人的回复都不构成新的授权。不改告警发送方的卡片，不自动执行生产变更。

已于 2026-09-23 使用小 V 的应用身份调用 bot/info、chats、messages：群列表与最近五条告警读取成功（包括重复告警）。返回消息类型为 post，不能把所有视觉卡片都假定为 interactive。飞书 CLI 不是依赖。

## Surface Matrix（实施前）

以下状态仅针对新增告警值守能力，不代表各表面原有聊天能力。

| Surface | entry | read path | write path | event consumption | error handling | recovery | terminal feedback | implemented / reachable / closed-loop / planned |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 飞书 | 配置目标群，Bridge 启动后轮询 | 飞书 history API 已实测 | 原告警 reply_in_thread；owner-only 入站回复 | 轮询主动发现；正常消息事件接本人回复 | API 失败保留游标重试 | 持久游标、去重、原消息映射 | 原线程流式卡片与原生 @ | 部分 / 只读 API 已验证，自动入口未上线 / 否 / AT-1、AT-2、AT-3 |
| Agent | 自动排查任务经原 Session ingress | 告警材料和现有只读技能 | 每次操作前 @ 负责人并等待本次回复 | 原 Run/Session 事件 | 复用原错误与权限反馈 | 原 Session/Delivery 恢复 | 原 Run 终态 | 原执行基础存在，自动入口缺失 / 否 / 否 / AT-2、AT-3 |
| Web | 原会话列表查看相同 Session，无新操作入口 | 原 Session 投影 | 原聊天能力；本功能不引入跳转或 Web 审批替代 | 原 SSE | 原错误展示 | 原持久 Session | 原终态显示；本轮不声称真实 Web 验收 | 新增能力无 / 未验证 / 未验证 / AT-3 范围记录 |
| Telegram | 不接入飞书监控 | 无新增 | 无新增 | 无新增 | 无新增 | 无新增 | 无新增 | 否 / 否 / 否 / 不在本期范围，AT-3 验证配置缺省无变化 |

## 实施步骤

- AT-1：Bridge 后端监控服务管理持久游标、来源白名单、消息幂等、短期相同内容合并、并发上限；通道只提供读消息和提交排查的适配器。首次启用从当前时刻开始，避免批量处理旧告警；启动/停止/配置更新纳入活跃 CLI。
- AT-2：在原告警根消息建独立 Session，明确 reply_in_thread；登记负责人原生 @ 引用。后端判定本告警话题的负责人，其他人不能通过该话题继续任务或批准；本人的每次自然语言回复重申授权仅限本次具体动作。
- AT-3：合同测试验证分页、失败重试、重启恢复、去重及本人身份约束；活跃通道测试验证轮询→Session ingress→卡片线程与负责人引用→本人回复。运行相关既有测试、构建、类型检查。真实发群和生产部署待具体发布授权，不能以模拟 SDK 测试声称线上闭环。

## 验证验收标准

同一消息跨轮询和重启不重复创建任务；重复内容在去重窗口内不重复排查；读失败不丢消息；告警中包含指令不获得执行授权；只读排查遇到写操作必须 @ 本人，本人回复回到同一 Session；非负责人回复不启动 Agent；默认未配置时不启动监控。新增领域状态位于 Bridge 后端，通道不另造审批状态机。

## 限制

Agent 的只读及逐次确认要求通过任务指令和负责人入站校验实现，不能声称任意后端、任意 shell/MCP 工具都具有新的硬只读沙箱。既有 Agent Permission 机制继续有效，不能把本人的自然语言回复等同为一次 blanket permission。

## 完成记录与验证（候选分支，尚未上线）

AT-1/AT-2/AT-3 的实现及本地验证完成。配置名为 `feishu.alertMonitor`，说明见 `docs/zh-CN/feishu-alert-triage.md`。当前主工作区保留在原分支；候选位于 `codex/feishu-alert-triage`，从已 fetch 的 `origin/main`（38f7e27）起步，初始 ahead 为 0。

真实只读验证：使用候选 `FeishuBridge.readAlertMessages` 和实际安装的 Node SDK 1.68.0，读取「灯塔推送」过去一天的 12 条消息成功；群成员接口核实负责人为陈科良。未调用发送、处理业务写或发布接口。

验证命令：

- `pnpm build`：通过（保留已有 Web 构建告警）。
- `pnpm lint`：通过，0 errors / 8 warnings，警告位于未改动的 Web 文件。
- `pnpm test --no-file-parallelism apps/bridge/src/feishu-alert-monitor.test.ts apps/bridge/src/feishu-alert-surface.test.ts packages/channel-feishu packages/core/src/alert-monitor-config.test.ts packages/core/src/types.test.ts apps/bridge/src/channel-ingress.test.ts`：26 文件、239 测试通过。
- 末次将本人回复的引用上下文归一到原告警 ID 后，重新构建 channel-feishu / bridge，并复核表面、引用和流式回复测试。
- 初次并行运行出现既有测试共用 `os.tmpdir()/feishu-mention-targets.json.tmp` 的 rename 冲突；本功能新测试全部使用独立临时目录。串行运行消除共享夹具竞争，未修改无关测试。

新增回归曾实际失败并修正：跨批同时间戳消息漏读、重叠秒内延迟消息漏读、native thread_id 与 root_id 不同导致另开 Session/绕过负责人校验。重复告警卡片的回复也归一到同一 incident，运行中移除配置不再提交新排查。

### Surface Matrix（完成时）

| Surface | entry | read path | write path | event consumption | error handling | recovery | terminal feedback | implemented / reachable / closed-loop / planned |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 飞书 | 候选活跃 CLI 在 connect 后启动轮询 | SDK history 在真实群已验证；post/interactive 共用正文提取 | 实际适配器入口＋模拟 SDK 验证原线程 card reply、原生 @ open_id；只接受本人继续 | 轮询收告警，正常群事件接本人回复；监控群 app 事件不重复送 Agent | 读取有 15s timeout；保留 checkpoint，提交幂等重试 | 原子状态保存分页/去重/owner/回复别名，复用 Delivery 恢复 | 复用已测试原卡片终态；真实投递未验证 | 是 / 候选入口已接线，生产未上线 / 模拟 SDK 局部验证，真实群否 / AT-4 |
| Agent | 候选告警入口→原 Session ingress | 不可信告警资料＋只读任务约束＋原 Skill | 每次写动作先 @ 本人等待本次回复，身份由后端判定 | 原 Run/Session 事件；无第二套审批状态机 | 复用原权限/失败反馈 | 原会话持久化与告警根 ID 幂等 | 原 Run 终态 | 是 / 候选 submit 合同已验证，生产未上线 / 真 Agent 排查未验收 / AT-4 |
| Web | 原会话查询/渲染；无新增跳转或审批入口 | 原 Session 投影 | 无新增写路径 | 原 SSE | 原错误展示 | 原 Session 恢复 | 原终态；未实测新告警会话在真实 Web 的显示 | 无新增 UI / 新告警未生产验证 / 未验证 / AT-4 观察原会话显示 |
| Telegram | 无新增告警入口 | 无新增 | 无新增 | 无新增 | 无新增 | 无新增 | 无新增 | 否 / 否 / 否 / 本期无；构建接口通过，不据飞书结果声称 Telegram 可用 |

AT-4（发布/真实验收）：待用户明确授权将该功能合入 main、推送、发布小 V 并启用目标群配置。发布后只用新告警验证自动排查→原生 @ 本人→本人回复→复查/终态；不得在未获当次业务授权时执行重试、改数等操作。没有自动发布，也没有改变当前生产配置。


## AT-5：运行中迟到消息补漏

用户追问运行中的遗漏。原 1 秒重叠只能覆盖边界延迟，接口先成功返回、5 分钟后才出现的旧消息会漏采，新增有时间边界过滤的回归测试实际失败。修改为配置 `lookbackMs`（缺省 600000，最长 86400000），每轮按上次成功游标回看，启用时间作为下界；持久分页扫描保持原窗口。消息 ID 去重继续避免重跑。另加关机 2 小时后的补读测试，防止误改为“只查现在往前 10 分钟”。

Surface Matrix 增量：飞书 read path 的扫描起点改变；entry/write/event/error/recovery/terminal/owner 规则沿用上表，Agent/Web/Telegram 无新增路径。上线前状态仍为 implemented（候选）、生产 reachable/closed-loop 未验证；AT-4 待发布授权。超过回看范围的消息、被删除或 API 无法读取的消息不承诺自动补齐；已开始但中断的排查不新增自动重跑。

GitNexus 刷新首次出现原生 Napi::Error；影响调用仍返回 readGroup → poll，ConfigSchema 另以 ConfigStore 源码补查；不把失败的刷新记作成功。

AT-5 验证：core、channel-feishu、bridge 构建通过；告警合同、活跃飞书表面及配置/类型测试共 37 项通过。迟到 5 分钟的场景先失败、修正后通过；同一消息跨重启不重复，停机 2 小时的补读通过。GitNexus 第二次刷新成功，未将首次 Napi 错误当作通过。生产轮询间隔此前已配置为 60000ms，新增回看参数缺省 600000ms；功能代码仍未部署。


## AT-6：原卡片 Reaction、SKILL 与五条试运行

用户确认原生表情：OnIt（在做了）、OneSecond（等待本人）、DONE（已恢复）、CrossMark（无需操作）、Sigh（受阻）。直接操作原告警的 messageReaction，替换时只删除当前 app 的已管理状态表情。

后端保存业务状态和各原卡片已投影的表情，按案件串行投递，失败可重试。`fcb alert status` 的目标来自活动 Run 的持久化 Delivery；publisher 无此路由权限。waiting/blocked 统一由后端原生 @ 本人，避免指令要求 Agent 额外 mention 造成双通知。Run 结束不自动等同业务恢复，无结果时受阻提醒。

配置可暂停全量采集；runbookPath 每次新告警和本人回复重读。个人 SKILL 只写入 ~/.agents/skills，镜像使用 symlink。全量启用前保持 enabled=false。本次五条现场试运行读取、业务只读诊断、表情切换及通知均限定在冻结样本；没有执行业务写。

| Surface | entry | read path | write path | event consumption | error handling | recovery | terminal feedback | implemented / reachable / closed-loop / planned |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 飞书 | 候选自动采集＋五条人工发起试运行 | 真实 history、Reaction list、只读业务证据 | 五条原卡片 OnIt→2 CrossMark/3 OneSecond；3 原话题原生 @ 已回读 | 连续采集未启用；正常回复仍由线上旧版本处理 | Reaction 失败不抑制可送达的本人通知 | 状态/投递记录持久化、幂等回读、保留试运行 owner 映射 | 现场结果可见；自动全链路仍未上线 | 是 / 五条真实输出已验证，自动入口未上线 / 手工试运行输出闭环，后台全链路否 / AT-4 发布后验收 |
| Agent | fcb alert status→活动 Run→后端状态 | 每次注入新读 SKILL，矩阵由 Agent 读取 | 只报告业务状态；操作仍逐次本人批准 | 原会话事件 | 无业务结论不标成功 | 同案串行投影与通知去重 | CLI 与适配器合同/表面测试；真实 Agent 自动入口未运行 | 是 / 本地完整调用链测试 / 后台实跑未验证 / AT-4 |
| Web | 原会话入口，无新增审批替代 | 原投影 | 无新增 | 原 SSE | 原机制 | 原机制 | 原终态 | 无新 UI / 未新增真实验收 / 未验证 / AT-4 观察 |
| Telegram | 无新增入口 | 无新增 | 新状态路由拒绝 Telegram 来源 | 无新增 | 拒绝不支持来源 | 无新增 | 无新增 | 否 / 否 / 否 / 本期不接入 |

五条试运行结果：2 条逆向实收等级和入账核对后无需操作；3 条合单当前售后查询成功但缺货未发货，等待本人补货/待货决策。原始消息、只读证据、Reaction 回执、@ 回执和 SKILL 五例回放保存在本机私有试运行目录，不纳入 Git。基于证据的 SKILL 回放 30/30 断言通过，不等同真实后台 Agent/全链路验收。

SKILL 格式校验通过。全局 ~/.agents/skills-check.sh 仍报告原有 ~/.claude/skills/synced 为真实目录；新增技能自己的镜像已补齐。该既有冲突未被隐藏或删除，不能声称全局检查 OK。GitNexus 刷新又遇 Napi::Error，使用已执行 impact 与源码补查；最终提交前再复核。

AT-6 最终本地验证：`pnpm build` 通过；`pnpm lint` 0 errors、8 个既有 Web warnings；飞书通道、告警监控/状态、出站 API、Channel ingress、配置类型和实际生成 fcb 命令的相关回归共 31 文件/286 项通过。新 SKILL 用 skill-creator 的 quick_validate.py 验证通过（临时隔离环境补齐 PyYAML）；全局 skills-check 仍因原有 synced 目录不符合镜像规则而失败。GitNexus 最终重试刷新成功。

五条试运行的负责人、状态、原生表情投递和已通知标记已持久化，collectionStarted=false，enabled=false；没有启动全量采集。首次启用全量会从启用时刻开始，仍保留这五条旧话题的归属与状态。真实现场测试没有触发后台自动 Agent Run，也没有执行用户业务写操作；这些边界不能以本地合同测试替代。
