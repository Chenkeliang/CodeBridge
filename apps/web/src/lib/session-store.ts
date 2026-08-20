import { useSyncExternalStore } from "react";
import type {
  SessionEvent,
  SessionRuntimeView,
  SessionSnapshot,
  SessionTimelinePage,
  TimelineBlockView,
  TimelineSegmentPage,
  TimelineSegmentView,
  TimelineTurnView,
} from "./types";
import { applyFlowEvent } from "./flow-events";

export type ReceiveDisposition = "applied" | "duplicate" | "gap" | "refresh_required";

export interface SessionView {
  snapshot: SessionSnapshot;
  status: "ready" | "recovering";
}

const MAX_SEGMENT_BYTES = 16 * 1024;
const textEncoder = new TextEncoder();

type Scheduler = (flush: () => void) => void;

function defaultScheduler(flush: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => flush());
    return;
  }
  setTimeout(flush, 0);
}

export class SessionViewStore {
  private readonly entries = new Map<string, SessionView>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly pendingNotifications = new Set<string>();
  private flushScheduled = false;

  constructor(private readonly options: { schedule?: Scheduler } = {}) {}

  get(sessionId: string): SessionView | undefined {
    return this.entries.get(sessionId);
  }

  hydrate(snapshot: SessionSnapshot): void {
    const current = this.entries.get(snapshot.session.session_id);
    if (current && current.snapshot.runtime.last_event_sequence > snapshot.runtime.last_event_sequence) {
      return;
    }
    this.entries.set(snapshot.session.session_id, { snapshot, status: "ready" });
    this.notify(snapshot.session.session_id);
  }

  receive(sessionId: string, event: SessionEvent): ReceiveDisposition {
    const current = this.entries.get(sessionId);
    if (!current) return "refresh_required";
    if (event.sequence <= current.snapshot.runtime.last_event_sequence) return "duplicate";
    if (event.sequence !== current.snapshot.runtime.last_event_sequence + 1) {
      this.entries.set(sessionId, {
        snapshot: current.snapshot,
        status: "recovering",
      });
      this.notify(sessionId);
      return "gap";
    }
    if (current.status === "recovering") return "gap";

    if (event.type === "MESSAGE_RECEIVED") {
      this.entries.set(sessionId, {
        snapshot: applyUserMessage(current.snapshot, event),
        status: "ready",
      });
      this.notify(sessionId);
      return "applied";
    }

    const payload = extractAgentEvent(event);
    if (payload?.type === "text_delta" || payload?.type === "thought_delta") {
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!text) return "duplicate";
      const committed = applyCommittedEvent(current.snapshot, event, payload.type, text);
      this.entries.set(sessionId, {
        snapshot: committed.snapshot,
        status: committed.refreshRequired ? "recovering" : "ready",
      });
      this.notify(sessionId);
      return committed.refreshRequired ? "refresh_required" : "applied";
    }

    const applied = applyFlowEvent(current.snapshot.timeline.turns, event);
    if (applied !== current.snapshot.timeline.turns) {
      this.entries.set(sessionId, {
        snapshot: {
          ...current.snapshot,
          runtime: { ...current.snapshot.runtime, last_event_sequence: event.sequence },
          timeline: { ...current.snapshot.timeline, turns: applied },
        },
        status: "ready",
      });
      this.notify(sessionId);
      return "applied";
    }

