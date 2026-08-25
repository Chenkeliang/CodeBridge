import { memo, useEffect, useRef, useState } from "react";
import { BookmarkPlus, ChevronDown, LoaderCircle, MoreHorizontal, Workflow, X } from "lucide-react";
import {
  LiveElapsed,
  Markdown,
  WorkMarkdown,
} from "@/components/conversation";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  FlowSaveRequestCard,
  type FlowSaveRequestActionState,
} from "@/components/flow-save-request-card";
import {
  RuntimeApprovalCard,
  type RuntimeApprovalAction,
  type RuntimeApprovalStatus,
} from "@/components/runtime-approval-card";
import { formatElapsed } from "@/components/workbench-shared";
import { revisionTail } from "@/lib/revision-tail";
import type {
  FlowRecommendation,
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
  resolvingApprovalId?: string | null;
  approvalStatusOverrides?: Record<string, RuntimeApprovalStatus>;
  onResolveApproval?: (action: RuntimeApprovalAction, approve: boolean) => void;
  solidifiableFlowIds?: string[];
  savingCandidateRunId?: string | null;
  onCreateCandidate?: (runId: string) => void;
  flowRecommendations?: FlowRecommendation[];
  onUseFlowRecommendation?: (recommendation: FlowRecommendation) => void;
  onDismissFlowRecommendation?: (recommendation: FlowRecommendation) => void;
  onOpenFlowBatch?: (reference: { draftId?: string; batchId?: string }) => void;
  requestingFlowRunIds?: ReadonlySet<string>;
  flowSaveActionStates?: Record<string, FlowSaveRequestActionState>;
  onRequestFlowSave?: (runId: string) => void;
  onConfirmFlowSave?: (requestId: string) => void;
  onDismissFlowSave?: (requestId: string) => void;
  onOpenFlowCandidate?: (flowId: string) => void;
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

  const blockedFlowSaveSourceRunIds = new Set(
    props.turns.flatMap((turn) => turn.blocks.flatMap((block) => {
      if (block.kind !== "flow_save_request" || !["pending", "completed"].includes(block.status)) return [];
      const sourceRunId = stringMetadata(block.metadata, "source_run_id");
      return sourceRunId ? [sourceRunId] : [];
    })),
  );

  return <div className="grid gap-6" ref={timelineRoot}>
    {props.hasEarlier && <Button className="mx-auto" data-load-earlier disabled={props.loadingEarlier} onClick={props.onLoadEarlier} size="sm" variant="ghost">
      {props.loadingEarlier ? "正在加载…" : "加载更早对话"}
    </Button>}
    {props.turns.map((turn) => {
      const liveBlockId = liveProcessBlockId(turn, props.activeRunId);
      const recommendation = props.flowRecommendations?.find((entry) =>
        entry.run_id === turn.run_id && entry.status === "pending"
      ) ?? null;
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
              onResolveApproval={props.onResolveApproval}
              resolvingApprovalId={props.resolvingApprovalId ?? null}
              approvalStatusOverrides={props.approvalStatusOverrides ?? {}}
              solidifiableFlowIds={props.solidifiableFlowIds ?? []}
              savingCandidateRunId={props.savingCandidateRunId ?? null}
              onCreateCandidate={props.onCreateCandidate}
              onOpenFlowBatch={props.onOpenFlowBatch}
              flowSaveActionState={flowSaveActionState(item.block, props.flowSaveActionStates)}
              onConfirmFlowSave={props.onConfirmFlowSave}
              onDismissFlowSave={props.onDismissFlowSave}
              onOpenFlowCandidate={props.onOpenFlowCandidate}
              runId={turn.run_id}
            />)}
        {recommendation && <div className="grid max-w-[780px] gap-3 rounded-lg border border-accent/40 bg-accent-soft px-3.5 py-3 text-xs text-muted">
          <div>
            <div className="font-medium text-ink">Agent 建议使用 Flow · {recommendation.flow_id}</div>
            <div className="mt-1">{recommendation.reason || "当前任务与已发布 Flow 匹配"}</div>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => props.onUseFlowRecommendation?.(recommendation)} size="sm">
              <Workflow className="size-3.5" />查看并使用
            </Button>
            <Button onClick={() => props.onDismissFlowRecommendation?.(recommendation)} size="sm" variant="ghost">
              <X className="size-3.5" />忽略
            </Button>
          </div>
        </div>}
        {props.onRequestFlowSave && isEligibleFlowSaveSourceTurn(turn, blockedFlowSaveSourceRunIds) && <TurnActionMenu
          busy={props.requestingFlowRunIds?.has(turn.run_id) ?? false}
          onRequest={() => props.onRequestFlowSave?.(turn.run_id)}
        />}
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
  runId: string;
  resolvingApprovalId: string | null;
  approvalStatusOverrides: Record<string, RuntimeApprovalStatus>;
  onResolveApproval?: (action: RuntimeApprovalAction, approve: boolean) => void;
  solidifiableFlowIds: string[];
  savingCandidateRunId: string | null;
  onCreateCandidate?: (runId: string) => void;
  onOpenFlowBatch?: (reference: { draftId?: string; batchId?: string }) => void;
  flowSaveActionState: FlowSaveRequestActionState | null;
  onConfirmFlowSave?: (requestId: string) => void;
  onDismissFlowSave?: (requestId: string) => void;
  onOpenFlowCandidate?: (flowId: string) => void;
}) {
  const { block } = props;
  if (block.kind === "flow_save_request") return <FlowSaveRequestCard
    actionState={props.flowSaveActionState}
    block={block}
    onConfirm={props.onConfirmFlowSave}
    onDismiss={props.onDismissFlowSave}
    onOpenCandidate={props.onOpenFlowCandidate}
  />;
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
  if (block.kind === "flow_param" || block.kind === "flow_step" || block.kind === "flow_run" || block.kind === "flow_failure") {
    return <FlowBlock
      block={block}
      onCreateCandidate={props.onCreateCandidate}
      runId={props.runId}
      savingCandidateRunId={props.savingCandidateRunId}
      solidifiableFlowIds={props.solidifiableFlowIds}
    />;
  }
  if (block.kind === "flow_batch") {
    return <FlowBatchTimelineCard block={block} onOpen={props.onOpenFlowBatch} />;
  }
  if (block.kind === "approval") {
    const approvalId = typeof block.metadata.approval_id === "string"
      ? block.metadata.approval_id
      : null;
    return <RuntimeApprovalCard
      block={block}
      busy={approvalId !== null && approvalId === props.resolvingApprovalId}
      effectiveStatus={approvalId ? props.approvalStatusOverrides[approvalId] : undefined}
      onResolve={props.onResolveApproval}
      runId={props.runId}
    />;
  }
  return <ProcessBlock
    blocks={[block]}
    liveBlockId={props.isLive ? block.block_id : null}
    loadingBlockId={props.loading ? block.block_id : null}
    onLoadSegments={props.onLoadSegments}
  />;
});

