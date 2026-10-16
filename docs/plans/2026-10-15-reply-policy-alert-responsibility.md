# 群聊回复与告警负责人

范围：飞书群聊全局/按群回复策略的 Web 配置、现有配置合同、实际消息入口；飞书告警的负责人通知配置。所有示例使用虚构身份。不修改运行实例配置，不发布或推送。

验收：自动回复接受普通消息；仅 @ 模式忽略普通消息和 @ 其他成员；直接回复机器人和已参与话题保留续聊；按群例外可查看、修改、移除并真正覆盖全局；停用的例外不再放宽回复。失败/blocked 原生 @ 当前负责人，waiting 原生 @ 当前审批人；负责人没有额外审批权限；旧配置及案件保持可读，负责人变更后既有未结案通知按当前配置投递；成功不 @。

| Surface | entry | read path | write path | event consumption | error handling | recovery | terminal feedback | planned 落点 |
|---|---|---|---|---|---|---|---|---|
| Web | reachable：Workbench→渠道/任务 | implemented：management快照 | implemented：带版本校验保存 | implemented：保存响应回读 | implemented：错误保留草稿 | implemented：重新读取/原备份 | implemented：保存提示 | RP-1：配置与表单测试、浏览器模拟闭环 |
| Agent | reachable：既有告警调查与fcb alert status | implemented：审批上下文 | implemented：既有Run绑定状态API | implemented：监控器消费状态 | implemented：失败状态与重试 | implemented：持久化案件 | implemented：状态返回 | RP-2：合同及真实适配器模拟，角色不混用 |
| 飞书 | reachable：FeishuBridge入站与告警轮询 | implemented：热更新配置 | implemented：回复/状态原生@ | implemented：消息及状态通知 | implemented：发送失败可重试 | implemented：重启读取案件 | implemented：原话题通知 | RP-3：实际适配器模拟；真实群验收留待部署 |
| Telegram | reachable：原入站/推送 | implemented：独立渠道配置 | implemented：原合同保持 | implemented：原更新路径 | implemented：原错误处理 | implemented：原恢复逻辑 | implemented：原反馈 | RP-4：既有回归；本需求飞书负责人不扩展为Telegram告警 |

验证顺序：新增回归先失败；修复后合同+活跃表面；全量测试、类型/lint、构建；桌面/手机及双主题模拟页面；隐私扫描、安装包烟测、GitNexus变更门禁。所有测试均不接模型或真实消息服务。

## 本地候选验证结果

- 新增回归在修复前失败：停用例外仍放开自动回复、例外未进入管理合同、独立负责人不存在、活跃话题中 @ 其他成员被当成续聊，以及未 @ 的附件在策略检查前发出错误提示。修复后均通过。
- `pnpm test`：157 个测试文件、1457 项通过。`pnpm build` 通过；`pnpm lint`：0 error，7 条原有 warning。
- Web 浏览器从实际 Workbench 入口打开渠道/任务，覆盖 1440×1000、390×844 与 Paper/Carbon 两个主题。全局模式切换、例外添加/移除、成员选择、保存后回读通过；4 组各 4 次配置写入均被浏览器拦截为虚构数据，page error、未处理 API、控件横向溢出均为 0。
- `FeishuBridge` 活跃适配器验证普通消息、仅 @、@ 其他成员、直接回复机器人、任务中断自动通知；SDK 发送全部模拟，未连接真实飞书。
- 负责人只影响 blocked（失败、排查受阻）的通知，waiting（需要操作批准）继续通知审批人；成功不 @。负责人变更用于既有案件，审批身份保持独立。旧配置和旧通知去重标记保持兼容，不批量重写案件。
- `GITLEAKS_BIN=<official-binary> pnpm secrets:check`：Git 历史和当前目录均无密钥发现。旧测试中的个人姓名已改为虚构成员；没有新增真实群、成员或业务 Skill。Git 历史中的既有个人内容不在本轮改写范围。

### 交付表面状态

