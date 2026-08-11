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