    this.entries.set(sessionId, {
      snapshot: {
        ...current.snapshot,
        runtime: {
          ...current.snapshot.runtime,
          last_event_sequence: event.sequence,
        },
      },
      status: "ready",
    });
    this.notify(sessionId);
    return "refresh_required";
  }

  mergeTimelinePage(sessionId: string, page: SessionTimelinePage): void {
    const current = this.entries.get(sessionId);
    if (!current) return;
    const turnIds = new Set(current.snapshot.timeline.turns.map((turn) => turn.turn_id));
    this.entries.set(sessionId, {
      ...current,
      snapshot: {
        ...current.snapshot,
        timeline: {
          turns: [
            ...page.turns.filter((turn) => !turnIds.has(turn.turn_id)),
            ...current.snapshot.timeline.turns,
          ].sort((left, right) => left.timeline_index - right.timeline_index),
          previous_cursor: page.previous_cursor,
          truncated_block_ids: [...new Set([
            ...current.snapshot.timeline.truncated_block_ids,
            ...page.truncated_block_ids,
          ])],
        },
      },
    });
    this.notify(sessionId);
  }

  mergeSegmentPage(sessionId: string, blockId: string, page: TimelineSegmentPage): void {
    const current = this.entries.get(sessionId);
    if (!current) return;
    const turns = current.snapshot.timeline.turns.map((turn) => ({
      ...turn,
      blocks: turn.blocks.map((block) => {
        if (block.block_id !== blockId) return block;
        const segmentIds = new Set(block.segments.map((segment) => segment.segment_id));
        return {
          ...block,
          segments: [
            ...block.segments,
            ...page.segments.filter((segment) => !segmentIds.has(segment.segment_id)),
          ].sort((left, right) => left.segment_index - right.segment_index),
          next_segment_cursor: page.next_cursor,
        };
      }),
    }));
    this.entries.set(sessionId, {
      ...current,
      snapshot: {
        ...current.snapshot,
        timeline: { ...current.snapshot.timeline, turns },
      },
    });
    this.notify(sessionId);
  }

  mergeQueuePage(sessionId: string, page: SessionRuntimeView["queue"]): void {
    const current = this.entries.get(sessionId);
    if (!current) return;
    const turnIds = new Set(current.snapshot.runtime.queue.turns.map((turn) => turn.turn_id));
    this.entries.set(sessionId, {
      ...current,
      snapshot: {
        ...current.snapshot,
        runtime: {
          ...current.snapshot.runtime,
          queue: {
            turns: [
              ...current.snapshot.runtime.queue.turns,
              ...page.turns.filter((turn) => !turnIds.has(turn.turn_id)),
            ].sort((left, right) => left.queue_position - right.queue_position),
            total: page.total,
            next_cursor: page.next_cursor,
          },
        },
      },
    });
    this.notify(sessionId);
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      const currentListeners = this.listeners.get(sessionId);
      if (!currentListeners) return;
      currentListeners.delete(listener);
      if (!currentListeners.size) this.listeners.delete(sessionId);
    };
  }

  private notify(sessionId: string): void {
    this.pendingNotifications.add(sessionId);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    (this.options.schedule ?? defaultScheduler)(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    const ids = [...this.pendingNotifications];
    this.pendingNotifications.clear();
    for (const sessionId of ids) {
      this.listeners.get(sessionId)?.forEach((listener) => listener());
    }
    if (this.pendingNotifications.size > 0) {
      this.flushScheduled = true;
      (this.options.schedule ?? defaultScheduler)(() => this.flush());
    }
  }
}

export const sessionViewStore = new SessionViewStore();

export function useSessionView(sessionId: string | null): SessionView | undefined {
  return useSyncExternalStore(
    (listener) => (sessionId ? sessionViewStore.subscribe(sessionId, listener) : () => {}),
    () => (sessionId ? sessionViewStore.get(sessionId) : undefined),
  );
}

function applyCommittedEvent(
  snapshot: SessionSnapshot,
  event: SessionEvent,
  kind: "text_delta" | "thought_delta",
  text: string,
): { snapshot: SessionSnapshot; refreshRequired: boolean } {
  const timeline = [...snapshot.timeline.turns];
  let turnIndex = findTurnIndex(timeline, event);
  if (turnIndex < 0) {
    timeline.push(createTimelineTurn(snapshot, event, kind));
    turnIndex = timeline.length - 1;
  }
  const turns = timeline.map((turn, index) => index === turnIndex ? appendTextToTurn(turn, kind, text, event) : turn);
  return {
    snapshot: {
      ...snapshot,
      runtime: {
        ...snapshot.runtime,
        last_event_sequence: event.sequence,
      },
      timeline: {
        ...snapshot.timeline,
        turns,
      },
    },
    refreshRequired: false,
  };
}