function TurnActionMenu(props: { busy: boolean; onRequest: () => void }) {
  const [open, setOpen] = useState(false);
  return <div className="flex w-full max-w-[780px] justify-end" data-turn-actions>
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label="Turn 操作"
          className="size-8 p-0"
          disabled={props.busy}
          size="icon"
          variant="ghost"
        >{props.busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <MoreHorizontal className="size-4" />}</Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="min-w-36 border-line-strong bg-overlay p-1 shadow-panel"
        side="bottom"
      >
      <button
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-ink hover:bg-surface-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-strong"
        onClick={() => {
          setOpen(false);
          props.onRequest();
        }}
        type="button"
      ><BookmarkPlus className="size-3.5 text-control-accent" />存为 Flow</button>
      </PopoverContent>
    </Popover>
  </div>;
}

function isEligibleFlowSaveSourceTurn(
  turn: TimelineTurnView,
  blockedSourceRunIds: ReadonlySet<string>,
): boolean {
  if (turn.status !== "succeeded" || blockedSourceRunIds.has(turn.run_id)) return false;
  if (!turn.blocks.some((block) => block.kind === "assistant")) return false;
  if (turn.blocks.some((block) => [
    "flow_param",
    "flow_step",
    "flow_run",
    "flow_failure",
    "flow_batch",
  ].includes(block.kind))) return false;
  return !turn.blocks.some((block) =>
    block.kind === "flow_save_request"
    && stringMetadata(block.metadata, "request_run_id") === turn.run_id
    && stringMetadata(block.metadata, "source_run_id") !== turn.run_id
  );
}

