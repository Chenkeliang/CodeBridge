# 渠道与任务管理

状态：本地候选已实现并完成隔离验证；未推送、合并、发布或切换运行配置。

## 范围与实现

工作台只增加“渠道”“任务”两个入口，沿用当前本机网页访问方式和既有视觉系统。渠道集中维护访问范围与管理身份；任务合并已有本地计划、推送及飞书告警。凭据更换仍使用初始化向导，发布者签发/吊销仍使用原 CLI。支持边界见[使用说明](../zh-CN/channel-automation-roadmap.md)。

安全存储前置复用已有候选，本地重放提交为 `c830331`；它与管理功能均不代表已发布。通用代码、测试与文档不包含实际群、成员、凭据、任务配置或业务 Skill。

- 本地计划接入原 macOS launchd，不引入新调度器；保留原参数、环境与未知字段，运行中不强杀、不重排。接入不执行，启停和运行均需明确点击。计划保存会重载空闲任务，原 `RunAtLoad` 可能触发执行，页面明确提示。
- 飞书、Telegram 继续消费同一 ConfigStore；新管理请求检查认证、来源与版本。配置原子落盘，失败回滚内存配置与密钥来源；并发旧版本写入返回冲突。
- 告警保留原状态文件、游标和包外业务 Skill；当前群审批人用于旧案件的新审批判断。停用新采集仍保留旧案件状态投递、DONE 补查和对话处理。
- 规则编辑跟随实际 Skill 包和所选群引用目录；入口64KB、文件256KB，支持修复已有格式问题。脚本不通过这个编辑器改写。文件版本校验与 AES-256-GCM 私有备份保护原文件，密钥在系统钥匙串；备份可解密恢复已在模拟密钥测试中验证，尚无一键恢复界面。
- 飞书 SDK 和 Markdown 解析器均为显式公共依赖，不依赖维护者的飞书 CLI、私有服务或业务规则。

## 验证证据

所有功能测试使用临时目录、模拟 SDK/launchctl/钥匙串，不发送真实消息、不执行真实计划、不调用模型。分发包检查另启动临时数据目录下的独立 Bridge/Runner，完成后关闭并清理该目录。

| 检查 | 结果 |
| --- | --- |
| `pnpm build` | 通过 |
| `pnpm test` | 155个测试文件、1443条测试通过 |
| `pnpm exec tsc -p apps/web/tsconfig.json --noEmit` | 通过 |
| `pnpm lint` | 0错误、7条原有警告；新增管理页面无警告 |
| `pnpm install --frozen-lockfile --offline` | 锁文件一致；不改依赖版本 |
| `node scripts/package-release.mjs`；`pnpm test:package` | 临时项目独立安装通过；CLI/init、内部模块、认证Runner、实际管理接口鉴权/保存、Web资源通过 |
| 独立浏览器：1365×900、390×844 | 实际工作台入口、渠道/任务/计划/规则页面；保存冲突保留草稿，无横向溢出、无浏览器异常 |
| Impeccable静态检测 | 新管理页与导航无发现 |
| 公共文档 | 24个变更文件、96个链接、9段YAML、28段Shell及完整配置Schema检查通过 |
| `pnpm secrets:check` | Git历史及工作目录脱敏扫描未发现泄漏；个人/公司路径及真实身份模式检查无命中 |
| 当前Skill布局只读兼容检查 | 两个现有规则包均能识别入口和所选群引用目录，未修改内容 |

回归用例同时验证：旧审批人撤权、全局暂停后只启用选定群、原案件及规则不丢失、运行中保护、计划参数/环境保留、备份解密、规则冲突/失败保留和重试反馈。DONE补查回归先在修复前失败，修复后通过；配置持久化失败回归也在原实现上失败。

## Surface Matrix

`reachable`说明已核查当前候选的实际调用/渲染入口；`closed-loop`在本轮仅限隔离环境。没有对真实账号、模型或生产实例作闭环声明。

