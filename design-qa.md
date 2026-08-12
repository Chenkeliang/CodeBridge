# AGNET Web Design QA

- Date: 2026-08-11
- Route: `http://127.0.0.1:19790/workbench/`
- Product design source: `docs/orchestration/DESIGN.md`
- Interaction references:
  - `/var/folders/s3/ldypxg_d2cbdvyvdx2yysz580000gn/T/codex-clipboard-TeY7DS.png`
  - `/var/folders/s3/ldypxg_d2cbdvyvdx2yysz580000gn/T/codex-clipboard-KMzBQG.png`
  - `/var/folders/s3/ldypxg_d2cbdvyvdx2yysz580000gn/T/codex-clipboard-Qn67fC.png`
  - `/var/folders/s3/ldypxg_d2cbdvyvdx2yysz580000gn/T/codex-clipboard-sT2wGO.png`
  - `/var/folders/s3/ldypxg_d2cbdvyvdx2yysz580000gn/T/codex-clipboard-ZVKsyT.png`
  - `/var/folders/s3/ldypxg_d2cbdvyvdx2yysz580000gn/T/codex-clipboard-RQPuzE.png`

The Codex and Cursor screenshots define interaction hierarchy and information treatment, not a pixel-for-pixel replacement for the AGNET visual system. Color, rail, session panel, spacing, and theme remain governed by `DESIGN.md`.

## Capture state

| Evidence | State | Pixel size |
| --- | --- | --- |
| Slash reference | `/` suggestions open | 734 × 722 |
| Slash implementation | Codex commands open | 1440 × 900 |
| Workspace reference | `@` workspace context open | 852 × 318 |
| Workspace implementation | `/Users/keliang/mypy` listing open | 1440 × 900 |
| Work reference | completed Codex response | 881 × 841 |
| Work implementation | work details expanded | 1440 × 659 usable browser area |

Browser viewport capability was set to 1440 × 900 at density 1. The browser shell exposed a 1440 × 659 usable page area for the final work-detail capture. All screenshots were taken from the running local build with a real Codex Session; no messages were sent.

## Same-canvas comparisons

- `output/design-qa/slash-comparison.png`
- `output/design-qa/workspace-comparison.png`
- `output/design-qa/work-comparison.png`

Each comparison places the supplied interaction reference on the left and the running AGNET implementation on the right.

## Primary interaction checks

| Check | Result |
| --- | --- |
| Typing `/` opens suggestions immediately | Passed; `/plan`, `/skills`, and the remaining Agent commands were visible |
| Typing `@` loads current Workspace context | Passed; root `/Users/keliang/mypy` and navigable entries were visible |
| Commentary and thought summaries are separated from the final answer | Passed |
| Work is collapsed by default and expandable | Passed |
| Tool activity is individually expandable | Passed |
| Command summaries include the concrete command | Passed; `Ran command /bin/zsh -lc …` was visible |
| File activity includes absolute paths | Passed; `Read file /Users/keliang/…` was present in the rendered DOM |
| Work text renders Markdown without literal markers | Passed; no literal `**Planning …**` remained |
| Long progress text stays inside the work column | Passed; measured row `clientWidth` and `scrollWidth` were both 780 px |
| Browser console warnings and errors | Passed; none recorded |

## Comparison history

1. First comparison found literal Markdown markers in reasoning summaries and incomplete command labels.
2. The event presentation was updated to parse Codex ACP code-mode command inputs and render work text with Markdown.
3. Browser measurement then found the expanded work grid using a max-content implicit column (`scrollWidth: 7427px`).
4. The grid was constrained with an explicit `minmax(0, 1fr)` track. Final measurement was `clientWidth: 780px`, `scrollWidth: 780px`.

## Findings

- P0: none.
- P1: none.
- P2: none.
- P3: historical Feishu messages can still contain channel-specific `<text_tag>` markup and transport instructions. This is imported source data rather than the new work/tool projection and should be normalized in a separate history-cleanup change.

final result: passed

---

# 2026-08-12 UX Review — Open Issues

Source: code review of `apps/web/src/components/workbench.tsx` (1128 lines). Not yet fixed; grouped by priority.

> **落地状态（2026-08-12 下午）**：P0-1/2/3/4、P1-5/6/7/8/9/10/12、P2-13/14/15 已完成；P1-11（Session 列表虚拟化）以 `content-visibility` 廉价方案落地。提案 A4（Working 实时耗时）、D10（时间线脊柱）、E12（Cmd+K 面板 + 弹层键盘导航）、E13（发送键冲压）已落地。主题切换圆形揭示以 transform-scale 实现（未违反 opacity/transform 约束）。未落地：A1/A2 像素转场、B5 accent 减量、B6 per-Agent 标识色、B7 语法高亮、C8 阅读模式、C9 密度档位、D11 审批走线动画。停止 Run 按钮依赖新的 `POST /v1/sessions/:id/cancel` 端点，**需重启 bridge 进程生效**。

