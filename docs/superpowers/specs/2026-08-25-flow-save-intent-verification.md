# Explicit Flow Save Intent — V1 Verification Evidence

> Evidence date: 2026-08-26 (Asia/Shanghai)  
> Branch: `codex/fix-session-history-overflow`  
> Verified implementation HEAD: `7015a9d5e9bbb0ff019974550b193d55ee8122d7`  
> Baseline: `origin/main@4784a8269c871bbf47056fa9299b8a26631fc2fe`  
> Runtime: Node `v24.8.0`, pnpm `10.34.1`

## 1. Result

The domain, API, Agent adapters, Web closed loop, and Feishu delivery path are present and independently verified. Real Pi, ACP, Web, and Feishu evidence exists. The Flow Catalog changed only after an explicit Web confirm; test requests that were not meant to persist were dismissed.

After `7015a9d`, a fresh active Feishu run verified that the Agent body and Adapter footer now agree: the Agent states only that a pending request was recorded, no Candidate exists, and the client owns the confirmation entry; the Feishu footer directs the user to Web. The same-card Delivery completed, the test request was dismissed, and the Catalog remained unchanged.

All non-Telegram V1 gates pass, so the design status is `Implemented and verified`. Telegram remains deliberately disabled: its implementation and automated surface tests pass, but real-bot reachability and closed-loop verification remain an explicit enablement follow-up rather than a V1 acceptance claim.

## 2. Commit map

| Commit | Delivery |
|---|---|
| `3602e84` | Design explicit Flow Save Intent |
| `8743b36` | Executable implementation plan |
| `c186630` | Save Intent domain events |
| `4d485b5` | Pure Run extraction separated from recommendation |
| `b5ca66c` | Persistent state machine and startup reconciliation |
| `a7000cd` | Remove automatic Guide suggestions from active Web |
| `ad5a93c` | Hydrate/SSE Timeline projection |
| `65dd1fb` | Request, confirm, and dismiss command APIs |
| `869956a` | Retire legacy proposal and run-based Guide paths |
| `b3e0390` | Internal Agent save-request tool |
| `53f6674` | Translate persisted Agent tool events |
| `07d3cb6` | Web confirmation closed loop |
| `27792bb` | Feishu same-card Save Intent notice |
| `6e33967` | Telegram same-message Save Intent notice |
| `3e7c2be` | Preserve ACP invocation identity and safe extraction |
| `839788a` | Accept strict canonical ACP tool-start envelopes |
| `b24d8e4` | Exclude save-request Runs from automatic source selection |
| `7015a9d` | Keep confirmation-entry ownership in clients |

## 3. Automated verification

All listed test executions completed with zero failures and were not retried to hide a failure.

| Gate | Command / coverage | Result |
|---|---|---|
| Domain and crash recovery | `vitest` over `flow-save-intent`, integration, translator, Flow API, and Session projector | 5 files, 156/156 |
| Agent adapters | Core tool, MCP server, RunnerHost, Pi, Pi Session Runner, real ACP active-session path | 6 files, 80/80 |
| Post-fix prompt contract | Core tool description, Pi prompt guideline, MCP description | 3 files, 17/17 |
| Presentation surfaces | Web card/Timeline/store, Feishu live/recovery, Telegram live/recovery, real Session wire contract | 8 files, 115/115 |
| Browser closed loop and overflow | `e2e/flow-save-intent.spec.ts` and `e2e/provider-history-overflow.spec.ts` | 2 specs, 39/39 at 320/768/1280/1536 widths |
| Workspace build | `pnpm build` | 20 of 21 workspace projects built successfully |
| Diff integrity | `git diff --check` / staged diff check at each commit | clean |

The implementation plan contained one stale test path: `packages/backends/src/acp/acp-active-session.test.ts`. The real path is `packages/backends/src/acp-active-session.test.ts`; it was run explicitly and contributed 11 passing tests to the Agent adapter total.

The Web build emitted existing non-blocking warnings for Node built-ins externalized in the browser build, runtime-resolved Workbench fonts, and chunks above 500 kB. It emitted no type or bundle error.

## 4. Active build and process evidence

After `7015a9d`, the repository was fully rebuilt and the launchd services were forcibly restarted.