function applyUserMessage(snapshot: SessionSnapshot, event: SessionEvent): SessionSnapshot {
  const message = typeof event.payload?.message === "string" ? event.payload.message : "";
  const runId = event.run_id ?? snapshot.session.session_id;
  const turns = [...snapshot.timeline.turns];
  let turnIndex = turns.findIndex((turn) => turn.run_id === runId);
  if (turnIndex < 0) {
    turns.push({
      turn_id: runId,
      status: "running",
      timeline_index: (turns.at(-1)?.timeline_index ?? 0) + 1,
      run_id: runId,
      blocks: [],
    });
    turnIndex = turns.length - 1;
  }
  const turn = turns[turnIndex]!;
  if (turn.blocks.some((block) => block.kind === "user_message")) {
    return {
      ...snapshot,
      runtime: {
        ...snapshot.runtime,
        last_event_sequence: event.sequence,
      },
      timeline: { ...snapshot.timeline, turns },
    };
  }
  const userBlock: TimelineBlockView = {
    block_id: `user:${turn.turn_id}`,
    block_index: 0,
    kind: "user_message",
    status: "completed",
    metadata: { started_at: event.occurred_at },
    segments: [{
      segment_id: `user:${turn.turn_id}:0`,
      segment_index: 0,
      content: message,
      byte_length: byteLength(message),
      sealed: true,
    }],
    next_segment_cursor: null,
  };
  turns[turnIndex] = {
    ...turn,
    blocks: [userBlock, ...turn.blocks.map((block, index) => ({ ...block, block_index: index + 1 }))],
  };
  return {
    ...snapshot,
    runtime: {
      ...snapshot.runtime,
      last_event_sequence: event.sequence,
    },
    timeline: { ...snapshot.timeline, turns },
  };
}

function findTurnIndex(turns: SessionSnapshot["timeline"]["turns"], event: SessionEvent): number {
  if (event.run_id) {
    return turns.findIndex((turn) => turn.run_id === event.run_id);
  }
  return turns.length ? turns.length - 1 : -1;
}

function createTimelineTurn(snapshot: SessionSnapshot, event: SessionEvent, kind: "text_delta" | "thought_delta"): TimelineTurnView {
  return {
    turn_id: event.run_id ?? snapshot.session.session_id,
    status: "running",
    timeline_index: 0,
    run_id: event.run_id ?? snapshot.session.session_id,
    blocks: [createBlock(kind === "text_delta" ? "assistant" : "thought", event)],
  };
}

function appendTextToTurn(
  turn: SessionSnapshot["timeline"]["turns"][number],
  kind: "text_delta" | "thought_delta",
  text: string,
  event: SessionEvent,
): TimelineTurnView {
  const blocks = [...turn.blocks];
  if (kind === "thought_delta") {
    const lastThoughtIndex = lastIndexOfKind(blocks, "thought");
    const lastThought = lastThoughtIndex >= 0 ? blocks[lastThoughtIndex] : undefined;
    if (lastThought?.status === "running") {
      blocks[lastThoughtIndex] = {
        ...lastThought,
        segments: appendTextToSegments(lastThought.segments, text),
        next_segment_cursor: null,
      };
    } else {
      const created = createBlock("thought", event);
      blocks.splice(thoughtInsertIndex(blocks), 0, {
        ...created,
        segments: appendTextToSegments(created.segments, text),
        next_segment_cursor: null,
      });
    }
  } else {
    for (const [index, block] of blocks.entries()) {
      if (block.kind !== "thought" || block.status !== "running") continue;
      blocks[index] = {
        ...block,
        status: "completed",
        metadata: {
          ...block.metadata,
          ended_at: event.occurred_at,
        },
      };
    }
    const lastBlock = blocks.at(-1);
    if (lastBlock?.kind === "assistant") {
      blocks[blocks.length - 1] = {
        ...lastBlock,
        segments: appendTextToSegments(lastBlock.segments, text),
        next_segment_cursor: null,
      };
    } else {
      const created = createBlock("assistant", event);
      blocks.push({
        ...created,
        segments: appendTextToSegments(created.segments, text),
        next_segment_cursor: null,
      });
    }
  }

  return {
    ...turn,
    blocks: blocks.map((block, index) => ({
      ...block,
      block_index: index,
      segments: block.segments.map((segment, segmentIndex) => ({
        ...segment,
        segment_index: segmentIndex,
      })),
    })),
  };
}