function flowSaveActionState(
  block: TimelineBlockView,
  states: Record<string, FlowSaveRequestActionState> | undefined,
): FlowSaveRequestActionState | null {
  if (block.kind !== "flow_save_request") return null;
  const requestId = stringMetadata(block.metadata, "request_id");
  return requestId ? states?.[requestId] ?? null : null;
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value ? value : null;
}

function FlowBatchTimelineCard({ block, onOpen }: {
  block: TimelineBlockView;
  onOpen?: (reference: { draftId?: string; batchId?: string }) => void;
}) {
  const draftId = typeof block.metadata.draft_id === "string" ? block.metadata.draft_id : undefined;
  const batchId = typeof block.metadata.batch_id === "string" ? block.metadata.batch_id : undefined;
  const counts = block.metadata.counts && typeof block.metadata.counts === "object"
    ? block.metadata.counts as Record<string, unknown>
    : {};
  const total = Number(block.metadata.total ?? counts.total ?? block.metadata.item_count ?? 0);
  const succeeded = Number(counts.succeeded ?? block.metadata.succeeded ?? 0);
  const failed = Number(counts.failed ?? block.metadata.failed ?? 0);
  return <div className="grid max-w-[780px] gap-3 rounded-lg border border-line-strong bg-surface px-3.5 py-3 shadow-card" data-flow-batch-card>
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-xs font-semibold text-ink">Flow 批量调用</p>
        <p className="mt-1 font-mono text-[11px] text-muted">{batchId ?? draftId ?? "等待建立草稿"}</p>
      </div>
      <span className="rounded-md bg-surface-tint px-2 py-1 font-mono text-[11px] text-muted">{block.status}</span>
    </div>
    {total > 0 && <p className="font-mono text-xs text-muted">成功 {succeeded} · 失败 {failed} · 共 {total}</p>}
    <Button className="justify-self-start" disabled={!draftId && !batchId} onClick={() => onOpen?.({ draftId, batchId })} size="sm" variant="outline">查看参数与进度</Button>
  </div>;
}

function ProcessBlock(props: {
  blocks: TimelineBlockView[];
  liveBlockId: string | null;
  loadingBlockId: string | null;
  onLoadSegments: (blockId: string, after: number) => void;
}) {
  const [liveFallbackStart] = useState(() => new Date().toISOString());
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
    case "flow_step": return "流程步骤";
    case "flow_param": return "参数";
    case "flow_run": return "Run 快照";
    case "flow_failure": return "验证失败";
    case "flow_batch": return "批量 Flow";
    case "flow_save_request": return "存为 Flow";
  }
}

function flowStepLabel(status: string): string {
  switch (status) {
    case "running": return "执行中";
    case "passed": return "完成";
    case "failed": return "失败";
    case "retrying": return "重试中";
    case "skipped": return "跳过";
    default: return "步骤";
  }
}

function flowStepDot(status: string): string {
  switch (status) {
    case "running": return "bg-control-accent animate-pulse";
    case "passed": return "bg-success";
    case "failed": return "bg-danger";
    case "retrying": return "bg-warning";
    default: return "bg-faint";
  }
}