| Surface | entry | read path | write path | event consumption | error handling | recovery | terminal feedback | planned落点 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Web | reachable：AgentRail→Workbench→ManagementPage，浏览器实际打开 | closed-loop：管理API与Skill文件读取 | closed-loop：配置、计划、规则的API/组件测试；安装包实际配置保存 | implemented：保存后重新读取后端结果；原Run事件不变 | closed-loop：冲突/失败提示，草稿保留 | implemented：文件版本、私有备份；修复规则后重试；备份路径可见 | closed-loop：保存、启停、提交运行分别反馈 | MG-LIVE：真实实例验收；一键备份恢复未纳入首版 |
| Agent | reachable：原任务入口和Run执行链未更换 | implemented：仍读取原Skill与配置 | implemented：保留原工具许可与业务确认 | implemented：原Run/Delivery事件 | implemented：原失败/中断语义；全量回归通过 | implemented：原取消与会话恢复，未新增调度器 | implemented：原结果投递；未调用真实模型 | MG-LIVE：切换后的真实模型/工具验收 |
| 飞书 | reachable：FeishuBridge与AlertMonitor原入口 | closed-loop：模拟官方SDK分页；当前ConfigStore、原Skill与案件 | closed-loop：旧案件审批撤权；保留原审批、状态投递 | closed-loop：既有消息/表情测试与停用后DONE补查回归 | closed-loop：身份/分页/规则错误不自动扩大权限 | implemented：原案件/游标不改写，断线补查继续 | closed-loop：既有话题/状态测试；真实群待验收 | MG-LIVE：专用测试群逐项验证 |
| Telegram | reachable：TelegramBridge原入站与发布入口 | implemented：保存后由ConfigStore通知更新本渠道配置 | closed-loop：模拟群管理员约束与普通帮助；原发送边界回归 | implemented：原消息与Run路径，全量回归通过 | closed-loop：非管理员配置命令明确拒绝 | implemented：原恢复路径；未实现Telegram告警采集 | implemented：原聊天结果与投递；未试发真实消息 | MG-LIVE：当前机器人白名单与真实发送验收 |

## 影响与限制

GitNexus完整变更门禁保留其原始风险结论，不将关键基础代码判为“低风险”。共享配置持久化和工作台导航是需要关注的影响点；前者通过失败回滚、密钥引用与全量回归验证，后者核对生产调用方为Workbench，另有显式DesignPreview复用。

代码图的进程枚举报告预算截断，部分接收者和跨语言字段无法解析；检测输出还把AgentRail关联到后端Runner等无直接源码导入的流程。已用实际import/caller、CLI挂载、ConfigStore订阅及独立分发包路径补充核查。图中没有某条流程不能证明它不存在，也不据此声称生产已验证。

真实业务配置、定时计划和Skill均未迁移。没有新增任意命令编辑器、Agent定时任务设计器、统一历史中心、跨渠道身份合并或远程多用户权限系统。实际发布与单实例接入归属MG-LIVE，需具体目标和切换授权。

## 整体界面与开源审查追加

范围：保持现有主题和两个管理入口，改善手机会话切换、导航触达、页面层级、设置分组、语义对比度与键盘焦点。真实任务、配置、Skill和已运行服务不变。现有功能分支的两个提交均属于本次产品化，可在同一检出继续。

开源检查覆盖当前跟踪文件与待提交差异；替换文档/测试中的作者绝对路径、公司域名和特定任务别名，保留公开项目链接及许可证归属。历史提交含旧示例，未授权改写Git历史。本地与业务运行数据不能被作为示例导入仓库。

| Surface | entry | read path | write path | event consumption | error handling | recovery | terminal feedback | planned落点 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Web | closed-loop（隔离）：手机会话列表可打开/关闭；统一导航和页面层级 | implemented：原API与会话投影 | implemented：原接口与版本检查，不增加业务写入 | implemented：原会话事件 | closed-loop（隔离）：移动布局、焦点与错误可读性 | closed-loop（隔离）：选择会话、关闭或Esc回到对话 | implemented：同一页的加载/空态/保存状态 | UI-POLISH：本轮 |
| Agent | reachable：原执行入口 | implemented：原配置/Skill | implemented：原授权边界 | implemented：原Run事件 | implemented：既有失败语义 | implemented：既有恢复 | implemented：原投递 | UI-POLISH：回归，真实模型未调用 |
| 飞书 | reachable：原聊天和告警入口 | implemented：原配置与案件 | implemented：原审批/投递 | implemented：原消息/表情 | implemented：原错误处理 | implemented：原案件与游标 | implemented：原消息回复 | UI-POLISH：回归；真实群仍待MG-LIVE |
| Telegram | reachable：原聊天入口 | implemented：原白名单配置 | implemented：原发送接口 | implemented：原消息/Run | implemented：原拒绝反馈 | implemented：原恢复 | implemented：原回复 | UI-POLISH：回归；真实机器人仍待MG-LIVE |

剩余产品化：默认启动仍注册演示能力；新建Agent定时任务、完整执行/投递历史、备份恢复和统一升级入口尚未完成；Codex联网适配器仍需独立交付；真实实例切换及逐渠道验收未执行。它们需按实际需求另定实施范围，不扩展为新的管理中心或流程设计器。

追加验证结果：全量157个测试文件、1447条测试通过；完整构建通过，静态检查0错误、7条既有警告。Chromium独立浏览器检查1440×1000、390×844、820×1000及明暗主题；所有API拦截为虚拟数据，无页面异常或表单横向溢出。手机Skill两个筛选框定点验证宽度均为145px。设计检测无主问题，唯一提醒为本轮未修改的既有chip-pop缓动。新增隐私门禁测试验证运行文件和个人目录路径在扫描前被拒绝；历史与工作区秘密扫描均通过。本地分发包454个文件未命中已识别的个人化模式。真实配置、任务、业务Skill和运行服务未变，未推送或部署；旧Git历史仍需单独处理，不能把当前文件匿名化当作历史已清除。
