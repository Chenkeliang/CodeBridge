# CodeBridge 命令体系与自动验证设计

> 交付状态为设计，实施和上线按 §7 执行。
> 源码基线 6f26b290115a703fa6f90fc968fa5393396e42ac，来自已拉取的 origin/main。GitNexus 以当前 checkout 运行 `analyze --index-only --pdg`，本地索引已对齐。
> 证据快照 schema 2，全局差异摘要 0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd，引用文件 21 个，排除本设计文件自身。

## 1. 目标

给 Codex、Pi、Claude 和 OpenCode 建一套可持续维护的命令体系。CodeBridge 自带命令有唯一登记处，Agent 原生命令按当前会话与项目动态发现，同时通过权限和执行证据决定是否可用。新版本上线前自动检验，线上能力变化自动更新清单。日常新增、删除、改名、参数变更或适配器暂时不可用只需要机器收集、比对和校验。新增权限、提升执行能力，以及缺少可机器判定结果的命令才进入人工复核。

命令清单的“最终版”是稳定的 CodeBridge 命令加动态的 Agent 命令。各端展示当前可用能力，版本差异由运行时处理。

## 2. 现状和缺口

- [verified] `handleSlashCommand` 直接处理 CodeBridge 的命令，其余返回 Agent 文本。飞书和 Telegram 调用它。Web 的候选项只是填入原文本并提交消息。见 `packages/router/src/slash-commands.ts:88`、`packages/channel-feishu/src/bridge.ts:650`、`packages/channel-telegram/src/telegram-bridge.ts:232`、`apps/web/src/components/composer.tsx:109`、`apps/web/src/components/workbench.tsx:605`。
- [verified] 飞书给发送者、告警和引用上下文加包装，包装可出现在命令前，也能追加到命令参数之后。现有群路由另有权限检查和告警续聊分支。见 `packages/channel-feishu/src/bridge.ts:642`、`packages/channel-feishu/src/bridge.ts:878`。
- [verified] Runner 对 ACP 和 Pi 已有不同执行路径。命令读取接口有 Codex 静态条目和 Pi Skills，其他 ACP 上报通过运行事件进入投影。Web 命令查询会从任务事件回查最近上报。见 `packages/runner-host/src/server.ts:720`、`packages/runner-host/src/server.ts:950`、`packages/work-items/src/session-projector.ts:292`、`apps/bridge/src/session-api.ts:600`。
- [verified] 本轮之前的运行环境检查中，Codex ACP 1.13.1 和 Claude ACP 0.81.1 的新会话握手都上报了 `/compact` 和 `/goal`。Pi SDK 1.5.2 提供压缩方法和命令解析，OpenCode 未安装，只能依据上游合同设计。上报结果支持列入候选，执行状态需走专门验证。

## 3. 架构和最终命令清单

