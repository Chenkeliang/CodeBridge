# AGNET Design System

- Version: `1.0.0`
- Status: `Implementation baseline`
- Updated: `2026-08-11`
- Product: Multi-agent conversation workbench
- Themes: `Paper Lime` / `Carbon Vermilion`
- Reference viewport: `1440 × 900`
- Design controls: `DESIGN_VARIANCE 3` / `MOTION_INTENSITY 4` / `VISUAL_DENSITY 6`

本文档是 CodeBridge Web 工作台的视觉与交互单一事实源。它覆盖 Agent 管理、多个 Session、Flow、对话、工具调用、审批、代码与 Diff、输入器以及双主题。

实现优先级为：

```text
DESIGN.md → Semantic Tokens → shadcn Base Components → Feature Components → Page Composition
```

任何实现与本文档冲突时，先修改 Token 或组件规范；禁止在页面层继续添加硬编码尺寸来“看起来差不多”。

## 1. 产品目标

AGNET 是面向开发者的多 Agent 对话工作台。用户可以在 Pi、Codex、Cursor、Claude Code、OpenCode 和后续注册的 Agent 之间切换，并为每个 Agent 管理多个独立 Session。

核心任务顺序：

1. 看清当前 Agent、运行状态和 Session 数量。
2. 快速切换 Agent，并保留每个 Agent 上次打开的 Session。
3. 在当前 Agent 下新建、搜索和切换多个 Session。
4. 阅读 Agent 输出、计划、工具调用、代码和 Diff。
5. 处理需要审批、失败、离线等阻塞状态。
6. 持续输入下一条指令，不因切换 Agent 或 Session 丢失上下文。

### 1.1 设计原则

#### 精炼，不空洞

简洁来自明确的信息优先级，而不是减少必要信息。Agent、Session、状态、时间和阻塞原因必须一次扫视可见。

#### 精致来自几何秩序

所有精致度由统一网格、固定列、字重、圆角关系、图标光学尺寸和交互反馈建立。禁止依赖大面积渐变、发光、玻璃拟态或装饰性背景制造高级感。

#### 双主题同构

白色与黑色主题只替换颜色、阴影和局部对比度，不改变布局、尺寸、组件位置或信息层级。主题切换不能导致元素跳动。

#### Agent 与 Session 是两级对象

Agent 是一级切换对象；Session 是当前 Agent 下的二级对象。界面不能把 Agent 和 Session 混成同一列表，也不能让用户误以为切换 Agent 会删除当前 Session。

#### 状态不只靠颜色

Running、Needs approval、Offline、Failed 必须同时由文字以及圆点或图标表达。任何状态都不能只靠颜色区分。

#### 运行时决定能力

页面不写死业务、模型、命令、Skill、MCP 或 Flow。界面只渲染 Registry、Session API、Flow Catalog 和 Event Stream 返回的能力与状态。

## 2. 视觉基调

| Theme | 主色 | 气质 | 使用环境 |
| --- | --- | --- | --- |
| `Paper Lime` | 白 + 荧光绿 `#CCFF00` | 清晰、轻盈、精确 | 明亮环境、日间工作 |
| `Carbon Vermilion` | 碳黑 + 赤金 `#FF683D` | 沉稳、专注、技术感 | 暗光环境、长时间编码 |

### 2.1 明确禁止

- 不使用纯黑 `#000000`。
- 不使用紫蓝色 AI 渐变。
- 不使用外发光、霓虹阴影或彩色光晕。
- 不使用大面积渐变文字。
- 不使用全局玻璃拟态。
- 不使用圆角过大的玩具感胶囊容器。
- 不使用 Emoji 代替图标。
- 不用字母方块伪造 Agent Logo；已知 Agent 使用对应品牌图形，未知 Agent 使用统一通用图标。
- 不使用默认 shadcn/ui 外观；基础组件必须应用本规范语义 Token。
- 不用单独卡片包裹每一条普通信息；优先使用留白与分割线分组。
- 不在空状态展示虚构 Session、Flow、工具或业务示例。

## 3. Design Tokens

### 3.1 实现约束

- Token 名称使用 `agnet.{role}`，页面只消费语义角色。
- 颜色、阴影、尺寸通过 TypeScript Token/Class Map 和 Tailwind Utility 实现。
- `src/index.css` 只保留 Tailwind 框架入口；不新增 CSS Selector、CSS Module、styled-components 或内联 `style`。
- 组件内部禁止直接写原始颜色；阴影透明度除外。
- 数值尺寸必须来自本节的间距、圆角、字号或组件尺寸。

### 3.2 Paper Lime

