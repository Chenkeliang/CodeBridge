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