| Surface | entry/read/write | events/errors/recovery | terminal feedback | 状态与后续 |
|---|---|---|---|---|
| Web | Workbench 挂载真实管理页；快照→草稿→版本检查保存→回读 | 冲突保留草稿；原恢复路径回归 | 保存提示与新配置值 | closed-loop（浏览器隔离验证），RP-1 完成 |
| Agent | 既有告警任务与 Run 绑定的状态接口 | 状态由后端通知；负责人不能审批 | 状态接口结果、告警原话题通知 | closed-loop（合同及适配器模拟），RP-2 完成；没有新增 Agent 配置命令 |
| 飞书 | 实际入站、群策略解析、告警轮询和通知适配器 | 当前负责人读取、发送重试、旧案件及旧去重兼容 | 原话题原生 @ 与状态 | closed-loop（SDK 模拟），RP-3 本地完成；真实群验收需后续授权部署 |
| Telegram | 原渠道独立访问设置及对话路径 | 本轮全量回归通过 | 原通知与对话反馈保持 | reachable（既有能力），RP-4 完成；未新增 Telegram 告警采集或本轮飞书回复策略 |

本轮不改真实实例配置、不迁移案件、不修改业务 Skill、不推送、不发布。

附件处理沿用原实现，顺序调整为访问/群聊策略通过后才下载和反馈；回归同时验证仅 @ 时不下载、不回复，以及自动回复时继续处理附件。原附件内容测试改为从活跃入站经过真实策略与媒体处理，仅截获最终 Agent 提交，不删除原断言。

冻结候选已复验：`pnpm test` 157 个文件、1457 项通过；`pnpm build` 通过；`pnpm lint` 0 error / 7 条既有 warning。代码索引 runner identity 为 current，incompleteReasons 为空，完整变更检查无 partial/truncated/error。受影响的共用消息、管理和告警投递流程已逐项检查。分发包共454个文件，飞书与管理 API 构建模块与当前构建字节一致；当前源文件和包内个人路径、公司域名及已识别个人姓名的匹配数均为0。

最终冻结分发包 `pnpm test:package` 通过：在全新临时目录安装，CLI/init、内部模块导入、认证 Runner、管理 API 读写与 Workbench 静态资源全部通过；不使用真实服务凭据、不发现本机真实 Agent、不发送任务。测试进程和临时目录自动清理，浏览器专用 Vite 已关闭。此前冻结构建后的全量测试为157个文件、1457项通过。真实部署和群内验收仍未执行。

## 名称选择与自动发现（DP-1，后续本地改进）

目标：告警常用路径为选择已连接渠道、按群名选群、按姓名选负责人；页面自动加载目录、成员和近期机器人来源，默认生成任务名。保留现有审批与消息访问范围，不把负责人自动变成审批人，不改变已有案件或运行实例。

复用飞书官方 SDK chat.list、chatMembers.get、message.list；只读取机器人所在、且符合当前允许范围的群。群成员接口不返回机器人，告警来源从近期机器人消息识别，展示最近消息供辨认，不能把卡片标题伪称为机器人名称。来源唯一时自动选中，多来源需要用户明确选择。配置 ID、规则路径、名称覆盖与审批设置归入高级配置；已有值不丢失，读取失败保留草稿与明确重试入口。当前采集器仅支持飞书，Telegram 在渠道选项明确标为未支持，不制造可保存的空壳。

| Surface | entry | read path | write path | event consumption | error handling | recovery | terminal feedback | planned 落点 |
|---|---|---|---|---|---|---|---|---|
| Web | reachable：Workbench→任务→告警 | planned：DP-1 按名加载群、成员、来源 | implemented：原带版本管理 API | planned：DP-1 切群联动且忽略旧请求 | planned：DP-1 独立错误、缺权限、空目录 | planned：DP-1 刷新、保留旧身份和草稿 | planned：DP-1 保存回读与名称显示 | DP-1：合同、组件、桌面/手机浏览器隔离验证 |
| Agent | reachable：现有告警调查与状态命令 | implemented：现有运行配置与 Skill | implemented：原 Run 绑定接口 | implemented：原通知投递 | implemented：原错误处理 | implemented：既有案件 | implemented：原话题终态 | DP-1：原角色与状态回归，无新 Agent 配置命令 |
| 飞书 | reachable：活跃 FeishuBridge | planned：DP-1 官方分页群名、成员、近期来源 | implemented：原配置保存和热更新 | implemented：原消息与告警轮询 | planned：DP-1 分页不全和权限错误明确返回 | implemented：原状态与通知去重 | implemented：现有原生 @ | DP-1：模拟 SDK；不对真实群发消息 |
| Telegram | reachable：原独立通道 | implemented：原配置 | implemented：原合同不变 | implemented：原消息路径 | planned：DP-1 UI 明确不支持告警采集 | implemented：原恢复 | implemented：原反馈 | DP-1：独立回归，不新增采集器 |

