import { Button } from "@/components/ui/button";
import type { SessionRuntimeView, SessionTurnView } from "@/lib/types";

export function SessionQueue(props: {
  turns: SessionTurnView[];
  runtime: SessionRuntimeView;
  cancellingTurnId: string | null;
  onCancel: (turnId: string, version: number) => void;
  onResume: (version: number) => void;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  if (!props.turns.length && props.runtime.queue_state === "ready") return null;
  const pauseHint = pauseReasonLabel(props.runtime.queue_pause_reason);
  return <section aria-label="下一轮队列" className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface">
    <header className="flex items-center justify-between border-b border-line px-3 py-2"><span className="text-xs font-semibold text-ink">下一轮队列 · {props.turns.length}</span>{props.runtime.queue_state === "paused" && <Button onClick={() => props.onResume(props.runtime.version)} size="sm">继续队列</Button>}</header>
    {props.runtime.queue_state === "paused" && <p className="border-b border-line px-3 py-2 text-xs leading-5 text-ink-soft">{pauseHint}{props.turns.length ? "" : " 当前没有排队消息，再发一条会自动继续。"}</p>}
    <ol className="max-h-[min(40vh,24rem)] min-w-0 divide-y divide-line overflow-y-auto">{props.turns.map((turn) => <li className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5" key={turn.turn_id}><span className="font-mono text-xs text-faint">{turn.queue_position}</span><span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere] text-xs text-ink-soft" title={turn.message.text}>{turn.message.text}</span><Button aria-label={`取消排队消息 ${turn.queue_position}`} disabled={props.cancellingTurnId === turn.turn_id} onClick={() => props.onCancel(turn.turn_id, turn.version)} size="sm" variant="ghost">取消</Button></li>)}</ol>
    {props.runtime.queue.next_cursor !== null && <Button className="w-full" data-load-more-queue disabled={props.loadingMore} onClick={props.onLoadMore} size="sm" variant="ghost">{props.loadingMore ? "正在加载…" : "加载更多排队消息"}</Button>}
  </section>;
}

function pauseReasonLabel(reason: SessionRuntimeView["queue_pause_reason"]): string {
  switch (reason) {
    case "cancelled":
      return "已取消，队列暂停。";
    case "interrupted":
      return "上一轮被中断，队列暂停。";
    case "failed":
      return "上一轮失败，队列暂停。";
    case "stale":
      return "排队已过期，未自动执行。";
    default:
      return "队列已暂停。";
  }
}
