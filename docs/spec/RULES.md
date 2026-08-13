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