| Token | Value | Use |
| --- | --- | --- |
| `agnet.canvas` | `#F6F7F4` | 应用画布 |
| `agnet.sidebar` | `#FBFCFA` | 左侧导航 |
| `agnet.surface` | `#FFFFFF` | 对话区、浮层和面板 |
| `agnet.surfaceSoft` | `#EEF1EB` | 次级控件 |
| `agnet.surfaceTint` | `#F2F4EF` | 代码、Diff 和分组底色 |
| `agnet.ink` | `#191C16` | 一级文字 |
| `agnet.inkSoft` | `#373C32` | 正文 |
| `agnet.muted` | `#73796C` | 次级文字 |
| `agnet.faint` | `#9CA296` | 辅助信息 |
| `agnet.line` | `#E0E4DC` | 普通边线 |
| `agnet.lineStrong` | `#CDD3C8` | 强调边线 |
| `agnet.accent` | `#CCFF00` | 主动作和活动标识 |
| `agnet.accentSoft` | `#E9F6AD` | 用户消息和轻强调 |
| `agnet.success` | `#3B8659` | 成功 |
| `agnet.warning` | `#C27B18` | 等待和审批 |
| `agnet.danger` | `#D25D3D` | 失败和删除 |

### 3.3 Carbon Vermilion

| Token | Value | Use |
| --- | --- | --- |
| `agnet.canvas` | `#121411` | 应用画布 |
| `agnet.sidebar` | `#181A17` | 左侧导航 |
| `agnet.surface` | `#1C1F1B` | 对话区、浮层和面板 |
| `agnet.surfaceSoft` | `#282C25` | 次级控件 |
| `agnet.surfaceTint` | `#20231E` | 代码、Diff 和分组底色 |
| `agnet.ink` | `#F1F2EA` | 一级文字 |
| `agnet.inkSoft` | `#D2D6C9` | 正文 |
| `agnet.muted` | `#9DA496` | 次级文字 |
| `agnet.faint` | `#6E7669` | 辅助信息 |
| `agnet.line` | `#30352D` | 普通边线 |
| `agnet.lineStrong` | `#444B40` | 强调边线 |
| `agnet.accent` | `#FF683D` | 主动作和活动标识 |
| `agnet.accentSoft` | `#4B281F` | 用户消息和轻强调 |
| `agnet.success` | `#74BF8F` | 成功 |
| `agnet.warning` | `#E7AA4E` | 等待和审批 |
| `agnet.danger` | `#FF8063` | 失败和删除 |

### 3.4 几何 Token

| Role | Value |
| --- | --- |
| Agent Rail | `60px` |
| Session Panel | `286px` |
| Header | `72px` |
| Conversation max width | `880px` |
| Agent target | `42px` |
| Agent brand icon | `18px` |
| Compact icon target | `36px` |
| Input radius | `12px` |
| Panel radius | `8px` |
| Control radius | `6px` |
| Body font | `13px` |
| Conversation font | `14px / 28px` |
| Metadata font | `10–11px` |

间距使用 `4px` 基础网格。常用间距为 `4 / 8 / 12 / 16 / 20 / 24 / 32`，禁止为单个页面引入没有语义的近似值。

### 3.5 字体与文字层级

