# AGNET Web Design QA — YYYY-MM-DD

- Route: `http://127.0.0.1:19790/workbench/`
- Product design source: `docs/orchestration/DESIGN.md`
- Screenshots: `node scripts/design-qa.mjs`（输出到 `output/design-qa/`，含 manifest.json）

## Capture state

| Evidence | State | Pixel size |
| --- | --- | --- |
| `workbench-{paper,carbon}.png` | 默认工作台 | 1440 × 900 |
| `palette-{paper,carbon}.png` | ⌘K 命令面板打开 | 1440 × 900 |
| `preview-{paper,carbon}.png` | `?preview=design` 真实组件 + mock 数据 | 1440 × 900 |
| `preview-states-{paper,carbon}.png` | `&state=states` 边界态（加载/运行中/错误/已解决审批） | 1440 × 900 |

## Checks

| Check | Result |
| --- | --- |
| `pnpm lint`（tsc + eslint，0 error） |  |
| `pnpm test`（含 design-tokens 对比度与文档一致性） |  |
| `pnpm build` |  |
| 双主题同构（布局/尺寸/层级一致，仅颜色不同） |  |
| 状态不只靠颜色（文字或图标同时表达） |  |
| 键盘可达：⌘K / ⌘N / 弹层方向键 / Enter 发送 / Esc 关闭 |  |
| 长文本不溢出对话列（clientWidth === scrollWidth） |  |
| 控制台无 warning / error |  |

## Findings

- P0: …
- P1: …

## Result

passed / blocked: …
