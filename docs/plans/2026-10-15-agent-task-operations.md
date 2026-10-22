# Agent定时任务与任务处理入口

## 已确认范围

在`feat_channel_task_management`、`4c2cebd`基础上实现：Agent定时任务、任务详情与失败恢复、待处理总览、告警案件只读查看、任务通知方式。沿用现有macOS本地管理、Agent配置、SessionCoordinator、RunExecutor、审批和渠道投递。原本地launchd计划、publisher、业务Skill和告警采集继续使用原机制。本轮仅本地代码与隔离验收，不推送、部署、创建真实计划、改写业务规则或发送真实消息。

## Hermes参照与差异

参考官方说明 https://hermes-agent.nousresearch.com/docs/user-guide/features/cron 和上游实现 https://github.com/NousResearch/hermes-agent/blob/main/cron/jobs.py 、 https://github.com/NousResearch/hermes-agent/blob/main/cron/scheduler.py ：任务定义与运行记录分开、每次使用独立会话、执行前登记运行、计划发生时间作为去重身份、暂停不终止已运行任务、多个错过周期合并、未知结果不自动重跑、通知失败与执行失败分别显示。只采用机制，不复制Python执行器、systemd服务或供应商鉴权。

日历与时区由Croner计算（https://croner.56k.guru/usage/examples/），Bridge只持久化并触发到现有执行器。新增依赖理由：现有launchd编辑器不提供Agent任务的Cron预览或跨时区计算，不能用手写日历替代经过验证的解析器。

## 定义与执行

- 任务定义：名称、指令、Agent、绝对项目目录、已有Skill选择、模型/推理强度/权限模式、一次/间隔/Cron、IANA时区、启停、错过时间处理、通知方式、固定目标。新任务默认暂停；保存和运行是两个明确动作。支持中文常用计划、英文间隔和五段Cron，解析失败明确提示，不猜测不认识的表达。
- 在保存前显示只读预检和接下来3次时间。检查Agent就绪、Runner目录可读、所选Skill对Agent可见、目标连接与允许范围。执行时复核；预检不调用模型、不发消息、不自动授权或分发Skill。
- 新的私有SQLite任务库保存定义、不可变运行快照、计划发生时间、通知尝试与产物元数据。事务认领阻止同任务并行和同一时刻重复触发。手动操作有幂等键和版本检查；编辑不改变历史执行参数。
- 每次创建独立Session，通过SessionCoordinator原子提交与RunExecutor执行；固定会话身份和提交幂等键允许恢复“已登记但尚未完成提交”的阶段。已有Run只读取真实状态，不重新执行业务；租约过期沿用原中断恢复。未知结果暂停后续调度，人工核对后才能重跑。
- 默认不并行运行同一个任务；重叠周期记录跳过。停机错过多个周期按选择补一次或跳过，不积压全部周期。暂停只停止未来触发；恢复重新计算未来计划，不重放暂停期间的任务。
- 通知：仅最终结果、仅异常、开始及关键进度。审批请求始终可见。通知失败保留已生成结果，提供“仅补发结果”；重跑创建新的会话并保留原记录，未知结果重跑要求明确核对确认。关闭/重启不会自动重发结果不明的通知。
- 渠道目标保存在每次运行快照，Agent文件发送按当前活动Run对应的不可变任务快照解析固定目标；普通聊天继续按原投递记录解析。定时任务不伪造聊天来源消息或插入会被普通watcher重复消费的记录。任务通知由任务服务管理，普通聊天保持原渠道watcher。发送成功指API确认，不表示收件人已读。

## 活跃交互入口