| Component | Evidence |
|---|---|
| Bridge | PID `1706`, started `2026-08-26 01:11:39 +08:00` |
| Runner | PID `1715`, started `2026-08-26 01:11:39 +08:00` |
| Core Flow tool | SHA-256 `2c5657784b5cefbe229d8f5ab2f5007ebc30e1a578d0f6f645ac9d98d62c4833` |
| Pi adapter | SHA-256 `6899bcd799718a44f985967fe203f77d525bd588da769c102276e6dc25645aeb` |
| Runner MCP server | SHA-256 `0b8387ebc88be29995cdf2938cd4c5663e3a8626659c872265ef4d64cff9d388` |
| Bridge CLI | SHA-256 `0bce5fff90924e8cfcfaa9323d161e1cabe734198fe9ba0a18c178c0637caa69` |
| Runner CLI | SHA-256 `dd3022caac9438d8017f306a012723b3d361548cc750e30ff2c086115834f8ef` |
| Web entry | SHA-256 `726787ac86e124881456410724acdd896babfe6934b6dbd6ca22d87ed74d889f` |

The launchd arguments point directly at the recorded Bridge and Runner artifacts. No source-tree commit identifier is embedded into those artifacts, so the evidence chain is: checked-out HEAD → full build → artifact hashes → forced restart → live behavior.

## 5. Real local behavior

### 5.1 Pi, Web confirm, and Candidate

- Session: `sess_63c10ec0740142a1a285cd1dcb255ebc`
- Business source Run: `run_4f1371b1b1a349cea16d3a9decc24167`
- Save-request Run: `run_1717f56a11264a2b80124b7742f3cd4f`
- Tool start/end/request sequences: `56`, `57`, `58`
- Request: `fsr_76383cec30d449acbf42929d311732c7`
- Catalog count before confirm: `9`
- Web confirm created Candidate `flow_save_bec75c00530fa7c848d8eeafe8722074`
- Candidate kind/status/review: `runbook / candidate / pending`
- Candidate definition revision: `sha256:feac33c6133f10066127f46942bff88ddea72ad66c0f5e9984b4448ddf6c992a`
- Provenance points to the source Run, Session, and request.
- The Session remained unbound: `flow_id = null`, `flow_revision = null`.
- The existing Candidate detail opened with Dry-run available; no Dry-run, publish, binding, or online update was executed.
- Catalog count after confirm: `10`.

A separate ordinary “save query result to a file” Run created a normal file-write tool event and zero Flow Save Intent events. Its temporary file was removed after verification.

A fresh Session with no prior extractable Run returned the exact Turn-menu fallback and persisted zero `FLOW_SAVE_REQUESTED` events.

### 5.2 ACP/Codex source selection

- Session: `sess_f6ab543b261345d3a8d29e4d4f8d6ad1`
- Business source Run: `run_5fc615a7179f4ed1b03c2314036ea94d`
- Final save-request Run: `run_e28cec6696c6452aa8de6f6586a862de`
- Request sequence: `159`
- Request: `fsr_3c04c6719d544b5d9db955d7e58e6877`

The real ACP payload exposed three adversarial gaps that are now locked by tests: canonical result wrappers, strict ACP start envelopes, and a previous failed save-request Run being chosen as the next source. After the fixes, sequence `159` points to the original business Run instead of the management Run. The request was dismissed and the Catalog stayed at `10`.

### 5.3 Feishu active surface

- Session: `sess_c02c1a4e986f408db7e48b176d70f850`
- Business source Run: `run_546cd2bb48614bf99499767dd680f313`
- Save-request Run: `run_41315b88038e4c7ba66b2cbc6bc5e11b`
- Request sequence: `2120`
- Request: `fsr_826d3d5ff26b449fb962725c08af0408`
- Dismiss sequence: `2129`

Before the final prompt-contract patch, an active Feishu run proved the production Bridge/CardKit path: the request notice appeared on the same Run card, the Delivery reached `completed`, no detached Save Intent message was created, and the request was later dismissed without a Catalog write. External Feishu message/card identifiers are intentionally redacted in this document.

That run also exposed a wording contradiction: the Agent body claimed confirmation was available in the current interface while the Adapter footer correctly directed the user to Web. Commit `7015a9d` moved confirmation-entry ownership back to clients.

The post-fix active Feishu check used the fully rebuilt and restarted processes recorded in §4:

- Session: `sess_64ae64ffe8cc4c52b8b15720d73dc2b8`
- Business source Run: `run_24c459d82e7b4b119e7a47b410dd344f`
- Save-request Run: `run_53566a8c0b02470ea7a86d4ac9617a1d`
- Request: `fsr_ff3a7823eab24ba48b677ad28946e84e`
- Request sequence: `4899`
- Dismiss sequence: `4908`

The Agent body stated “只是记录了保存意图，尚未创建 Candidate——确认入口由客户端展示”, and the Adapter footer stated “请前往 Web 确认；尚未创建 Candidate”. No text claimed that confirmation was available in the current Feishu interface. The original Delivery reached `completed` on the same persisted message/card, the request was dismissed through the canonical command API, and the Catalog remained at `10`.