function FlowBlock({ block, runId, solidifiableFlowIds, savingCandidateRunId, onCreateCandidate }: {
  block: TimelineBlockView;
  runId: string;
  solidifiableFlowIds: string[];
  savingCandidateRunId: string | null;
  onCreateCandidate?: (runId: string) => void;
}) {
  const meta = block.metadata as Record<string, unknown>;
  if (block.kind === "flow_step") {
    const label = flowStepLabel(block.status);
    const tone = block.status === "failed" ? "text-danger" : block.status === "retrying" ? "text-warning" : block.status === "passed" ? "text-success" : "text-ink-soft";
    return <div className="grid max-w-[780px] gap-1.5">
      <p className="flex items-center gap-2 font-mono text-xs">
        <span className={cn("size-2 rounded-full", flowStepDot(block.status))} />
        <span className={tone}>{label}</span>
        <span className="text-muted">{String(meta.capability_id ?? meta.step_id ?? "")}</span>
        {block.status === "retrying" && meta.error != null && <span className="truncate text-muted">{String(meta.error)}</span>}
      </p>
      {block.segments[0]?.content ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface-tint px-3 py-2 font-mono text-xs text-ink-soft">{block.segments[0].content}</pre> : null}
    </div>;
  }
  if (block.kind === "flow_param") {
    const resolution = meta.resolution === "edited" ? "edited" : "confirmed";
    return <div className="flex max-w-[780px] flex-wrap items-center gap-2 font-mono text-xs text-muted">
      <span className={cn("rounded px-1.5 py-0.5", resolution === "edited" ? "bg-warning-soft text-warning" : "bg-surface-tint text-success")}>{resolution}</span>
      <span>参数 {String(meta.field)} = {JSON.stringify(meta.final_value)}</span>
      {meta.candidate_value != null && <span className="text-faint">候选 {JSON.stringify(meta.candidate_value)}</span>}
    </div>;
  }
  if (block.kind === "flow_failure") {
    const category = String(meta.category ?? "verification");
    return <div className="grid max-w-[780px] gap-1.5 rounded-lg border border-danger/40 bg-danger-soft p-3.5 text-xs">
      <p className="flex items-center gap-2 font-semibold text-danger">
        <X className="size-3.5" />
        <span>验证失败 · {category}</span>
        {meta.truncated === true && <span className="rounded bg-surface-tint px-1.5 py-0.5 font-mono text-faint">actual 已截断</span>}
      </p>
      <p className="font-mono text-danger/80">步骤 {String(meta.step_id)} · {String(meta.postcondition ?? "")}</p>
    </div>;
  }
  const steps = Array.isArray(meta.steps) ? meta.steps as Array<Record<string, unknown>> : [];
  const passed = steps.filter((step) => step.verification_status === "passed").length;
  const flowId = String(meta.flow_id ?? "");
  const canSolidify = block.status === "succeeded" && solidifiableFlowIds.includes(flowId);
  return <div className="grid max-w-[780px] gap-2 rounded-lg border border-line bg-surface p-3.5 shadow-card">
    <p className="flex items-center justify-between gap-2 text-xs">
      <span className="flex items-center gap-2 font-semibold text-ink"><Workflow className="size-3.5" />Run 快照</span>
      <span className={cn("font-mono", block.status === "succeeded" ? "text-success" : "text-danger")}>{block.status === "succeeded" ? "成功" : "失败"}</span>
    </p>
    <p className="font-mono text-xs text-muted">Flow {flowId} · rev {revisionTail(String(meta.flow_revision ?? ""))}</p>
    <ol className="grid gap-1">
      {steps.map((step, index) => (
        <li className="flex items-center gap-2 font-mono text-xs" key={String(step.step_id ?? index)}>
          <span className={step.verification_status === "passed" ? "text-success" : "text-danger"}>{step.verification_status === "passed" ? "✓" : "✗"}</span>
          <span className="text-ink-soft">{String(step.capability_id ?? step.step_id)}</span>
          {typeof step.output_ref === "string" && <span className="truncate text-faint">{step.output_ref}</span>}
        </li>
      ))}
    </ol>
    <div className="flex items-center justify-between gap-3">
      <p className="text-xs text-faint">{passed} / {steps.length} 步通过</p>
      {canSolidify && <Button
        className="h-7 text-xs"
        disabled={savingCandidateRunId === runId}
        onClick={() => onCreateCandidate?.(runId)}
        size="sm"
        variant="outline"
      >{savingCandidateRunId === runId ? "正在保存…" : "存为 Candidate"}</Button>}
    </div>
  </div>;
}