- Web“任务”增加Agent定时任务的创建、编辑、预览、暂停、恢复、运行一次、运行记录、结果和恢复操作；保留已有本地计划、推送和告警设置。
- Web“待处理”汇总跨会话的待审批、暂停队列、失败和任务投递失败；带明确状态与跳转上下文，复用原会话内审批、取消和继续操作，不混合审批语义。
- 现有告警任务内增加案件查看：按状态过滤、分页、原消息、合并消息数、结论、负责人/审批人和对应排查会话。只读投影原采集状态，不另造告警状态机。
- Agent可通过CodeBridge任务CLI查看和管理明确指定的计划，复用同一API、版本与幂等约束。飞书/Telegram分别验证目标校验、通知与执行结果；新增计划的主要编辑入口是本地Web/CLI。

## Surface Matrix（实施前）

| Surface | entry | read path | write path | event consumption | error handling | recovery | terminal feedback | planned落点 |
|---|---|---|---|---|---|---|---|---|
| Web | reachable：现有任务导航；planned：待处理导航 | planned：计划/运行/待处理/案件API | planned：定义、启停、运行、恢复 | planned：真实Run投影与状态刷新 | planned：字段错误、冲突保留输入 | planned：补发/新会话重跑/原队列继续 | planned：结果、通知状态、会话入口 | AT-1至AT-5，本轮 |
| Agent | reachable：原Runner/Session执行；planned：任务CLI | planned：定义与执行记录 | planned：同一管理API | reachable：现有Agent事件 | reachable：原权限请求与运行失败 | planned：幂等提交和未知结果保护 | planned：任务状态与结果 | AT-1/2/5，本轮 |
| 飞书 | reachable：现有出站适配器 | planned：任务对应真实投递记录 | planned：固定目标消息/文件 | planned：任务通知，普通会话保持原watcher | planned：目标撤权、断线、发送失败 | planned：仅补发已有结果 | planned：开始/审批/终态按模式反馈 | AT-2/5，模拟SDK闭环；真实账号待切换 |
| Telegram | reachable：现有出站适配器 | planned：任务对应真实投递记录 | planned：固定聊天/话题消息 | planned：任务通知，普通会话保持原watcher | planned：允许名单、断线、发送失败 | planned：结果补发与原游标保留 | planned：真实通知终态 | AT-2/5，模拟API闭环；真实账号待切换 |

## 实施与验收顺序

1. AT-1：公共合同、Cron计算、SQLite定义和运行账本；确定性时钟测试一次/周期、时区、夏令时、冲突、跨实例认领及重启。
2. AT-2：接现有执行器、预检、独立Session、状态和结果、通知、补发/重跑；用真实临时SQLite和模拟Runner/渠道走完整执行，不触达真实服务。
3. AT-3：待处理聚合、原会话跳转、告警案件只读接口；验证审批过期、撤权、归档、案件过滤与分页。
4. AT-4：实际Web入口、表单和详情、保留原任务能力；验证草稿与错误态、重复操作和状态刷新。
5. AT-5：任务CLI、双渠道通知、跨表面交互；全量测试、构建、lint、密钥扫描、分发包全新安装。浏览器双主题桌面/手机批量检查后统一修复，最多再确认一轮。

完成前更新Matrix和实际证据，只有代码或模拟验证的表面不声称真实账号已上线。

## 本地实现完成记录（2026-10-16）

AT-1至AT-5的源码与本地交互已完成。以下`reachable`表示本候选的实际入口已挂载并通过隔离服务调用；`closed-loop`表示在注明的模拟边界内可观察终态，不表示现有主机、真实模型或真实账号已经部署验收。