## P0 — 可用性

1. `/` 命令与 `@` 上下文弹层不支持键盘导航（无 ↑↓ 选择、Enter 确认），只能鼠标点击。
2. 对话区自动滚动过于粗暴：`events` 变化即 `scrollTop = scrollHeight`，用户上翻历史会被拽回底部。应仅在贴底时跟随，并提供"回到底部"悬浮按钮。
3. `notice` Toast 1.8s 消失过快，且无成功/失败样式区分。建议 ≥4s 并区分 info/error。
4. 界面中英文混杂（`未命名 Session`/`搜索 Session` 与 `Ready`/`Needs approval`/`Enter to send` 并存）。需统一语言或引入 i18n。

## P1 — 视觉与可读性

5. 字号普遍偏小：大量 `text-[10px]`、基础 13px；建议正文 14px、辅助信息 ≥11px（DESIGN.md 3.4/3.5 需同步修订）。
6. 点击目标偏小：`size-7`（28px）低于 DESIGN.md 第 8 节自定的 36px 下限。
7. 对比度风险：Paper 主题 `muted #73796C` / `faint #9CA296` 在 `#F6F7F4` 上偏浅，需跑 WCAG AA 校验。
8. 流式状态缺失：assistant 输出中无打字指示；`Working` 行无 spinner / 实时耗时（耗时只在结束后显示）。

## P1 — 交互补全

9. 无全局快捷键：建议 `Cmd/Ctrl+K` 命令面板、`Cmd+N` 新建 Session；且 UI 缺少停止/中断当前 Run 的按钮。
10. `min-w-[1040px]` 硬编码，窄窗口横向滚动；Session Panel 应可折叠为抽屉（DESIGN.md 第 8 节已规定，未实现）。
11. Session 列表无虚拟化，无按 cwd/模型筛选。
12. Composer 顶部 chip 横向溢出时无渐变遮罩，不易发现右侧控件。

## P2 — 工程

13. 主题色硬编码于 TS 对象（两份 hex），违反 DESIGN.md 3.1 "Token 单一事实源"的精神；建议迁至语义 Token / CSS 变量。
14. `workbench.tsx` 单文件 1128 行，应拆分 `Composer` / `SessionPanel` / `ProjectionItem` 等。
15. 工具调用 Input/Output 为裸 JSON `<pre>`；文件编辑类应渲染行级 Diff，命令类突出 exit code（DESIGN.md 5.5 已规定 Diff 语义，未落地）。

---

# 2026-08-12 Design Proposals — 焕新方向（未实施）

约束前提：遵守 DESIGN.md 2.1 禁令（无渐变/发光/玻璃拟态/纯黑），新鲜感来自几何秩序与像素品牌基因。标注 ⚠ 的条目超出当前 DESIGN.md 字面约束，落地前需先修订文档。

## A. 动效：像素转场体系

1. Agent 切换时对话区以 8×8 像素块随机序 opacity 消解/重组（纯 opacity，符合第 8 节动效约束）。
2. Skeleton 从灰条闪烁升级为像素噪点"显影"。
3. 主题切换以按钮为圆心做 `clip-path: circle()` 圆形揭示。⚠（clip-path 不在 opacity/transform 白名单内）
4. `Working` 行加等宽实时耗时（`tabular-nums`）+ 1px accent 不定进度细线。

## B. 色彩

5. Accent `#CCFF00` 减量：只保留在信号位（发送按钮、活动圆点、焦点环），大色块改用 `surfaceTint`。
6. Per-Agent 低饱和标识色：Rail 选中态与 Session Header 用 3px 侧边条表达 Agent 身份（Codex 绿 / Claude 赭 / Cursor 灰），不改背景。⚠（需在 2.1 开单一例外）
7. 代码/Diff 区引入语法高亮：Paper 油墨色系、Carbon 磷光色系。

## C. 字体

8. Agent 长回答提供"阅读模式"：拉丁 Newsreader / Source Serif 4，中文回退 Songti SC（DESIGN.md 3.5 已提及 Plantin 方向，此为可商用替代）。
9. 暴露密度档位设置（Compact 13px / Comfortable 14.5px），落地 DESIGN_VARIANCE / VISUAL_DENSITY 控制。

## D. 结构隐喻：Bridge / 电路语言

10. WorkActivity 工具调用与 Reasoning 条目用 1px 竖线脊柱串联，running 节点 opacity 呼吸。
11. Approval 卡 hover 时边框虚线"走线"动画（`stroke-dashoffset`）。

## E. 输入器

12. `Cmd+K` 命令面板（切 Agent/Session/Flow/主题）+ `/` `@` 弹层键盘导航（对应 P0-1）。
13. 发送按钮 hover 做 1px"冲压"位移 + 阴影变化，与像素动效同属物理感家族。

落地优先级：A1/A4 > B6 > C8。
