# 规则注册表

规则格式:`ID | level | enforcement | 规则`。出处列见规范体系 README 的域映射。

## FE — 前端

| ID | Level | Enforcement | 规则 |
| --- | --- | --- | --- |
| FE-TOKEN-001 | MUST | test:design-tokens | 颜色与阴影只在 `index.css` 的 `--agnet-*` 变量中定义;组件禁止出现 hex 与调色板类名(zinc/slate/red…) |
| FE-TOKEN-002 | MUST | test:design-tokens | Paper 与 Carbon 定义完全相同的 token 集合 |
| FE-TOKEN-003 | MUST | test:design-tokens | index.css token 值与 DESIGN.md §3.2/§3.3 表格逐一致 |
| FE-TOKEN-004 | MUST | test:design-tokens | 文字 token 在所有 surface 上满足 WCAG AA(≥4.5);状态色 ≥3.0;accent 上的文字 ≥4.5 |
| FE-TOKEN-005 | MUST | test:workbench-component-policy | 主题经根节点 `data-theme` 切换;组件间不传递 theme prop 改色(Mermaid 等 JS 渲染例外,自订阅 documentElement) |
| FE-COMP-001 | MUST | test:workbench-component-policy | 下拉一律使用 shadcn Select 原语,禁止原生 `<select>` |
| FE-COMP-002 | MUST | test:workbench-component-policy | `/` 与 `@` 弹层渲染在输入区之外(绝对定位于 Composer 上方),不挤压输入框 |
| FE-COMP-003 | MUST | test:workbench-component-policy | 思考/进度与最终回答分离渲染;Work 默认折叠、可展开 |
| FE-COMP-004 | MUST | review | 品牌像素标记(PixelMark)与 `public/brand/*.svg` 保持同一图形 |
| FE-MOTION-001 | MUST | review | 动效只用 opacity/transform;唯一例外是审批卡的 stroke-dashoffset 走线(DESIGN.md §8) |
| FE-MOTION-002 | MUST | review | 尊重 `prefers-reduced-motion`:主题切换与装饰动画降级为瞬时 |
| FE-A11Y-001 | MUST | review | 交互目标 ≥32px;按钮具备可读 aria-label;装饰 SVG 用 aria-hidden |
| FE-A11Y-002 | SHOULD | review | 键盘可完成 Agent/Session 切换、新建、发送、审批、关闭菜单 |
| FE-STATE-001 | MUST | test:workbench-component-policy | 切换 Session 立即取消旧 SSE;恢复顺序 History → Commands → Config → Live Events |
| FE-STATE-002 | MUST | test:workbench-component-policy | 发送消息前先投影用户消息;不等 Run 创建 |
| FE-STATE-003 | MUST | test:workbench-component-policy | 对话自动滚动仅在贴底时跟随,并提供回到最新入口 |
| FE-I18N-001 | SHOULD | review | 界面文案统一中文;技术名词(Session/Flow/Run/Agent)保留英文 |
| FE-TYPE-001 | MUST | test:workbench-component-policy | 字体只经 `--font-brand` / `--font-mono` token;页面级标题(面板头、设置页等)统一 `font-brand text-lg tracking-[-0.035em]` |
| FE-TYPE-002 | MUST | review | `font-brand` 的 CJK 回退直接到系统黑体,不经等宽字体(token 内已内建);拉丁像素字形只用于品牌字标与标题,不用于正文 |
| FE-TYPE-003 | MUST | test:workbench-component-policy | 眉标统一 `font-brand text-xs font-normal uppercase tracking-[0.1em]`;卡片头统一 `text-xs font-semibold`;禁止第三套变体 |

## ARCH — 后端架构

| ID | Level | Enforcement | 规则 |
| --- | --- | --- | --- |
| ARCH-001 | MUST | review | Bridge 与 Runner 分离:Bridge 可远程、无特权;Runner 贴着 CLI/文件/凭据 |
| ARCH-002 | MUST | review | Control Plane 各 Catalog(Agent/Session/Capability/Flow)只经事件互联,不直连成网 |
| ARCH-003 | MUST | review | Event Store 是事实来源;UI 与恢复只消费投影,不读原始事件瀑布 |
| ARCH-004 | MUST | review | 凭据与 models.json 等本机配置只由 Runner 读写;Bridge 代理但永不持久化 |

## PROTO — 协议与契约