| Surface | entry | read path | write path | event consumption | error handling | recovery | terminal feedback | 状态与后续落点 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Web | Workbench实际侧栏→TaskWorkspace/待处理；告警配置→案件 | 实际管理API→任务库、Run/Session、Runner权限、原案件状态 | 创建/编辑、预检、启停、运行、审批、恢复；全局配置与任务版本检查 | 真实协调器事件与任务持久投影；5秒刷新；迟到响应丢弃 | 字段错误、旧版本保留草稿、失效权限409、部分来源失败提示 | 原会话处理队列/步骤审批；新会话重跑；仅补发/确认无需补发 | 正文、文件下载、通知回执、原会话和已完成案件会话 | implemented/reachable/closed-loop：双主题桌面与手机，AT-1至AT-5本地完成；planned：真实实例切换验收 |
| Agent | 实际CLI的`codebridge tasks`及Runner注入的`fcb tasks`；原RunExecutor调用 | 同一管理API与真实任务快照 | 非任务会话按用户指令管理；任务会话仅读取和登记本轮结果 | 原执行器接收AgentEvent，按实际Run终态完成记录 | 主机/版本/幂等检查；进入Agent前复核目录、Skill、固定目标；保留原权限机制 | 认领提交缺口复用同一回执；未知结果暂停且不重放；排队过期沿用原保护 | `tasks result`、持久运行与通知记录、文件登记、原会话 | implemented/reachable/closed-loop：真实子进程CLI/fcb、真实协调器/执行器、模拟Agent，AT-1/2/5；planned：真实供应商验收 |
| 飞书 | CLI生产组装把TaskService回调接到实际FeishuBridge出站方法 | 固定目标快照与当下连接/允许范围；原文件主目录校验 | 实际适配器的文本和文件方法，SDK传输模拟 | 独立任务通知账本消费真实Run，普通会话仍由原watcher处理 | 撤权阻止发送；失败与未知结果保留；原文件边界不因缓存放宽 | 手动补发仅发送归档结果，不调用Agent；未知不自动重发 | SDK成功与异常分别投影，发送不等于已读 | implemented/reachable/closed-loop：实际适配器＋模拟SDK，AT-2/5；planned：专用真实聊天逐项验收 |
| Telegram | CLI生产组装接实际TelegramBridge与TelegramApi | 固定chat/topic快照、当前允许名单与连接 | 实际sendMessage/sendDocument路径，HTTP传输模拟 | 相同领域通知规则，经Telegram独立适配验证 | 断线、撤权、发送失败/未知均保留结果 | 独立验证初次通知和补发，不重复业务执行 | 正确chat_id及话题编号，结果状态与原会话 | implemented/reachable/closed-loop：实际适配器＋模拟HTTP，AT-2/5；planned：专用真实聊天逐项验收 |

### 核心实现与保留边界

- 新增`task-schedule.ts`、`agent-task-store.ts`、`agent-tasks.ts`：Croner日历、私有SQLite账本和既有执行器的连接；没有新增另一套Agent执行器。新定义默认暂停；每轮独立会话、不可变参数和目标快照；调度去重、不并行、合并补一次或跳过。
- 新增`task-management-api.ts`、`task-attention.ts`、`alert-incidents.ts`，复用已有认证、本地主机/来源及配置版本保护。创建、运行与通知使用幂等标识；任务更新检查自己的版本。案件只读读取原状态，已完成投递也能定位保留的会话。
- 新增公共类型和Node专用`@codebridge/core/task-cli`子路径，供实际CLI与fcb共享请求实现。任务执行前按快照和当前权限重新检查；Skill仅传原入口。定时任务不通过本入口自行修改长期计划。
- 新增任务编辑/详情/结果、待处理、案件视图；复用原Paper/Carbon样式、会话工作台和原管理页。原渠道凭据、本地launchd计划、publisher、告警采集及业务Skill规则不变。待处理不混合Agent权限、Runtime步骤审批和流程定义审核；原会话继续承接后两者。
- 通知账本与业务执行分离。“仅补发”不调用Agent；未知发送可由人核对后确认无需补发，保留原记录。运行结果不明仍需独立核对，暂停未来计划。
- 文件归档保存原字节与SHA-256，下载只读已登记副本。飞书原文件与缓存均受既有主目录边界；不使用缓存放宽源文件访问。普通会话出站不受任务规则影响。归档上限25,000,000字节；不承诺自动收集所有产物。

### 实际验证与证据

