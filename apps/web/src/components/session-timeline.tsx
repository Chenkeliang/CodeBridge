import { memo, useEffect, useRef, useState } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
import {
  LiveElapsed,
  Markdown,
  WorkMarkdown,
} from "@/components/conversation";
import { Button } from "@/components/ui/button";
import { formatElapsed } from "@/components/workbench-shared";
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
    {props.turns.map((turn) => {
      const liveBlockId = liveProcessBlockId(turn, props.activeRunId);
      return <article className="grid gap-4" data-timeline-turn={turn.turn_id} key={turn.turn_id}>
        {groupProcessBlocks(turn.blocks).map((item) => item.kind === "group"
          ? <ProcessBlock
              blocks={item.blocks}
              key={item.blocks.map((block) => block.block_id).join(":")}
              liveBlockId={liveBlockId}
              loadingBlockId={props.loadingBlockId}
              onLoadSegments={props.onLoadSegments}
            />
          : <TimelineBlock
              activeAssistantSegmentId={item.block.kind === "assistant" ? activeAssistantSegmentId : null}
              block={item.block}
              isLive={liveBlockId === item.block.block_id}
              key={item.block.block_id}
              loading={props.loadingBlockId === item.block.block_id}
              onLoadSegments={props.onLoadSegments}
            />)}
      </article>;
    })}
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
  if (isEmptyProcessBlock(block) && !props.isLive) return null;
  const more = block.next_segment_cursor !== null && !props.isLive && <Button disabled={props.loading} onClick={() => props.onLoadSegments(block.block_id, block.next_segment_cursor!)} size="sm" variant="ghost">
    {props.loading ? "正在加载…" : "加载更多输出"}
  </Button>;
  if (block.kind === "user_message") {
    return <div className="grid justify-items-end gap-2"><span className="font-brand text-xs uppercase tracking-[0.1em] text-muted">你</span><div className="max-w-[72%] rounded-xl bg-accent-soft px-3.5 py-3 text-sm leading-6 text-ink"><Markdown content={block.segments.map((segment) => segment.content).join("")} /></div>{more}</div>;
  }
  if (block.kind === "assistant") {
    return <div className="grid max-w-[780px] gap-2">
      <span className="font-brand text-xs font-normal uppercase tracking-[0.1em] text-muted">Agent</span>
      <div className="rounded-lg border border-line bg-surface px-3.5 py-3 shadow-card">
        {block.segments.map((segment) => <TimelineSegment
          key={segment.segment_id}
          segment={segment}
          streamingCaret={segment.segment_id === props.activeAssistantSegmentId}
        />)}
      </div>
      {more}
    </div>;
  }
  return <ProcessBlock
    blocks={[block]}
    liveBlockId={props.isLive ? block.block_id : null}
    loadingBlockId={props.loading ? block.block_id : null}
    onLoadSegments={props.onLoadSegments}
  />;
});

function ProcessBlock(props: {
  blocks: TimelineBlockView[];
  liveBlockId: string | null;
  loadingBlockId: string | null;
  onLoadSegments: (blockId: string, after: number) => void;
}) {
  const visible = props.blocks.filter((block) =>
    !isEmptyProcessBlock(block) || block.block_id === props.liveBlockId
  );
  if (visible.length === 0) return null;
  const isLive = visible.some((block) => block.block_id === props.liveBlockId);
  const hasThought = visible.some((block) => block.kind === "thought");
  const startedAt = earliestTimestamp(visible.map(blockStartedAt));
  const endedAt = visible.every((block) => blockEndedAt(block))
    ? latestTimestamp(visible.map(blockEndedAt))
    : null;
  const [liveFallbackStart] = useState(() => new Date().toISOString());
  const elapsedStart = startedAt ?? (isLive ? liveFallbackStart : null);
  const completedElapsed = !isLive && startedAt && endedAt
    ? formatElapsed(startedAt, endedAt)
    : null;
  return <details
    open={hasThought || isLive || visible.some((block) => block.kind === "error") || undefined}
    className="group max-w-[780px] border-t border-line"
  >
    <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-xs text-muted">
      {isLive && <LoaderCircle className="size-3.5 animate-spin text-control-accent" />}
      <span className="font-medium text-ink-soft">{isLive ? "工作中" : completedElapsed ? `耗时 ${completedElapsed}` : blockLabel(visible[0]!.kind)}</span>
      {isLive && elapsedStart && <LiveElapsed startedAt={elapsedStart} />}
      <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
    </summary>
    <div className="grid gap-2 pb-4">
      {visible.map((block) => {
        const more = block.next_segment_cursor !== null && block.block_id !== props.liveBlockId && (
          <Button
            disabled={props.loadingBlockId === block.block_id}
            onClick={() => props.onLoadSegments(block.block_id, block.next_segment_cursor!)}
            size="sm"
            variant="ghost"
          >
            {props.loadingBlockId === block.block_id ? "正在加载…" : "加载更多输出"}
          </Button>
        );
        if (block.segments.length === 0) return more;
        const roundElapsed = blockStartedAt(block) && blockEndedAt(block)
          ? formatElapsed(blockStartedAt(block)!, blockEndedAt(block)!)
          : null;
        return <div className="grid gap-2" key={block.block_id}>
          <div
            className={cn(
              "rounded-md border border-line bg-surface-tint px-3 py-2",
              block.kind === "error" ? "text-danger" : "text-ink-soft",
            )}
          >
            {block.kind === "thought" && (
              <p className="mb-1 font-brand text-xs font-normal uppercase tracking-[0.1em] text-warning">
                {roundElapsed ? `推理 ${roundElapsed}` : "推理"}
              </p>
            )}
            {block.segments.map((segment) => (
              <TimelineSegment key={segment.segment_id} segment={segment} tone="work" />
            ))}
          </div>
          {more}
        </div>;
      })}
    </div>
  </details>;
}