字体策略参考 [Pi](https://pi.dev/) 对“内容字体”和“机器信息字体”的角色区分，但不复制其字体文件。Pi 官网使用 Plantin 系列承载编辑性正文、Departure Mono / Commit Mono 承载导航和技术标签；AGNET 是高密度开发工作台，核心界面继续使用系统无衬线字体，命令、路径和代码使用等宽字体。未经明确授权，不将第三方商业字体打包进产品。

| Role | Typography | Tailwind baseline | Use |
| --- | --- | --- | --- |
| Page title | `16px / 24px`, `600`, `-0.01em` | `text-base font-semibold tracking-tight` | 当前 Agent、主要页面标题 |
| Section title | `13px / 20px`, `600` | `text-[13px] font-semibold` | Plan、Approval、设置分组 |
| Session title | `12px / 18px`, `500` | `text-xs font-medium` | Session 列表与对话标题 |
| Conversation | `14px / 28px`, `400` | `text-sm font-normal leading-7` | 用户消息与 Agent 最终回答 |
| UI body | `13px / 20px`, `400` | `text-[13px] font-normal leading-5` | 菜单描述、普通界面文本 |
| Metadata | `10–11px / 16px`, `500` | `text-[10px] font-medium` | 状态、时间、数量；英文状态可使用 `tracking-[0.08em] uppercase` |
| Machine label | `11–12px / 18px`, `400` mono | `font-mono text-[11px]` | `/command`、工具名、模型 ID |
| Path and code | `12px / 20px`, `400` mono | `font-mono text-xs leading-5` | 文件路径、命令、代码和 Diff |

约束：

- 中文正文、标题和 Session 名称使用系统无衬线字体栈，不使用全大写或人为增加字间距。
- 对话正文默认正常字重；粗体只来自 Markdown 语义，不将整段 Agent 输出加粗。
- 等宽字体只用于机器生成或需要字符对齐的信息，不能用于长篇自然语言正文。
- 同一信息层级在 Paper Lime 与 Carbon Vermilion 中保持完全一致的字号、行高和字重。
- 字体层级必须通过基础组件落地，页面层不得临时引入新的字号或字体族。

## 4. 信息架构

桌面端采用三列结构：

```text
Agent Rail (60) | Session Panel (286) | Conversation Workspace (minmax)
```

### 4.1 Agent Rail

- 只展示 Agent 品牌图形，不展示字母缩写。
- 点击 Agent 切换到该 Agent 的 Session Panel。
- 选中态同时使用边框、表面色和阴影，健康状态使用独立状态点。
- Flow 与 Agent 平级，位于 Agent 组下方并由分割线隔开。
- 主题固定在 Rail 底部；设置入口只在存在完整设置界面时展示，禁止保留无动作入口。

### 4.2 Session Panel

- 顶部显示当前 Agent 名称、健康状态和 Session 数量。
- 新建 Session 的 Agent 身份由当前 Rail 选择确定。
- 支持搜索、按 PIN 和最近活动排序、归档入口。
- Session 行只显示标题；PIN、运行状态和时间属于必要元数据，不重复显示 Agent 名称。
- 重命名、PIN、归档、删除属于 Session 操作，不占用常驻卡片区域。

### 4.3 Conversation Workspace

- Header 显示 Session 标题、Agent、目录和运行状态。
- 模型、权限、目录和 Flow 是可选上下文，不是创建会话的必填表单。
- 主区以对话为骨架，Plan、Tool、Diff、Approval、Artifact 是时间线中的结构化块。
- 有历史时输入器固定在视口底部；无 Session 或空 Session 时输入器位于视觉中心。
- 不展示原始事件瀑布。未知事件保留在 Event Store，但默认 UI 只渲染可理解的投影。

## 5. 组件规范

### 5.1 AgentBrandIcon

- 已知 Agent 使用本地品牌 SVG，继承当前文字颜色，不依赖 CDN。
- Rail 尺寸 `18px`；Header 尺寸 `14px`。
- SVG 为装饰元素时设置 `aria-hidden`，按钮提供完整 Agent 名称。
- 未知 Agent 使用通用 `Bot` 图形，不回退到任意其他品牌。

### 5.2 SessionRow

- 默认无卡片边框，使用留白分组。
- 选中态才出现 Surface、边线和轻阴影。
- 标题单行截断；完整标题通过 `title` 或操作菜单访问。
- PIN 排在状态和时间之前；危险操作不出现在行内。

### 5.3 ConversationMessage

- 用户消息靠右并使用 `accentSoft`，最大宽度 `72%`。
- Agent 消息靠左，不加普通聊天气泡；Markdown 正文使用舒展行高。
- 思考/进度与最终回答由事件 phase 区分，但不显示模型内部推理原文。
- Markdown 支持标题、列表、表格、链接、引用、行内代码和代码块。

### 5.4 ToolCall

- 默认折叠，摘要展示工具名、可理解的目标、状态和耗时。
- 展开后展示结构化输入与输出；长内容可滚动。
- Running、Completed、Failed 同时使用文字和图标。
- 连续的底层事件合并为一次 Tool Call，不按事件逐行铺满页面。

### 5.5 Plan / Diff / Approval

- Plan 显示步骤完成度，不复制 Runtime 状态机。
- Diff 使用文件级入口和行级增删语义，避免全屏原始 JSON。
- Approval 必须说明动作、目标、影响范围和授权时效。
- Allow 与 Deny 都给出明确完成状态；生产或共享环境写入不得默认授权。

### 5.6 Composer

- 输入自然语言是主动作。
- 模型、权限、Workspace 和 Flow 以紧凑上下文控件出现。
- 模型与权限选项来自当前 Agent 的 Session Config Options；禁止在 Web 枚举 Codex、Claude Code、Cursor 或其他厂商的固定值。
- `model` 使用 Select，`thought_level` 使用离散 Slider，`mode` 使用 Select；`model_config` 中具备 fast/speed 语义的选项使用 Speed Select。控件形态由配置类别与语义决定，具体值与说明始终由 Agent Adapter 提供。
- Reasoning Slider 只展示 Adapter 上报的真实等级；Session 未显式覆盖时，滑块定位到 Adapter 的 `currentValue`，标签追加 `· Default`。用户设置后保存为当前 Session 覆盖，并可通过 `Use default` 清除覆盖。
- Agent 自定义配置以 Session `config_overrides` 持久化，并在运行时通过 ACP `session/set_config_option` 应用；Web 不为 Codex、Claude Code 或其他 Agent 建立专属配置页面。
- 模型、Reasoning、Speed 等输入器状态变化不得卸载历史 Markdown、公式或 Mermaid；历史内容只有在内容或主题变化时才允许重新渲染。
- 权限选择是当前 Session 的显式覆盖；未选择时显示 `Agent default` 并服从 Agent、本机或企业策略，不把探测 Session 的临时默认值写入业务 Session。
- Agent 未报告模型、权限、命令或上下文能力时，不显示对应的空控件。
- Pi SDK Adapter 应上报模型和原生 Thinking Level；OpenCode 通过 Backend 配置进入 Agent Registry，并沿用相同 Session Config Options，不建立厂商专属页面。
- `+` 用于选择文件；`@` 用于插入当前 Session 已授权的 Workspace 上下文；`/` 用于当前 Agent 动态返回的命令。
- 不支持的能力不显示空按钮；运行时无命令时 `/` 不展示。
- `Enter` 发送、`Shift+Enter` 换行；IME 合成期间不得误发送。
- 附件和目录必须使用系统选择器或浏览器授权能力，不能要求用户手写本地绝对路径。

## 6. 状态与空态

每个数据组件至少处理：

- `loading`：使用结构稳定的 Skeleton，不让列宽跳动。
- `empty`：说明当前对象为空，并提供唯一的下一步动作；不展示示例业务内容。
- `error`：靠近失败区域，提供错误原因和重试入口。
- `offline`：保留历史可读性，禁用需要 Agent 的动作。
- `needs approval`：在时间线和 Session 状态中同时可发现。

全局空态只表达产品能力：选择 Agent、创建 Session、输入目标。禁止写死日志、订单、发布或特定项目字段。

## 7. 交互规则

- 切换 Agent 时恢复该 Agent 上次选择的 Session；无历史时进入空 Session 状态。
- 切换 Session 立即取消旧 SSE，并以新 Session 的 History → Commands → Config Options → Live Events 顺序恢复。
- 模型选择按 Session 持久化，加载期间不能用空值覆盖服务端当前值。
- Flow 只绑定下一次 Run；切换 Flow 不修改历史 Run。
- PIN、重命名、归档和删除通过紧凑菜单管理；删除必须二次确认。
- Theme 在本地持久化；系统主题只作为首次默认值。
- 所有异步动作必须有就地反馈，不能使用 `console`、浏览器 `prompt` 或 `confirm` 作为产品交互。

## 8. 响应式与可访问性

- `≥1040px` 使用三列布局。
- 窄屏优先将 Session Panel 变为可开关抽屉；Conversation 保持主区域。
- 交互目标最小 `36px`，Agent Rail 目标为 `42px`。
- 所有按钮具备可读 `aria-label`，纯装饰 SVG 使用 `aria-hidden`。
- 键盘可完成 Agent/Session 切换、新建、发送、审批和关闭菜单。
- 焦点状态必须可见；颜色对比满足 WCAG AA。
- 动效只使用 `opacity` 和 `transform`，并尊重 `prefers-reduced-motion`。

## 9. 工程约束

- 技术栈固定为 React + Vite + TypeScript + Tailwind CSS + shadcn/ui。
- Hono 只提供 API、SSE 和可选静态资源托管。
- 不引入第二套全局状态机；服务端 Session、Run 和 Event 是事实来源。
- 不新增业务自定义 CSS；Tailwind Utility 和 shadcn 组件源码是唯一样式实现。
- 功能组件不得访问虚构数据；Demo 数据只允许存在于显式 Preview 入口。
- 页面不枚举厂商模型、Skill、MCP 或命令；全部由 Agent Adapter 和 Registry 动态报告。
- 视觉调整先更新本文档和语义 Token，再更新基础组件，最后组合页面。

## 10. 验收清单

### 导航

- Agent 与 Session 层级清晰，Flow 与 Agent 平级。
- Agent 品牌图标尺寸一致，选中态与健康状态均可辨识。
- 每个 Agent 保留最近打开的 Session。

### 会话

- 新建、搜索、切换、PIN、重命名、归档和删除可用。
- 切换 Session 不串历史、不重置模型、不阻塞导航。
- Provider 历史和实时事件合并后无重复。

### 对话

- Markdown、Tool Call、状态、错误和审批清晰可读。
- 不展示原始事件洪流或内部推理原文。
- 输入、换行、命令、模型、Flow 和目录能力按运行时状态工作。

### 主题与质量

- Paper Lime 和 Carbon Vermilion 布局完全同构。
- `1440 × 900` 无溢出，主要动作不落出视口。
- `pnpm lint`、Web 测试和生产构建通过。