验收：新建告警不手填群或成员 ID；已有告警打开后能看到群名和已选姓名；只有一个有效候选时自动填充；切群后旧请求不能覆盖新群数据；成员缺权限、来源无消息、群不在允许范围等给出可恢复提示，不自动放宽权限；高级设置保留现有能力；仅选负责人不会新增审批授权。所有真实名字只来自私有运行时响应，不进入仓库或发布示例。

### DP-1 本地实现与验证完成

- 后端：管理接口提供按名群目录与近期来源，官方 SDK 分页读取群、成员；原 CLI 实际挂载查询回调。群目录应用已有访问名单的交集，保存不修改原访问范围；不支持的告警渠道明确拒绝。
- Web：新增告警使用独立编辑视图，默认不暴露 ID 与规则路径；自动读取群名/姓名、单一候选、来源与默认任务名。同名成员按身份尾号区分。保存仍走原配置文件与版本冲突校验；负责人和审批人独立。
- 验证：新增场景在旧实现上8项失败；最终 `pnpm test` 157个文件、1469项通过，`pnpm build` 通过，`pnpm lint` 0 error / 7条原有 warning。成员与来源乱序响应、读取失败保留、同名成员、切群清除旧规则入口均有回归。
- 浏览器：实际 Workbench 入口、1440×1000与390×844、Paper/Carbon两主题，两轮检查。每组验证已有告警改负责人、权限失败后刷新恢复、新建自动选群/来源/命名与保存回读，共2次配置保存；页面错误、未处理接口、横向溢出均为0。所有 API 均在浏览器内拦截为虚构群和成员，不访问真实服务。

| Surface | entry/read/write | event consumption | error handling / recovery | terminal feedback | 状态 |
|---|---|---|---|---|---|
| Web | Workbench→任务→告警→目录/成员/来源查询→配置保存→回读 | 切群联动，过期请求忽略，保存后渲染名称 | 分项错误、保留原身份和草稿、刷新恢复 | 保存提示与名称、已选成员 | closed-loop（浏览器隔离验证），DP-1完成 |
| Agent | 原告警调查与Run绑定状态接口 | 原后端采集和通知机制 | 原失败、审批与状态重试回归 | 原话题终态 | reachable（原能力回归），不新增 Agent 配置命令 |
| 飞书 | CLI实际挂载→真实适配器方法→官方SDK合同；原配置热更新 | 原轮询、状态、原生@保持 | 分页不完整明确报错，读取权限错误不会自动授权 | 名称与查询结果供Web使用，原告警反馈保持 | closed-loop（模拟SDK），真实群需更新实例后验收 |
| Telegram | 原独立渠道保持；告警选项明确不支持 | 原消息机制 | 原回归通过；伪造告警渠道写入被拒绝 | 原反馈保持 | reachable（既有能力）；不声称支持本轮告警采集 |

当前代码、测试与文档只含虚构示例，真实群和姓名仅从用户实例的私有运行时读取。没有修改真实配置、业务 Skill、真实群、生产服务或定时任务，也没有推送或发布。

DP-1 最终分发包 `pnpm test:package` 通过：全新临时目录安装、CLI/init、内部模块导入、认证 Runner、管理 API 读写与 Workbench 资源通过。当前源码与454个包文件的已识别个人路径、公司域名和个人姓名匹配均为0；实际Gitleaks扫描Git历史与当前目录未发现密钥。仅本地候选，未上传、发布或更新实例。

DP-1 接口范围复核：补充了绕过页面直接请求成员/来源的回归，在修复前返回200而失败，修复后两条请求均为403且不调用SDK读取。两份既有允许群名单在接口侧也取交集；未修改名单。冻结候选再次 `pnpm test` 157个文件、1469项通过，完整构建通过，lint仍为0 error / 7条原有warning。