| ID | Level | Enforcement | 规则 |
| --- | --- | --- | --- |
| PROTO-ACP-001 | MUST | review | Agent 接入优先级:原生 SDK > ACP > headless CLI;禁止 PTY 终端包装 |
| PROTO-ACP-002 | MUST | review | Web 不枚举厂商固定值;模型/权限/命令全部来自 adapter 动态上报 |
| PROTO-CAP-001 | MUST | test:pi-providers | Capability 命名 `<domain>.<action>` 小写蛇形;域为白名单;厂商/系统名不得作域 |
| PROTO-CAP-002 | MUST | review | 能力注册必须带 manifest(input/output JSON Schema、风险、幂等键派生、可重试错误类) |
| PROTO-CAP-003 | MUST | review | side_effects 为 true 的 adapter 必须实现 dry-run 分支 |
| PROTO-CAP-004 | MUST | review | Flow 引用未注册能力 = 校验失败;禁止隐式注册 |
| PROTO-FLOW-001 | MUST | review | 只有 published Flow 可真实执行;candidate 仅 dry-run;deprecated 拒绝新 Run |
| PROTO-FLOW-002 | MUST | review | Run 保存 resolved inputs 快照(值 + 来源 + resolver 版本);审批 token 绑定参数 hash |
| PROTO-PROV-001 | MUST | test:pi-providers | models.json 写入前校验(id 格式、URL、模型 id 唯一、reasoning 必有档位),留 `.bak`,原子替换 |
| PROTO-PROV-002 | MUST | review | Pi 控件按所选模型能力生成:reasoning=false 不上报思考等级;有 thinkingLevelMap 只报映射档 |
| PROTO-PROMPT-001 | MUST | review | 提示词前缀只含不可变内容;时间戳/统计/相对时间等易变内容禁止进前缀(prompt-stability.md §2.1) |
| PROTO-PROMPT-002 | MUST | review | 可变内容只追加不重排;厚重不变内容(Flow 定义、能力 manifest)走工具懒加载,不内联进提示词 |
| PROTO-PROMPT-003 | MUST | review | prompt 由版本化模板确定性渲染;模板 revision 记入事件;禁止散落字符串拼接 |
| PROTO-PROMPT-004 | MUST | review | 改注入逻辑前必须调研官方文档+高星参考实现并记录依据;改动须附前后缓存命中率对比(prompt-stability.md §3/§4) |
| PROTO-FLOW-INPUT-001 | MUST | test:workflow-engine | Flow inputs 为 typed 对象(id/type/source 必填;pattern/values/confirmation/from 按类型);旧 `string[]` 简写归一为 `{type: string, source: user}` |
| PROTO-FLOW-REVISION-001 | MUST | test:flow-api | definitionRevision = RFC 8785 规范化定义的 sha256;plan_ir_hash = 规范化 PlanIR 的 sha256;编译时双双落库;运行时永不重解析 YAML;`/v1/flows/candidates` 忽略调用方 definition_revision |
| PROTO-FLOW-ATTR-001 | MUST | review | RUN_SNAPSHOT 携带归因块(flow_revision=plan_ir_hash、prompt_revision、tool_schema_revision、capability_revisions、resolver_revision、authorization_revision);capability_version 由注册方自报(区别于 CapabilitySource.version 的 adapter 端点版本) |
| PROTO-FLOW-SIGNAL-001 | MUST | test:work-items | 学习信号事件(PARAM_RESOLVED/FLOW_RECOMMENDED/FLOW_REJECTED/VERIFICATION_FAILED/RUN_SNAPSHOT)payload 定强类型;FLOW_REJECTED.reason 为枚举;VERIFICATION_FAILED.actual ≤4KB 截断带 truncated 标志;RUN_SNAPSHOT.output_ref 必须是 artifact:// 引用 |
| PROTO-FLOW-HASH-001 | MUST | test:workflow-engine | 规范化规则写死:结构化内容走 RFC 8785 风格 JCS,sha256;prompt 模板走原文字节 sha256;禁止其他规范化方式 |

## SEC — 安全

| ID | Level | Enforcement | 规则 |
| --- | --- | --- | --- |
| SEC-001 | MUST | review | 附件、目录必须经系统选择器或浏览器授权,禁止手填本地绝对路径 |
| SEC-002 | MUST | review | 生产写默认审批;审批 token 绑定 flow_revision+step+参数+能力 revision |
| SEC-003 | MUST | review | 日志与事件不得打印 API key 明文 |

## OPS — 流程

| ID | Level | Enforcement | 规则 |
| --- | --- | --- | --- |
| OPS-001 | SHOULD | script:design-qa.mjs | UI 变更后运行 `pnpm design:qa` 更新基线截图并人工对比 |
| OPS-002 | MUST | review | 规则变更顺序:RULES.md → 背景文档 → 实现 |
| OPS-003 | MUST | review | PR 合并前:`pnpm lint`、`pnpm test`、`pnpm build` 全绿 |