使用既有 Bridge、Runner、ACP/Pi 和会话事件链路。Bridge 统一解析请求、展示授予本人的能力、路由并审计。Runner 执行已解析的请求，保留原有任务租约、模型、沙箱、工具审批和事件通道。原生能力的发现优先用 ACP `available_commands_update` 或 Pi SDK 的资源读取。菜单不推断行为。参考 [ACP Slash Commands](https://agentclientprotocol.com/protocol/v1/slash-commands)、[Codex ACP](https://github.com/agentclientprotocol/codex-acp/)、[Pi SDK](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/sdk.md)、[Claude ACP](https://github.com/agentclientprotocol/claude-agent-acp/)、[OpenCode ACP](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/cli/acp.mdx)。

### CodeBridge 稳定命令

| 类别 | 命令与参数 | 处理方式 |
| --- | --- | --- |
| 发现与状态 | `/commands [关键词]`、`/help [full]`、`/menu`、`/status` | 新增 `/commands` 展示当前会话可用命令与来源。帮助、快捷入口和状态查询继续走现有处理。 |
| 运行 | `/stop`、`/continue`、`/steer <指令>`、`/approve`、`/deny` | 复用当前运行、排队和审批接口。可用性按会话当前状态、Agent 能力和发起人权限判定。 |
| 会话 | `/new`、`/resume [N｜last｜all]`、`/session close <id>`、`/session delete <id>` | 维持当前范围、确认和身份校验。旧会话的续聊与告警权限继续沿用原绑定。 |
| Agent 设置 | `/backend [名称｜default]`、`/model [list｜名称｜default]`、`/effort [list｜级别｜default]`、`/permission [list｜模式｜default]`、`/config [选项 值]`、`/thinking [on｜off]` | 同名 Agent 命令由现有 Bridge 路由优先处理。菜单可用选项取自当前适配器。查询和修改仍按各自权限判定。 |
| 工作区 | `/cd <目录>`、`/roots`、`/root add｜remove <目录>`、`/ws list｜save｜use｜remove` | 沿用目录授权和工作区范围。群内状态与命令结果使用项目相对路径或脱敏摘要。 |
| 文件与 Git | `/send <文件>`、`/clone <仓库> [目录名]`、`/pull` | 保持既有命令与权限。Agent 的同名命令不劫持这些入口。 |

现有别名如 `/s`、`/x`、`/b`、`/r`、`/reset` 随原命令保留。现有 `/transport` 继续响应兼容提示，默认菜单可以省略。Web 已有工具栏等价操作沿用原按钮，命令清单只显示该入口实际能执行的项。

### Agent 动态命令

| Agent | 首批闭环 | 后续按能力开放 |
| --- | --- | --- |
| Codex | `/compact` 通过当前 ACP 会话执行，等待可信压缩完成信号 | `/goal` 查看、设置、暂停、恢复或清理以当前适配器支持为准。`/review`、`/review-branch`、`/review-commit` 走原生审查。其他命令动态发现 |
| Pi | `/compact [说明]` 调用当前 SDK 会话的 `compact()` | 从资源加载器发现 `/skill:<名称>` 和项目模板，继续用 SDK 的解析。依赖终端选项或无结果的扩展应单独验证 |
| Claude | 同一 ACP 压缩链路通过适配器验收后开放 `/compact` | `/context`、`/usage` 先确认可渲染输出。`/goal`、`/simplify` 及项目 Skills 按能力和权限纳入 |
| OpenCode | 启用并接入真实适配器后，用同一合同验证 `/compact` | 自动发现项目自定义命令。对可能执行 shell、启动子任务或外部操作的模板沿用现有执行审批 |

`/logout`、会话清除、设置修改、外部发布、公开分享等能力保留现有受控入口。仅由原生命令声明发现的同类操作不能经普通消息链路取得额外权限。现有 Cursor 路径按同一协议接受发现事件，首批只验证现有行为未回归。

## 4. GitNexus 影响与调用关系

- [graph] 对共享 `handleSlashCommand` 做 upstream 影响分析，GitNexus 报告 CRITICAL。图对共享边的统计包含多处泛化依赖，直接调用范围以源码核实为飞书、Telegram，以及相关测试。Web 的消息提交和配置控件独立接入，验证时需另走实际入口。
- [verified] 命令目录用 `projectCommands` 存每个会话的命令快照，现有会话查询还会回查任务事件。实施时先核实投影覆盖的新建、恢复和重启场景，再改为同一读模型供各端查询。`session-projector.test.ts` 和 `session-api.test.ts` 已覆盖命令快照及 Runner 列表失败的基本合同。
- [verified] Runner 上的 `listCommands`、ACP 执行和 Pi 执行已经在各自后端路径内。能力发现复用这些边界，跨通道无需各自维护 Agent 命令映射。

## 5. 语句级约束

- [graph] `handleSlashCommand` 的 PDG 显示 `/stop` 的实际取消调用由 Runner 回调存在性保护，`/continue` 的调用由 slots 和队列接口保护。保留这些原生执行分支与前置条件。新入口只接剩余的 Agent 命令及只读清单。
- [graph] `registerSessionRuntimeCommandRoutes` 的队列取消依赖请求版本和幂等键检查。对新增命令复用同一会话的运行串行化和同一入口的幂等接收，避免旁路并发控制。
- [verified] 飞书 `dispatchToAgent` 的文本数据流由源码定位，PDG 对该符号未返回可用的数据流。原生指令必须在引用和告警包装前确定，引用和业务提示仍走普通消息路径。用户身份、原飞书消息、话题和权限继续作为受信任元数据传入，Agent 结果不能反向补出这些身份。
- [inferred] 版本变化使旧命令证明失效，已排队命令需在派发前重新核对会话与权限。当执行状态不确定时先对账，助手文本中的“操作成功”不能升格为实际完成。

## 6. 实施设计

### 6.1 清单与发现

复用 `command-help.ts` 中的 CodeBridge 内建命令描述和现有处理器。清单项携带名称、参数提示、来源、作用域、可用状态和原因。Bridge 将内建命令、当前会话原生事件和 Pi 资源索引汇总成相同响应。保留 `GET /v1/sessions/:session_id/commands` 给工作台，飞书与 Telegram 的 `/commands` 用可信聊天绑定查询同一服务。不要把菜单渲染下沉到 Runner。

- Agent 启动、续聊或原生上报更新时刷新。上报代表该作用域的整份清单，应覆盖写入，空清单也能撤下旧项。按本轮绑定、项目、适配器/SDK 版本和本次上报范围判定，不能把上一项目或上一版本的数据当作当前可用项。
- 没有现成会话的情况下，支持时使用临时发现会话做无 prompt 握手，按作用域合并同时请求并限制探测次数。握手能力未知或失败时返回可诊断状态，内建命令照常，列表查看不新增用户可见的持久聊天记录、调用业务工具或执行已发现的命令。
- 普通用户只看到其可执行的清单。管理员或维护诊断可看到已发现、待验证或已禁用项的原因。适配器的描述和参数提示只作文本数据，不进入授权规则或 shell。

### 6.2 调用与结果

1. 通道先处理其自己的运输格式，例如机器人提及，然后从真实用户本轮输入识别命令。仅识别以命令开头的本轮消息。引用、转发、告警卡、工具输出和 Agent 内容不参与命令识别。
2. CodeBridge 内建命令和别名优先。原生命令由 Bridge 对当前已绑定的会话、权限及有效能力做匹配，并在派发前复核。命令名按协议规范化，参数原文和分隔边界保留。对看起来是独立命令而不可执行的输入给出明确原因，并提供现有普通消息交互方式让用户说明意图。
3. 通过既有会话消息受理传入受信任的命令类型与参数，普通消息保持现有的上下文增强。原生分支只给 ACP 发送命令文本块，Pi 的 SDK 操作传结构化参数。现有 run 指令前缀也须识别原生分支。继续传递身份和投递凭据，但使用消息绑定元数据承载。告警续聊的普通分支和审批链路继续独立核验。
4. 复用同一会话锁、幂等键与事件投影。正在运行的会话按现有并发规则排队或给出忙状态，`/steer` 维持现有路径。切换后端、取消、过期、权限变更或会话丢失按现有项目状态拒绝执行，不把原生命令转到另一会话。
5. 可观测结果分为未提交、已受理/排队、运行中、成功、拒绝、失败、结果未知。用 Pi SDK 返回值或 ACP 可关联的结构化完成事件证明状态变化，普通回复内容只展示给用户。ACP 命令缺乏足够完成证据时标结果未知，禁止自动补发。幂等查询恢复已有结果和卡片，不重发命令。

### 6.3 自动化防线

| 时点 | 机器动作 | 反馈与放行规则 |
| --- | --- | --- |
| 运行中发现 | 比对清单新增、消失、改名、参数以及启动身份/版本变化。完整未知条目自动进入发现记录。有效快照和检查结果挂到当前运行身份。 | 已验证、同权限且行为合同未变的能力可按既有规则展示。普通上游声明只进入发现状态。未经核验的条目不以可执行命令展示。 |
| 候选构建 | 在 CI 跑协议合同与已有回归。在隔离的 Runner 中按候选实际启动向量探测四种 Agent，使用合成工作区/会话验证已受信行为。不复用线上凭据、会话、项目授权或飞书投递。 | 比对适配器/SDK、版本、清单摘要、路由、参数、预期终态和权限用例。阻断已支持命令消失、同名抢占、行为变更和权限提升。可选 Agent 未安装记为未验收，禁止显示已支持。 |
| 发布前与启动后 | 复用现有发布准备和就绪检查，核对候选证据与实际部署版本。启动后握手并持续消费真实会话的状态事件，发现漂移自动摘下受影响原生命令。 | 健康结果区分稳定命令与 Agent 扩展。探测失败仅影响对应 Agent/作用域，恢复后重新验证。保留授权范围内已验证的版本证据。 |
| 日常复核 | 启动和版本变更立即触发。再复用现有巡检周期比对当前状态。按 Agent、版本、能力、原因去重，只有新增影响或恢复时更新管理员诊断。 | 已有适配规则自动吸收小改动。新增授权、外部执行、无法自动观察终态、生产变更需人工决策。失败无需人为逐条改表。 |

巡检同时记录官方上游版本和 Runner 实际加载版本。只读发现上游新版本后，可自动生成隔离候选报告。候选本身使用精确版本，发布仍走既有机制。举例来说，若 Claude 新增可返回状态的命令，巡检自动记录名称与参数。已有可信的只读调用合同可在通过探测后自动登记。只有名称和描述的条目继续等待能力验证。若既有 `/compact` 消失，则阻断该候选或隔离线上该能力，并保留其余命令。

把自动探测接入既有检查和诊断命令，提供只握手、只发现的模式，权限请求一律拒绝。当前 `scripts/acp-probe.mjs` 有真实 prompt 测试与主动选择权限选项的路径，能力探测不得复用这些行为。现有发布和群消息授权继续由部署流程核验，巡检只记录结果。

## 7. 实施顺序及通道矩阵

### Herdr 独立复核后的实施边界

现版整套执行方案的审查结论为 NOT READY。下文 CB-CMD-1 首次交付限定为只读目录。Bridge 读已存在的会话投影，三端只展示当前查看者有权读取的命令。ACP 上报统一标为已发现，Web 候选可查看但不可从目录触发执行。空上报撤回上一份清单。列表查询无 Runner 调用、临时握手、SDK 资源加载、Agent 执行或对话创建。原来用户手输的普通消息与斜杠转发合同延续，目录权限与执行权限分别处理。

CB-CMD-2 只在隔离环境验证。开放执行前，必须从三端及直接 API 验证同一个最终授权入口，绑定真实发送者、原消息、槽位代次、会话和 provider 会话，保留原文参数，并证明压缩成功、取消和结果未知的区别。Pi 原会话缺失时不能新建。第一次可能派发前写入持久边界，跨过边界后断线只对账。CB-CMD-3 的发布控制器门禁必须先于首个原生命令的线上开放生效。目录先行不依赖后续阶段。CB-CMD-4 仅保留为扩展候选，各自验收后进入实际清单。

CB-CMD-1 的完成标准为三端读取同一观察数据、权限不扩大、冲突和空更新可见、Runner 不因读目录启动。§13 为整个方案的完成标准。暂时无法识别来源代次、适配器制品和完成事件的快照只能作为观察数据使用。

1. **CB-CMD-1 清单和命令优先级。** 统一查询现有会话的已发现清单、授权过滤、来源和失效状态。Web 刷新候选，飞书和 Telegram 增加 `/commands` 查询。先记录差异。
2. **CB-CMD-2 执行与终态。** 完成 Codex 原生 `/compact`、Pi SDK `compact()`，并独立接三端的实际入口。Claude、OpenCode 进入相同 ACP 验收链路，安装与能力测试通过后再显示可执行。
3. **CB-CMD-3 自动验证和恢复。** 将差异对比、拒绝权限探测、候选版本门禁和就绪摘要接入既有 CI 与发布检查。完成权限、版本漂移、失败告警和重启恢复验收。
4. **CB-CMD-4 扩展。** 先做已知标准的 `/goal`、`/review` 和 Claude `/context`、`/usage` 的无副作用探测，再接 Pi 项目模板。在前四项基础上，新增的上游命令优先复用同类已验证接口。需要新调用和授权语义的能力再补窄适配。

矩阵状态针对本设计能力。实施后逐面重验，任一条目不能用另一入口的结果代替。

| 表面 | 当前状态 | 入口与读取 | 执行及事件 | 错误、恢复与终态 | 计划 |
| --- | --- | --- | --- | --- | --- |
| Web | 清单部分 implemented、reachable。原生控制闭环未验收 | 当前会话命令菜单，查询后端清单，消费命令更新和失效 | 现有消息入口受理原生命令，订阅会话事件 | 提示不可用或失败。重连补拉状态，同一条消息显示明确终态 | CB-CMD-1/2/3 |
| Agent/Runner | ACP/Pi 现有调用 implemented、reachable。显式原生命令合同 planned | ACP 上报、Pi 资源读取，按当前适配器身份发现 | 校验后通过 ACP 或 Pi SDK 执行，返回受理和完成证据 | 超时后按运行 ID 查询。不切换 Agent，不以自然语言代替完成证据 | CB-CMD-1/2/3/4 |
| 飞书 | 内建命令 implemented、reachable。统一清单和原生保真路径 planned | 当前群或话题 `/commands`，按本人权限显示 | 从原消息识别并绑定本会话，事件回原话题卡片 | 无权限、会话过期、结果未知都在原话题明确呈现。重连复用卡片与消息 ID | CB-CMD-1/2/3 |
| Telegram | 内建命令 implemented、reachable。统一清单和原生保真路径 planned | 当前私聊、群或话题 `/commands`，查询同一清单 | 会话绑定与授权独立检查，消费对应任务事件 | 复用消息或状态编辑入口恢复，验证群/话题不串，完成后可继续对话 | CB-CMD-1/2/3 |

## 8. 验证方案

先用合成工作区、模拟适配器和本地 Runner 验证，无真实群消息、业务请求、发布或审批。真实适配器用隔离账号和会话验收，不更改原有线上对话。实际飞书、Telegram 验收使用明确授权的测试通道，Web 在同版本工作台验收。

| 场景 | 通过条件 |
| --- | --- |
| 发现增删、同名、异常描述、版本切换、旧会话恢复 | 新项自动出现为已发现。删项自动撤回。内建优先。无权用户看不到内部条目。旧版本清单不能跨会话生效 |
| Web、飞书和 Telegram 各发一次 `/compact` | ACP 收到完整原文且正好一次，Pi 调 SDK，回传终态。原会话 ID 相同，下一轮可继续且未手工粘贴历史 |
| 引用中含命令、告警上下文、参数含多行和特殊字符 | 引用内命令不执行。真实命令传入原始参数。普通话题续聊保留原上下文 |
| 群非管理员、管理员、审批人、另一个成员回复或 steer | 同一权限由真实原消息和通道身份判断。未经授权调用在 Runner 前被拒。其他人的回复、插队和审批身份不授予新权限 |
| 处理中、重复投递、重连、失效、无终态事件 | 排队或明确拒绝。重试复用原请求。未知结果能恢复查询，后台没有二次执行 |
| 升级破坏既有能力或 OpenCode 未启用 | 机器门禁报告破坏项和实际版本。缺失条目不显示为已上线。不影响其他 Agent 的稳定命令 |

合同层复用 `packages/router/src/slash-commands.test.ts`、`packages/work-items/src/session-projector.test.ts`、`apps/bridge/src/session-api.test.ts`。通道层分别验证 `packages/channel-feishu/src/bridge-stream.test.ts`、`packages/channel-telegram/src/telegram-bridge.test.ts`、`apps/web/src/components/composer.test.tsx` 及实际发送链路。新增本地目标回归按项目约定放任务工作区、验证后清理。未来实施时运行 `pnpm test --no-file-parallelism <相关测试文件>`、`pnpm build`、`pnpm lint`、`git diff --check`。提交前另跑 `pnpm secrets:check`。能力探测作为运维功能纳入候选门禁。

## 9. 风险、审计与恢复

- 权限来自 Bridge 验证的调用者和当前作用域。适配器上报的文本或“只读”名称没有可信权限语义。只读、会话修改、工具执行和主机/外部操作分别按现有授权处理。任何未出现在已验证合同的作用都不能自动提权。
- 保留已有会话与指令事件的唯一关联。审计包含入口、命令名称、版本、作用域、决策、运行状态与原因，不输出真实群 ID、命令原始秘密、本机路径或其他项目的状态。运行结果经过现有通道的脱敏规则再展示。
- 发现使用有限握手时间、单作用域并发合并和有界查询，避免打开每次菜单都启动新进程。诊断区分未安装、未上报、待验证、已禁用、Runner 不可达和结果未知。未知状态靠已有事件对账。
- 阶段 1–3 每一步能独立验证。线上原生命令异常时，关闭该 Agent 对应能力的可用状态，保留内建和健康 Agent，既不撤销批准过的其他配置，也不重放任何操作。

## 10. 预计变更面

| 文件 | 责任 |
| --- | --- |
| `packages/router/src/command-help.ts`、`packages/router/src/slash-commands.ts` | 内建描述、原生命令解析优先级及统一入口接线 |
| `packages/runner-host/src/server.ts`、`packages/backends/src/acp/acp-session-runner.ts`、`packages/backends/src/pi-session-runner.ts` | 当前后端发现、执行及可核验结果 |
| `apps/bridge/src/session-api.ts`、`apps/bridge/src/session-runtime-api.ts`、`packages/work-items/src/session-projector.ts` | 清单投影、命令受理、既有事件与持久化 |
| `packages/channel-feishu/src/bridge.ts`、`packages/channel-telegram/src/telegram-bridge.ts` | 权限、原消息与话题绑定及用户回执 |
| `apps/web/src/components/composer.tsx`、`apps/web/src/components/workbench.tsx` | 可用状态与实时清单，执行反馈 |
| `scripts/acp-probe.mjs`、`.github/workflows/ci.yml` | 复用握手和已有构建入口增加隔离探测与候选验证，实际发布控制器接线在 CB-CMD-3 核对 |

## 11. 实施上下文

```yaml
implementation_context:
  task_summary: 统一稳定命令和动态 Agent 清单，复用现有会话执行链，实现自动验证和失效隔离。
  acceptance_criteria:
    - 三端清单来自同一后端语义且只展示实际可用命令
    - Codex 和 Pi 压缩同一会话并获可信终态
    - 新版本能力差异、冲突、权限和退化由自动检查捕获
  evidence_provenance:
    schema_version: 2
    head_commit: 6f26b290115a703fa6f90fc968fa5393396e42ac
    generated_plan_path: docs/plans/2026-11-19-gitnexus-plan-agent-command-discovery.md
    global_dirty_digest:
      algorithm: sha256
      canonicalization: gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records
      value: 0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd
    cited_path_manifest:
      - path: .github/workflows/ci.yml
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:735fec4a97736d305ae793c4b1a72a0d4834642a5ecbe5e5b0e745fe74e0ea24
        index_digest: sha256:735fec4a97736d305ae793c4b1a72a0d4834642a5ecbe5e5b0e745fe74e0ea24
        worktree_digest: sha256:735fec4a97736d305ae793c4b1a72a0d4834642a5ecbe5e5b0e745fe74e0ea24
        untracked_digest: absent
      - path: apps/bridge/src/session-api.test.ts
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:eaf260744f17661f44309616a3d64276e159ae9108d8d713336c4e79262ed6c9
        index_digest: sha256:eaf260744f17661f44309616a3d64276e159ae9108d8d713336c4e79262ed6c9
        worktree_digest: sha256:eaf260744f17661f44309616a3d64276e159ae9108d8d713336c4e79262ed6c9
        untracked_digest: absent
      - path: apps/bridge/src/session-api.ts
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:02fcab40fd61d7830e3e93622573799672c1c284a50662245c8419056a943431
        index_digest: sha256:02fcab40fd61d7830e3e93622573799672c1c284a50662245c8419056a943431
        worktree_digest: sha256:02fcab40fd61d7830e3e93622573799672c1c284a50662245c8419056a943431
        untracked_digest: absent
      - path: apps/bridge/src/session-runtime-api.ts
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:92dc8fb1cf220a0d3cb67de70d8d4e9047455fe875a4a58f40189db8e1eb8e32
        index_digest: sha256:92dc8fb1cf220a0d3cb67de70d8d4e9047455fe875a4a58f40189db8e1eb8e32
        worktree_digest: sha256:92dc8fb1cf220a0d3cb67de70d8d4e9047455fe875a4a58f40189db8e1eb8e32
        untracked_digest: absent
      - path: apps/web/src/components/composer.test.tsx
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:6fd56bab52f92bbcbc90a3bcf4d4ca00cc19434d186852e82c611285b46891f8
        index_digest: sha256:6fd56bab52f92bbcbc90a3bcf4d4ca00cc19434d186852e82c611285b46891f8
        worktree_digest: sha256:6fd56bab52f92bbcbc90a3bcf4d4ca00cc19434d186852e82c611285b46891f8
        untracked_digest: absent
      - path: apps/web/src/components/composer.tsx
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:cf8fe6ef8c62f5a31bf290ef7954de6ef50f6a60e7f31a50069338d4dcbabc6f
        index_digest: sha256:cf8fe6ef8c62f5a31bf290ef7954de6ef50f6a60e7f31a50069338d4dcbabc6f
        worktree_digest: sha256:cf8fe6ef8c62f5a31bf290ef7954de6ef50f6a60e7f31a50069338d4dcbabc6f
        untracked_digest: absent
      - path: apps/web/src/components/workbench.tsx
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:cffa97bb9f0259b27d8d25ff846fa2561415c3ea3d584243f911aafac47c5b98
        index_digest: sha256:cffa97bb9f0259b27d8d25ff846fa2561415c3ea3d584243f911aafac47c5b98
        worktree_digest: sha256:cffa97bb9f0259b27d8d25ff846fa2561415c3ea3d584243f911aafac47c5b98
        untracked_digest: absent
      - path: package.json
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:eabcbd725c2b120bda52a731a20c93fd9e502086bf09a29af745748ab14e0b37
        index_digest: sha256:eabcbd725c2b120bda52a731a20c93fd9e502086bf09a29af745748ab14e0b37
        worktree_digest: sha256:eabcbd725c2b120bda52a731a20c93fd9e502086bf09a29af745748ab14e0b37
        untracked_digest: absent
      - path: packages/backends/src/acp/acp-session-runner.ts
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:9d9724a73028592b5a5a744fdecd68caaccb1f037ef429a6927c867ae355d5a7
        index_digest: sha256:9d9724a73028592b5a5a744fdecd68caaccb1f037ef429a6927c867ae355d5a7
        worktree_digest: sha256:9d9724a73028592b5a5a744fdecd68caaccb1f037ef429a6927c867ae355d5a7
        untracked_digest: absent
      - path: packages/backends/src/pi-session-runner.ts
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:ab0e8c4895e15608df7d3b5e5093c40a5ca6af9b5f35a00a04a189e3073fefc2
        index_digest: sha256:ab0e8c4895e15608df7d3b5e5093c40a5ca6af9b5f35a00a04a189e3073fefc2
        worktree_digest: sha256:ab0e8c4895e15608df7d3b5e5093c40a5ca6af9b5f35a00a04a189e3073fefc2
        untracked_digest: absent
      - path: packages/channel-feishu/src/bridge-stream.test.ts
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:e0462732c3876846b64f44e0cc21acacdbec5a55fc52d31d1a2606e01f765ec1
        index_digest: sha256:e0462732c3876846b64f44e0cc21acacdbec5a55fc52d31d1a2606e01f765ec1
        worktree_digest: sha256:e0462732c3876846b64f44e0cc21acacdbec5a55fc52d31d1a2606e01f765ec1
        untracked_digest: absent
      - path: packages/channel-feishu/src/bridge.ts
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:47814442dc21d94620c24d3dd0792fde9718dd1879bf85d0c4f9a5794e7e80c4
        index_digest: sha256:47814442dc21d94620c24d3dd0792fde9718dd1879bf85d0c4f9a5794e7e80c4
        worktree_digest: sha256:47814442dc21d94620c24d3dd0792fde9718dd1879bf85d0c4f9a5794e7e80c4
        untracked_digest: absent
      - path: packages/channel-telegram/src/telegram-bridge.test.ts
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:ee92710c77105f27026cdd336f522551c69ec7363f86554bc4db53a1dd080ff3
        index_digest: sha256:ee92710c77105f27026cdd336f522551c69ec7363f86554bc4db53a1dd080ff3
        worktree_digest: sha256:ee92710c77105f27026cdd336f522551c69ec7363f86554bc4db53a1dd080ff3
        untracked_digest: absent
      - path: packages/channel-telegram/src/telegram-bridge.ts
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:8b8d36ef52044f75f3a2202039f195d9263e6b98e6a8d607a1058e120855cbe5
        index_digest: sha256:8b8d36ef52044f75f3a2202039f195d9263e6b98e6a8d607a1058e120855cbe5
        worktree_digest: sha256:8b8d36ef52044f75f3a2202039f195d9263e6b98e6a8d607a1058e120855cbe5
        untracked_digest: absent
      - path: packages/router/src/command-help.ts
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:861756291acd8d809b1438e3f5cab075ab0689833f7379c844344b4689329261
        index_digest: sha256:861756291acd8d809b1438e3f5cab075ab0689833f7379c844344b4689329261
        worktree_digest: sha256:861756291acd8d809b1438e3f5cab075ab0689833f7379c844344b4689329261
        untracked_digest: absent
      - path: packages/router/src/slash-commands.test.ts
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:93c4d440460b791a7e6a4da332c1c68f4404b95206deea14fca66f4047c0533a
        index_digest: sha256:93c4d440460b791a7e6a4da332c1c68f4404b95206deea14fca66f4047c0533a
        worktree_digest: sha256:93c4d440460b791a7e6a4da332c1c68f4404b95206deea14fca66f4047c0533a
        untracked_digest: absent
      - path: packages/router/src/slash-commands.ts
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:5d082d1b4ec15d6258b6fb7dcc5c058f292931af745a5a75e3c850c9992e069a
        index_digest: sha256:5d082d1b4ec15d6258b6fb7dcc5c058f292931af745a5a75e3c850c9992e069a
        worktree_digest: sha256:5d082d1b4ec15d6258b6fb7dcc5c058f292931af745a5a75e3c850c9992e069a
        untracked_digest: absent
      - path: packages/runner-host/src/server.ts
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:40a084f9c26859696a59cdc957817c46455fbe55997bbe3e823373c93a241eab
        index_digest: sha256:40a084f9c26859696a59cdc957817c46455fbe55997bbe3e823373c93a241eab
        worktree_digest: sha256:40a084f9c26859696a59cdc957817c46455fbe55997bbe3e823373c93a241eab
        untracked_digest: absent
      - path: packages/work-items/src/session-projector.test.ts
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:f68bfb5a5dc674ba83600488224c46d3a8a1cbdd75429b9bf8a4602a860ca65d
        index_digest: sha256:f68bfb5a5dc674ba83600488224c46d3a8a1cbdd75429b9bf8a4602a860ca65d
        worktree_digest: sha256:f68bfb5a5dc674ba83600488224c46d3a8a1cbdd75429b9bf8a4602a860ca65d
        untracked_digest: absent
      - path: packages/work-items/src/session-projector.ts
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:2f1530e67650d393da7860fdcf3b9b2196a9a0cebcfd2dc7cc9021521f6ed45e
        index_digest: sha256:2f1530e67650d393da7860fdcf3b9b2196a9a0cebcfd2dc7cc9021521f6ed45e
        worktree_digest: sha256:2f1530e67650d393da7860fdcf3b9b2196a9a0cebcfd2dc7cc9021521f6ed45e
        untracked_digest: absent
      - path: scripts/acp-probe.mjs
        object_kind:
          head: regular
          index: regular
          worktree: regular
          untracked: absent
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:eecef79e7330c4e40a07ea8446807122c39165f4244128cd00742606e746ec0a
        index_digest: sha256:eecef79e7330c4e40a07ea8446807122c39165f4244128cd00742606e746ec0a
        worktree_digest: sha256:eecef79e7330c4e40a07ea8446807122c39165f4244128cd00742606e746ec0a
        untracked_digest: absent
  primary_symbols:
    - symbol: handleSlashCommand
      file: packages/router/src/slash-commands.ts
      lines: 88-382
      role: 内建优先和现有 Agent 文本分流
    - symbol: dispatchToAgent
      file: packages/channel-feishu/src/bridge.ts
      lines: 792-890
      role: 飞书普通消息上下文包装
    - symbol: RunnerHost.listCommands
      file: packages/runner-host/src/server.ts
      lines: 720-747
      role: 运行后端命令目录
    - symbol: projectCommands
      file: packages/work-items/src/session-projector.ts
      lines: 292-326
      role: 会话命令快照
    - symbol: registerSessionRuntimeCommandRoutes
      file: apps/bridge/src/session-runtime-api.ts
      lines: 26-197
      role: 现有受理、幂等和恢复
  related_symbols:
    - symbol: listPiCommands
      relationship: 供 RunnerHost.listCommands 调用
      relevance: 扩展 Pi 的 SDK 资源发现
    - symbol: buildPromptBlocks
      relationship: 准备 ACP 调用
      relevance: 原生命令文本边界
    - symbol: Composer 与 Workbench submit
      relationship: 读取菜单并发消息
      relevance: Web 独立验收
  execution_path:
    - 通道可信输入
    - 匹配稳定命令或已验证能力
    - 复用会话受理与序列化
    - Runner ACP/Pi
    - 终态与会话事件
    - 入口回执
  pdg_constraints:
    - description: 停止和继续依赖已有 Runner 回调与队列状态
      affected_statements:
        - packages/router/src/slash-commands.ts:126
        - packages/router/src/slash-commands.ts:144
      implementation_consequence: 复用现有分支及状态验证
    - description: 队列取消依赖版本校验和幂等键
      affected_statements:
        - apps/bridge/src/session-runtime-api.ts:131
        - apps/bridge/src/session-runtime-api.ts:133
      implementation_consequence: 原生命令复用会话受理和并发边界
  architectural_patterns:
    - pattern: 现有命令事件投影
      example_location: packages/work-items/src/session-projector.ts:292
      usage_guidance: 按当前会话替换快照，保留来源与验证作用域
    - pattern: Runner 执行分流
      example_location: packages/runner-host/src/server.ts:950
      usage_guidance: 复用原生 ACP 或 Pi SDK
  files_to_modify:
    - file: packages/router/src/command-help.ts
      symbols:
        - COMMAND_HELP_GROUPS
      intended_change: 唯一稳定目录与别名描述
    - file: packages/router/src/slash-commands.ts
      symbols:
        - handleSlashCommand
      intended_change: 保留内建优先顺序，调用统一只读清单及执行能力
    - file: apps/bridge/src/session-api.ts
      symbols:
        - 会话 commands GET
      intended_change: 统一查询会话清单
    - file: apps/bridge/src/session-runtime-api.ts
      symbols:
        - registerSessionRuntimeCommandRoutes
      intended_change: 验证和接收原生命令请求
    - file: packages/work-items/src/session-projector.ts
      symbols:
        - projectCommands
      intended_change: 当前身份下的快照和失效
    - file: packages/runner-host/src/server.ts
      symbols:
        - RunnerHost.listCommands
        - RunnerHost.executeAcpRun
        - RunnerHost.executePiRun
      intended_change: 发现及协议执行分流
    - file: packages/backends/src/acp/acp-session-runner.ts
      symbols:
        - buildPromptBlocks
      intended_change: ACP 原生命令与普通上下文分支，消费完成证据
    - file: packages/backends/src/pi-session-runner.ts
      symbols:
        - listPiCommands
      intended_change: Pi 模板发现和 SDK 压缩结果
    - file: packages/channel-feishu/src/bridge.ts
      symbols:
        - dispatchToAgent
      intended_change: 真实用户输入识别与原话题回执
    - file: packages/channel-telegram/src/telegram-bridge.ts
      symbols:
        - 命令和消息入口
      intended_change: 独立通道授权与结果恢复
    - file: apps/web/src/components/workbench.tsx
      symbols:
        - submit
      intended_change: 实时命令清单和命令回执
    - file: apps/web/src/components/composer.tsx
      symbols:
        - Composer
      intended_change: 命令可用性与参数提示
    - file: scripts/acp-probe.mjs
      symbols:
        - runDialog
      intended_change: 复用握手，隔离发现模式拒绝任何权限请求
    - file: .github/workflows/ci.yml
      symbols:
        - verify
      intended_change: 候选版本命令合同验证
  tests:
    - file: packages/router/src/slash-commands.test.ts
      scenarios:
        - 内建碰撞仍走 Bridge
        - 非授权命令在提交前拒绝
    - file: packages/work-items/src/session-projector.test.ts
      scenarios:
        - 整份快照空列表撤回旧条目
        - 版本或作用域变化后旧快照失效
    - file: apps/bridge/src/session-api.test.ts
      scenarios:
        - 共享清单隔离
        - 发现失败不影响稳定命令
    - file: packages/channel-feishu/src/bridge-stream.test.ts
      scenarios:
        - 原生参数无前缀或后缀污染
        - 回执回到原话题
    - file: packages/channel-telegram/src/telegram-bridge.test.ts
      scenarios:
        - 独立权限与 topic 绑定
        - 重复投递复用结果
    - file: apps/web/src/components/composer.test.tsx
      scenarios:
        - 可用菜单刷新
        - Web 提交展示终态
  verification_commands:
    - pnpm test --no-file-parallelism packages/router/src/slash-commands.test.ts packages/work-items/src/session-projector.test.ts apps/bridge/src/session-api.test.ts
    - pnpm build
    - pnpm lint
    - pnpm secrets:check
    - git diff --check
  risks:
    - 共享路由波及多端
    - 原生发现与权限语义不同
    - 会话版本漂移或丢失终态
  assumptions:
    - 用隔离会话验证当前 ACP 适配器能提供可关联的完成证据
    - 用安装和握手验证 OpenCode 的命令与协议能力
  open_questions:
    - 候选发布检查具体挂点
    - 适配器上报无终态的命令是否有官方结果接口
  avoid:
    - 避免重做全仓探索，步骤执行前补具体符号影响检查
    - 保留现有群 ACL、审批、告警和队列语义
    - 避免原生命令绕开受信任原消息和会话绑定
    - 不通过探测批准权限请求或使用生产数据
    - 不自动重放状态未知的命令
```

## 12. 待验证事项

- [assumed] Codex 及 Claude 当前适配器能为成功压缩提供可关联的完成证据。通过隔离会话验证。不能证明时，仅标命令已发现，或继续寻找该适配器的官方结果接口。现有的“run 完成”事件不等同压缩完成。
- [assumed] 某些 Pi 扩展和 Claude 终端命令可能没有可跨通道投递的结果，也可能依赖交互。通过 SDK/适配器探测和结果测试区分。只有满足合同的命令才进入可执行清单。
- [verified] OpenCode 当前未安装。适配器版本和凭据未知，需按 CB-CMD-2 的可选 Agent 验收。默认安装或启用属于单独动作。
- [inferred] 先验证现有发布准备的检查挂点，再确定是否把探测结果加进既有 readiness。候选探测可以自动运行，生产发布仍走项目既有授权流程。

## 13. 完成标准

1. 四种 Agent 在安装并验收后，命令清单随会话和版本变化自动刷新，稳定命令、同名冲突和权限行为均可预测。未启用的 Agent 有准确提示。
2. Codex ACP 与 Pi SDK 的 `/compact` 在 Web、飞书和 Telegram 分别通过实际入口的合成用例，原文、会话绑定与真实完成证据可追踪。其他 Agent 只在同级验证通过后进入对应终态。
3. 已支持能力的删项、改名、禁用、超时、权限变化和终态丢失都能通过自动化检查识别、隔离或恢复。新增候选自动进入发现记录，人工只判断新权限或未知语义。
4. 此文档的范围覆盖清单、发现、防护与验收。实施或发布状态以各任务的实证与 release 记录为准。