function groupProcessBlocks(blocks: TimelineBlockView[]): Array<
  { kind: "group"; blocks: TimelineBlockView[] } | { kind: "single"; block: TimelineBlockView }
> {
  const items: Array<
    { kind: "group"; blocks: TimelineBlockView[] } | { kind: "single"; block: TimelineBlockView }
  > = [];
  for (const block of blocks) {
    if (!isProcessKind(block.kind)) {
      items.push({ kind: "single", block });
      continue;
    }
    const previous = items.at(-1);
    if (previous?.kind === "group") previous.blocks.push(block);
    else items.push({ kind: "group", blocks: [block] });
  }
  return items;
}

function earliestTimestamp(values: Array<string | null>): string | null {
  const stamps = values.filter((value): value is string => Boolean(value));
  if (!stamps.length) return null;
  return stamps.reduce((earliest, value) => value < earliest ? value : earliest);
}

function latestTimestamp(values: Array<string | null>): string | null {
  const stamps = values.filter((value): value is string => Boolean(value));
  if (!stamps.length) return null;
  return stamps.reduce((latest, value) => value > latest ? value : latest);
}

function liveProcessBlockId(turn: TimelineTurnView, activeRunId: string | null): string | null {
  if (!activeRunId || turn.run_id !== activeRunId) return null;
  const running = turn.blocks.filter((block) =>
    isProcessKind(block.kind) && block.status === "running"
  );
  const streaming = running.find((block) =>
    block.segments.some((segment) => !segment.sealed && segment.content)
  );
  if (streaming) return streaming.block_id;
  const thought = running.find((block) => block.kind === "thought");
  if (thought) return thought.block_id;
  const work = running.find((block) =>
    block.kind === "work" && block.segments.some((segment) => segment.content)
  );
  if (work) return work.block_id;
  const tool = running.find((block) => block.kind === "tool");
  if (tool) return tool.block_id;
  return running[0]?.block_id ?? null;
}

function isProcessKind(kind: TimelineBlockView["kind"]): boolean {
  return kind === "thought" || kind === "work" || kind === "tool";
}

function isEmptyProcessBlock(block: TimelineBlockView): boolean {
  return isProcessKind(block.kind) && block.segments.every((segment) => !segment.content);
}

function blockTimestamp(block: TimelineBlockView, key: "started_at" | "ended_at"): string | null {
  const value = block.metadata[key];
  return typeof value === "string" && value ? value : null;
}

function blockStartedAt(block: TimelineBlockView): string | null {
  return blockTimestamp(block, "started_at");
}

function blockEndedAt(block: TimelineBlockView): string | null {
  return blockTimestamp(block, "ended_at");
}

export const TimelineSegment = memo(
  function TimelineSegment({ segment, streamingCaret = false, tone = "answer" }: {
    segment: TimelineSegmentView;
    streamingCaret?: boolean;
    tone?: "answer" | "work";
  }) {
    return <div
      data-active-segment={segment.sealed ? undefined : true}
      data-segment-id={segment.segment_id}
      data-streaming-caret={streamingCaret ? true : undefined}
    >
      {tone === "work"
        ? <WorkMarkdown content={segment.content} />
        : <Markdown content={segment.content} />}
    </div>;
  },
  (previous, next) =>
    previous.streamingCaret === next.streamingCaret
    && previous.tone === next.tone
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
