# Reliable Feishu streaming and lease recovery

## Problem and resulting behavior
The deployed ordinary full-card writer rewrote answer text when status changed; the former native SDK writer did not provide a reliable remote acknowledgement or reopen an expired streaming window. Recovery could apply live events ahead of finite replay and even complete an empty result before replay finished.

Use stable answer/progress/status element IDs. Answer updates use CardKit native content; mutable progress/status use component updates. All operations share a per-card FIFO, 150ms minimum operation spacing and the existing persisted int32 sequence allocator. Require code 0; reopen the same card on 200850/300309 and retry the unchanged full answer snapshot. Terminal state is acknowledged only after elements and stream closure succeed. A terminal writer fences delayed live snapshots.

Card previews are bounded by serialized UTF-8 size. Long terminal results are uploaded as complete Markdown files and replied beneath the original bot card. Upload keys and sent-message receipts persist to feishu-result-receipts.json; retries reuse the same UUID and parent. Failed attachment delivery leaves the turn pending.

Recovery buffers incoming events until finite history is available, merges by event sequence, and only then renders/completes. Event-triggered Run and Provider lease renewal supplements the existing timer; expired/cancelled/wrong-owner execution remains fenced. This incorporates the reviewed 7fbdcc8 changes without its branch's unrelated history.

## Branch and deployment boundary
Feature branch feat_feishu_reliable_stream was created explicitly from the actual local production main 0b6b3d3 (initial main..HEAD count 0). origin/main remains 63e1044 and is eight already-deployed commits behind. No develop/release history imported; no push or shared-branch merge performed.
Production's existing scripts/start.sh edit is untouched. Deploy by switching the Bridge launchd entry to this built worktree only. Keep Runner on the existing healthy host process. Roll back by restoring the previous Bridge plist and bootstrapping it after runs drain. No database schema migration is introduced by this patch.

## Verification
- Full pnpm -r run build passed; pre-existing frontend font/chunk warnings remain.
- Full pnpm exec vitest run: 150 files, 1495 tests passed (2026-09-07 11:50).
- Focused cross-surface/runtime suite: 41 files, 461 tests passed.
- Two new replay races were observed failing before the fix: BA instead of AB, and terminal completion before pending history. Both now pass and were independently replayed by a reviewer.
- CardKit writer tests cover per-element writes, two simulated window expirations, remote acknowledgement, missing/error codes, partial success retry, FIFO, terminal fences, attachment receipt reuse and UTF-8 limits.
- Unpublished real CardKit probe starts 11:40. First boundary at 11:51: content 200850 -> settings 0 -> content 0, same card/element. Second boundary and deployment evidence will be appended after completion. Probe log: /Users/keliang/outputs/codebridge-feishu-api-audit-20260907/live-window-probe.jsonl .
- No diagnostic IM message sent. An unpublished card validates server behavior, not the client's visual animation.

## Surface matrix
| Surface | Entry/read/write/events | Error/recovery/terminal | Current evidence |
|---|---|---|---|
| Feishu | Existing Session ingress -> watcher -> acknowledged raw CardKit writer | finite replay ordering, per-card isolation, response checks, pending until terminal/file acknowledgements | implemented; unit + real ingress contract tests pass; server window probe in progress; visual no-flash acceptance pending |
| Agent | Existing Runner events -> RunExecutor -> leases | timer + event renewal, owner/expiry/cancel fences | implemented; RunExecutor and coordinator regression pass |
| Web | Existing Session API and runtime views | unchanged domain terminal semantics | API/integration and full Web test suite pass; no visual changes |
| Telegram | Existing watcher using common Runtime | lease change covered with channel/runtime regressions | tests pass; production remains disabled |

## Remaining limits
The historical card 7675976448927485211 still needs an explicit repair/reissue decision if the new canonical update cannot restore it. Its IM message was created Aug 20, older than CardKit's documented 14-day entity lifetime, but error 300307 alone is not proof of expiry. Do not silently mark it delivered or spam replacement messages.

No claim of client-side zero flicker across stream reopen without visible desktop/mobile verification. Full results above Feishu's 30MB file limit remain pending with an explicit error rather than being silently truncated. Crash between successful send and local receipt persistence relies on Feishu UUID deduplication; no unsupported exactly-once guarantee is made.
