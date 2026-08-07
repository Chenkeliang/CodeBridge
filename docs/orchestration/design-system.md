# 设计规范

## 1. 设计方向

关键词：清晰、克制、可审计、强层级、低噪声。

它是工程操作工作台，不是聊天气泡 Demo，也不是充满紫色渐变的 AI 营销页。界面应该让用户快速回答：现在处理哪个任务、涉及哪些项目、已经做了什么、下一步是否需要我确认。

## 2. 视觉基线

- 设计变化度：4/10，允许少量非对称，但不牺牲定位和扫描效率。
- 动效强度：3/10，只在状态变化、展开、审批和导航中使用。
- 信息密度：5/10，数据丰富但保留呼吸空间。
- 禁止使用 Emoji 作为状态、按钮或业务标识。
- 禁止默认 AI 紫色和大面积霓虹发光。

## 3. Token

```css
:root {
  --bg: #f7f8fa;
  --surface: #ffffff;
  --surface-muted: #f1f3f5;
  --ink: #17202a;
  --muted: #68737d;
  --line: #dfe4e8;
  --accent: #0f766e;
  --accent-soft: #e6f3f1;
  --warning: #a16207;
  --danger: #be123c;
  --success: #15803d;
  --focus: #2563eb;
}

[data-theme="dark"] {
  --bg: #111418;
  --surface: #1a1f24;
  --surface-muted: #222930;
  --ink: #f2f4f5;
  --muted: #a3adb7;
  --line: #303940;
  --accent: #55b9ad;
  --accent-soft: #173c39;
}
```

语义颜色可以使用警告、危险和成功色，但品牌强调色只保留一个主色。颜色不能单独承担风险表达，必须同时有文字、图标或结构变化。

## 4. 排版和布局

- 默认字体：`Geist`，代码和数字：`Geist Mono`；实现前先检查项目 `package.json`。
- 不使用衬线字体作为 Dashboard 主体字体。
- 页面最大宽度建议 `1400px`，移动端使用单列布局。
- 使用 CSS Grid 组织主布局，避免复杂的百分比 Flex 计算。
- 用边线、分组和留白表达层级，只有需要浮起或确认的内容才使用卡片。
- 数字、订单号、SKU 和时间使用等宽数字，方便对齐和核对。

## 5. 动效规则

- 只动画 `transform` 和 `opacity`，不动画 `top/left/width/height`。
- 关键动作使用短暂过渡和按压反馈；不使用持续干扰工作的背景动画。
- 长列表使用 Skeleton 和渐进加载，不用无限 Spinner。
- 动效必须支持 `prefers-reduced-motion`。
- 审批、删除、发布等高风险动作不能依赖动效传达结果。

## 6. 组件规则

核心组件优先建设：

```text
WorkItemHeader
ContextPanel
ProjectDiscoveryCard
PlanTimeline
EvidenceViewer
ApprovalPanel
DiffViewer
RunStatus
```

每个组件必须设计成功、加载、空、错误、等待权限五种状态。组件只负责展示和交互，任务状态由 Runtime 提供，不在 UI 内复制一份流程状态机。

## 7. 可访问性

- 键盘可完成新建、切换、审批和查看证据。
- 文本与背景满足 WCAG AA 对比度。
- 不以颜色作为唯一状态标识。
- 错误信息显示在对应控件附近，并提供可执行的恢复建议。
