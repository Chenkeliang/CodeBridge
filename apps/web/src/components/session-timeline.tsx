import { memo, useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";
import { Markdown } from "@/components/conversation";
import { Button } from "@/components/ui/button";
import type {
  TimelineBlockView,
  TimelineSegmentView,
  TimelineTurnView,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export function SessionTimeline(props: {
  activeRunId: string | null;
  turns: TimelineTurnView[];
  hasEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  loadingBlockId: string | null;
  onLoadSegments: (blockId: string, after: number) => void;
}) {
  const timelineRoot = useRef<HTMLDivElement | null>(null);
  const seenSegmentIds = useRef<Set<string> | null>(null);

  let activeAssistantSegmentId: string | null = null;
  for (const turn of props.turns) {
    if (turn.run_id !== props.activeRunId) continue;
    for (const block of turn.blocks) {
      if (block.kind !== "assistant") continue;
      for (const segment of block.segments) {
        if (!segment.sealed) activeAssistantSegmentId = segment.segment_id;
      }
    }
  }

  useEffect(() => {
    const currentSegmentIds = props.turns.flatMap((turn) =>
      turn.blocks.flatMap((block) => block.segments.map((segment) => segment.segment_id)),
    );
    if (seenSegmentIds.current === null) {
      seenSegmentIds.current = new Set(currentSegmentIds);
      return;
    }
    const newlyLiveAssistantSegments = new Set(
      props.turns.flatMap((turn) =>
        turn.run_id === props.activeRunId
          ? turn.blocks.flatMap((block) =>
            block.kind === "assistant"
              ? block.segments
                .filter((segment) => !segment.sealed && !seenSegmentIds.current?.has(segment.segment_id))
                .map((segment) => segment.segment_id)
              : [],
          )
          : [],
      ),
    );
    timelineRoot.current?.querySelectorAll<HTMLElement>("[data-segment-id]").forEach((node) => {
      if (node.dataset.segmentId && newlyLiveAssistantSegments.has(node.dataset.segmentId)) {
        node.classList.add("assistant-reveal");
      }
    });
    for (const segmentId of currentSegmentIds) seenSegmentIds.current.add(segmentId);
  }, [props.activeRunId, props.turns]);

  return <div className="grid gap-6" ref={timelineRoot}>
    {props.hasEarlier && <Button className="mx-auto" data-load-earlier disabled={props.loadingEarlier} onClick={props.onLoadEarlier} size="sm" variant="ghost">
      {props.loadingEarlier ? "正在加载…" : "加载更早对话"}
    </Button>}
    {props.turns.map((turn) => <article className="grid gap-4" data-timeline-turn={turn.turn_id} key={turn.turn_id}>
      {turn.blocks.map((block) => <TimelineBlock
        activeAssistantSegmentId={block.kind === "assistant" ? activeAssistantSegmentId : null}
        block={block}
        isLive={turn.run_id === props.activeRunId && block.status === "running"}
        key={block.block_id}
        loading={props.loadingBlockId === block.block_id}
        onLoadSegments={props.onLoadSegments}
      />)}
    </article>)}
  </div>;
}

const TimelineBlock = memo(function TimelineBlock(props: {
  activeAssistantSegmentId: string | null;
  block: TimelineBlockView;
  isLive: boolean;
  loading: boolean;
  onLoadSegments: (blockId: string, after: number) => void;
}) {
  const { block } = props;
  const more = block.next_segment_cursor !== null && <Button disabled={props.loading} onClick={() => props.onLoadSegments(block.block_id, block.next_segment_cursor!)} size="sm" variant="ghost">
    {props.loading ? "正在加载…" : "加载更多输出"}
  </Button>;
  if (block.kind === "user_message") {
    return <div className="grid justify-items-end gap-2"><span className="font-brand text-xs uppercase tracking-[0.1em] text-muted">你</span><div className="max-w-[72%] rounded-xl bg-accent-soft px-3.5 py-3 text-sm leading-6 text-ink"><Markdown content={block.segments.map((segment) => segment.content).join("")} /></div>{more}</div>;
  }
  if (block.kind === "assistant") {
    return <div className="grid max-w-[780px] gap-2"><span className="text-xs font-medium tracking-[0.08em] text-muted">Agent</span>{block.segments.map((segment) => <TimelineSegment
      key={segment.segment_id}
      segment={segment}
      streamingCaret={segment.segment_id === props.activeAssistantSegmentId}
    />)}{more}</div>;
  }
  return <details open={props.isLive || undefined} className="max-w-[780px] border-t border-line">
    <summary className="flex cursor-pointer items-center gap-2 py-3 text-xs text-muted">
      {props.isLive && <LoaderCircle className="size-3.5 animate-spin" />}
      <span>{blockLabel(block.kind)}</span>
    </summary>
    <div className={cn("grid gap-2 pb-4 text-xs leading-5", block.kind === "error" ? "text-danger" : "text-ink-soft")}>
      {block.segments.map((segment) => <TimelineSegment key={segment.segment_id} segment={segment} />)}
    </div>
    {more}
  </details>;
});

export const TimelineSegment = memo(
  function TimelineSegment({ segment, streamingCaret = false }: {
    segment: TimelineSegmentView;
    streamingCaret?: boolean;
  }) {
    return <div
      data-active-segment={segment.sealed ? undefined : true}
      data-segment-id={segment.segment_id}
      data-streaming-caret={streamingCaret ? true : undefined}
    >
      <Markdown content={segment.content} />
    </div>;
  },
  (previous, next) =>
    previous.streamingCaret === next.streamingCaret
    && previous.segment.segment_id === next.segment.segment_id
    && previous.segment.content === next.segment.content
    && previous.segment.sealed === next.segment.sealed,
);

function blockLabel(kind: TimelineBlockView["kind"]): string {
  switch (kind) {
    case "user_message": return "消息";
    case "assistant": return "回复";
    case "thought": return "推理";
    case "work": return "工作过程";
    case "tool": return "工具调用";
    case "approval": return "等待批准";
    case "error": return "错误";
  }
}
