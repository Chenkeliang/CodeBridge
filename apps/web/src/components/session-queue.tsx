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
  return <section aria-label="下一轮队列" className="rounded-lg border border-line bg-surface">
    <header className="flex items-center justify-between border-b border-line px-3 py-2"><span className="text-xs font-semibold text-ink">下一轮队列 · {props.turns.length}</span>{props.runtime.queue_state === "paused" && <Button onClick={() => props.onResume(props.runtime.version)} size="sm">继续队列</Button>}</header>
    <ol className="divide-y divide-line">{props.turns.map((turn) => <li className="flex items-center gap-3 px-3 py-2.5" key={turn.turn_id}><span className="font-mono text-xs text-faint">{turn.queue_position}</span><span className="min-w-0 flex-1 truncate text-xs text-ink-soft">{turn.message.text}</span><Button aria-label={`取消排队消息 ${turn.queue_position}`} disabled={props.cancellingTurnId === turn.turn_id} onClick={() => props.onCancel(turn.turn_id, turn.version)} size="sm" variant="ghost">取消</Button></li>)}</ol>
    {props.runtime.queue.next_cursor !== null && <Button className="w-full" data-load-more-queue disabled={props.loadingMore} onClick={props.onLoadMore} size="sm" variant="ghost">{props.loadingMore ? "正在加载…" : "加载更多排队消息"}</Button>}
  </section>;
}