以下命令在仓库根执行。测试使用临时配置、真实临时SQLite与本地HTTP、模拟Agent/渠道传输，不触达实际运行实例。安装测试会从npm拉取公开依赖，并启动自己创建的临时Bridge/Runner；不会探测真实Agent或使用真实凭据。

| 验证 | 结果与覆盖 |
| --- | --- |
| `pnpm build` | 全工作区构建通过；手机布局修正后另运行`pnpm --filter @codebridge/web build`通过 |
| `pnpm test` | 169个测试文件、1,562项通过；覆盖原渠道、队列、执行、配置和新增能力 |
| 最后改动复验 | `pnpm exec vitest run apps/web/src/components/task-interactions.test.tsx apps/bridge/src/alert-incidents.test.ts`：8项通过 |
| `pnpm lint` | 0错误、7条既有React effect警告；本轮未新增警告 |
| 调度与恢复 | 日历/时区/夏令时；跨Store发生时间去重；独立会话；认领提交缺口；暂停、不并行、错过周期；一次性相对时间编辑不顺延；未知结果不重跑 |
| 合同与实际执行 | 真实协调器/执行器与HTTP：版本409、创建幂等、审批FIFO旧ID拒绝、运行前撤权、未知通知不自动重发、补发不重新执行、人工确认无需补发、文件字节保留及权限 |
| Agent表面 | 实际编译后的CLI与注入fcb子进程；help不创建配置，参数及当前Run身份正确传递；计划内禁止长期任务变更 |
| 飞书与Telegram表面 | 分别使用实际通道适配器；飞书SDK和TelegramApi的HTTP模拟；文本、文件、目标/话题及补发验证，未以某一渠道的行为推断另一渠道 |
| 实际浏览器 | Paper/Carbon各1440×1000、390×844，两轮；每组11条流程：创建预览/暂停保存、运行结果、待处理、补发、文件下载、启停、新会话重跑、一次性触发、真实Runner权限队列、仅异常通知、案件筛选/分页/草稿保留/完成会话跳转。每组4次Agent模拟执行；实际定时发生时间仅一次。0页面错误、0意外API错误、0外部请求 |
| 手机布局 | 第一轮截图发现编辑器Grid最小宽度溢出；修正单列轨道及收缩约束，第二轮增加所有可见表单控件的屏幕边界断言并通过，截图确认完成，停止视觉迭代 |
| 本地分发与全新安装 | `node scripts/package-release.mjs`及`pnpm test:package`通过；全新临时项目安装0.1.0候选，验证CLI/init、内部导入、带认证Runner、管理读写和工作台资源；测试进程及临时目录已由脚本关闭清理 |
| 密钥扫描 | `GITLEAKS_BIN=<gitleaks绝对路径> pnpm secrets:check`通过：历史与当前目录均未发现泄漏，个人主目录路径检查通过 |

本地证据文件名：`codebridge-tasks-final-{build,tests,lint,ui-tests,secrets,package,install}.log`；浏览器第二轮记录为`agent-task-operations-20261016-5cc25918/verification.json`及16张截图，位于本次聊天可视化附件目录。日志和测试驱动留在仓库外，不打包用户运行数据。

### 风险、限制与未执行

影响检查对任务状态与执行准备的共享入口评为HIGH/CRITICAL，原因是调用链涉及调度、队列恢复及通知；已逐项核对实际调用并覆盖相关回归，未把评级降低成“无风险”。GitNexus全图流程提取有入口、分支和深度容量上限，缺少某条流不证明该路径不存在；提交门禁结合源码、真实API/CLI/浏览器与测试证据，不依赖图查询缺失断言。

尚未执行公开分支合并、远端推送、npm发布、真实实例配置迁移、真实供应商模型或真实渠道账号验收。部署后仍须按[使用说明](../zh-CN/agent-tasks.md)在专用聊天验证文本、文件、审批及一个完整调度周期。Web仍信任本机操作系统用户，不是多用户权限隔离系统。本轮没有新增跨会话搜索、长期记忆、heartbeat、Skill DSL或多Agent编排。
