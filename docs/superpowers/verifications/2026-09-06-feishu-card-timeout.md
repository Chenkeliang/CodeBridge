# Feishu task card lifetime repair

## Cause and implementation

The active Session ingress used `LarkChannel.stream({markdown})`, which creates
`streaming_mode: true` entities. The installed SDK documents the service's
10-minute stream closure. Its `setContent` acknowledges its local queue, and
`pushContent` catches write errors. Consequently Run/Delivery completion did not
prove the final card was delivered. The screenshots stop at 9:54 and 9:58 while
the Runtime later reports success/cancellation.

The Session card host now uses ordinary CardKit entities with
`streaming_mode: false`; checked full-card API writes preserve the original
message, four-line status and coalescing writer. API rejection propagates to
finalize, leaving Delivery eligible for retry. A historical card's reconciliation
failure is isolated so subsequent live deliveries still receive status updates.
The legacy non-Session adapter is not the active production entry and is unchanged.

## Surface matrix

| Surface | Entry/read/write/events | Recovery/error/terminal | State |
|---|---|---|---|
| Feishu Session | submit → Runtime delivery → watcher → ordinary CardKit | per-delivery failure isolation; checked terminal API ack before completion | implemented; active entry verified in code; deployment pending |
| Agent | existing Runner event stream → Runtime | no execution/cancellation behavior changed by this card patch | unchanged |
| Web | existing Runtime timeline reader | unchanged terminal state | unchanged; no online E2E claimed |
| Telegram | existing Runtime event watcher | unchanged terminal state | unchanged; no online E2E claimed |

## Verification

- Actual unreferenced entity creation and full-card/element update returned code 0;
  no diagnostic IM message was sent.
- Production-path test uses raw CardKit and message.reply mocks, not native streaming.
- Time-controlled test verifies same entity at 11 minutes and successful final ack.
- Failed final API write does not clear pending delivery; a successful retry does.
- A failing historical card does not prevent another Session's live reconciliation.

## Release boundary

This patch is separate from the earlier lease mitigation `7fbdcc8` and ongoing
Runner termination work. Deploy only the Feishu commit onto production base
`6f285c9`, build its package and restart Bridge after the active Run and delivery
finish. Runner does not need a restart for this change.

## Official CLI/API investigation and follow-up

- Official CLI: https://github.com/larksuite/cli . `lark-cli api` invokes the
  same OpenAPI endpoints; it is not the task-card writer currently in production.
  The host PATH contains the CodeBridge `fcb` helper, not `lark-cli`.
- Official contract read in Markdown:
  https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview.md
  closes streaming mode 10 minutes after it was last enabled. Cards remain
  editable; the mode can also be reopened. This is not a task-execution deadline.
- https://open.feishu.cn/document/cardkit-v1/card-element/content.md documents
  `200850` (stream timed out) and `300309` (stream closed), with settings reopen
  as recovery. The old SDK did not propagate these API failures to the caller.
- https://open.feishu.cn/document/cardkit-v1/card/update.md documents ordinary
  full updates, strict positive int32 sequences, 14-day entity validity and
  explicit nonzero error responses. Actual ordinary update on the unpublished
  diagnostic entity succeeded after approximately 18 minutes (2026-09-06 15:54).
- A read-only execution of the before/after `b2cbf2e` watcher at minute 11
  recorded native/ordinary write counts 2/1 before and 1/0 after. Removal of
  duplicate ordinary writes removed the prior long-task refresh fallback.

Follow-up closes error-path gaps: CardKit network calls have a 15-second timeout
through the SDK HTTP transport (auth interceptors preserved); unrelated media
request timeouts are unchanged. Per-delivery exponential retry is capped at five
minutes, and known missing/expired/unauthorized entities stop high-frequency
retry. Missing API success codes no longer count as confirmed delivery.

The first restart watcher was held by an unclaimed queued Run from August 20.
Its corrected predicate waits for running executions and recent unfinished
deliveries; unclaimed queued work is recoverable at startup and does not count
as an executing task. No historical Runtime records were changed.