function lastIndexOfKind(
  blocks: TimelineBlockView[],
  kind: TimelineBlockView["kind"],
): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.kind === kind) return index;
  }
  return -1;
}

function thoughtInsertIndex(blocks: TimelineBlockView[]): number {
  const lastThought = lastIndexOfKind(blocks, "thought");
  if (lastThought >= 0) return lastThought + 1;
  const firstAgent = blocks.findIndex((block) => block.kind === "assistant" || block.kind === "tool");
  return firstAgent >= 0 ? firstAgent : blocks.length;
}

function createBlock(kind: TimelineBlockView["kind"], event: SessionEvent): TimelineBlockView {
  return {
    block_id: event.event_id,
    block_index: 0,
    kind,
    status: "running",
    metadata: { started_at: event.occurred_at },
    segments: [createSegment("")],
    next_segment_cursor: null,
  };
}

function createSegment(content: string): TimelineSegmentView {
  return {
    segment_id: `segment-${cryptoRandomId()}`,
    segment_index: 0,
    content,
    byte_length: byteLength(content),
    sealed: false,
  };
}

function appendTextToSegments(segments: TimelineSegmentView[], text: string): TimelineSegmentView[] {
  const next = segments.map((segment) => ({ ...segment }));
  let remaining = text;
  let current = next.at(-1);
  if (!current) {
    current = createSegment("");
    next.push(current);
  }

  while (remaining) {
    if (!current) {
      current = createSegment("");
      next.push(current);
    }
    const available = MAX_SEGMENT_BYTES - current.byte_length;
    if (available <= 0) {
      current.sealed = true;
      current = createSegment("");
      next.push(current);
      continue;
    }
    const chunk = takeTextPrefix(remaining, available);
    if (!chunk.chunk) {
      current.sealed = true;
      current = createSegment("");
      next.push(current);
      continue;
    }
    current.content += chunk.chunk;
    current.byte_length = byteLength(current.content);
    remaining = chunk.rest;
    if (remaining) {
      current.sealed = true;
      current = createSegment("");
      next.push(current);
    }
  }

  next.forEach((segment, index) => {
    segment.segment_index = index;
  });
  const last = next.at(-1);
  if (last) last.sealed = last.byte_length >= MAX_SEGMENT_BYTES;
  return next;
}

function takeTextPrefix(text: string, limitBytes: number): { chunk: string; rest: string } {
  let usedBytes = 0;
  let endIndex = 0;
  for (const char of text) {
    const charBytes = byteLength(char);
    if (usedBytes + charBytes > limitBytes) break;
    usedBytes += charBytes;
    endIndex += char.length;
  }
  return {
    chunk: text.slice(0, endIndex),
    rest: text.slice(endIndex),
  };
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function extractAgentEvent(event: SessionEvent): Record<string, unknown> | undefined {
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const inner = (payload as { event?: unknown }).event;
  if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  return payload as Record<string, unknown>;
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}