### 5.4 Telegram

Telegram same-message live/recovery/restart behavior is implemented and tested, including long-message chunking that keeps the Save Intent notice on the original pending message. The Telegram channel is disabled in production, so it is not marked reachable or closed-loop. Real-bot verification is the explicit enablement follow-up.

## 6. Surface Matrix

| Surface | Entry | Read path | Write path | Event consumption | Error/recovery/terminal feedback | Four-state result |
|---|---|---|---|---|---|---|
| Web | Turn menu and canonical request card | Timeline hydrate + SSE | request/confirm/dismiss API | Four `FLOW_SAVE_*` events | Same-key unknown retry, Session race guards, refresh/restart parity, Candidate link | implemented, reachable, closed-loop |
| Backend | HTTP commands and Agent translator | Canonical events + exact source Run | Idempotent event append + deterministic Candidate service | `AGENT_EVENT` → `FLOW_SAVE_*` | Stable errors, startup-only reconciliation, immutable terminal state | implemented, reachable, closed-loop |
| Agent | Pi tool / ACP MCP tool | Current Session evidence | Intent request only; no Catalog write | Persisted tool start/end correlation | Exact no-source fallback; pending-only acknowledgement | implemented, reachable; not a Candidate writer |
| Feishu | Natural-language request | Session Timeline / same Run card | No Candidate write | `FLOW_SAVE_REQUESTED` on matching Run | Same-card notice, restart recovery, terminal Delivery completion; Web owns confirm | implemented, reachable; channel intentionally does not own Candidate closed-loop |
| Telegram | Natural-language request after enablement | Session Timeline / same Telegram message | No Candidate write | `FLOW_SAVE_REQUESTED` on matching Run | Live/replay/restart and long-message behavior tested | implemented, tested, planned; disabled, not reachable/closed-loop |

## 7. Completion definition audit

| # | Requirement | Evidence | State |
|---|---|---|---|
| 1 | Ordinary successful Run creates no Save Intent or automatic Guide card | Domain tests, Web tests, real file-save negative case | pass |
| 2 | Explicit succeeded Turn selection creates one persisted confirmation card | Web component/E2E plus request API | pass |
| 3 | Real ACP/Pi tool call follows the same request path without arbitrary IDs | Real Pi/ACP events and strict translator tests | pass |
| 4 | Refresh/restart/replay preserves one request and card state | Projector, SSE, Feishu/Telegram recovery tests | pass |
| 5 | Confirm creates one provenance-bearing Candidate, never binds it, and opens existing review/Dry-run | Real Pi → Web confirm | pass |
| 6 | Dismiss/failure immutable; repeated user intent creates a new request | Domain/API/E2E adversarial tests | pass |
| 7 | Catalog 503/unknown transport outcomes remain honest | API and Web retry tests | pass |
| 8 | Startup reconciliation closes the cross-store crash window without a timer | Crash integration tests | pass |
| 9 | Legacy proposal/run-based Guide paths return 410 after active callers are removed | API/Router/Web tests and caller audit | pass |
| 10 | Feishu does not advertise an unavailable confirmation destination; Telegram remains honestly disabled | Post-fix Agent body + same-card Feishu footer; Telegram Surface remains disabled | pass |
| 11 | Agent/channel/Web do not duplicate the Flow state machine or Catalog write | Code review, Surface tests, zero-write channel spies | pass |
| 12 | Tests, builds, GitNexus, and final Surface Matrix pass | Automated gates, active Feishu recheck, and final Surface Matrix pass | pass |

## 8. GitNexus and remaining risks

- The complete Flow Save Intent range affects active Agent, Web, Runtime projection, and channel paths and is correctly reported as CRITICAL at aggregate branch scope.
- Each HIGH/CRITICAL edit boundary was reported before implementation and covered by focused contract plus active-surface tests.
- The final prompt-contract commit is LOW: 5 files, 1 changed symbol, 0 affected execution processes.
- No periodic Save Intent reconciler, duplicate channel state machine, or channel-side Catalog write was introduced.
- Known follow-up: enable Telegram and run the real bot verification before changing its Surface state.
- Known non-blocking build warnings are recorded in §3.

## 9. Dirty-tree preservation

The user-owned `AGENTS.md` modification and the pre-existing untracked `.claude/`, `.playwright-cli/`, `.superpowers/`, `CLAUDE.md`, Vite timestamp files, older Flow documents, `output/`, and `test-results/` were not staged or modified as part of this feature.
