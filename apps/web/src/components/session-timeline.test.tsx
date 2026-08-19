// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { TimelineBlockView, TimelineSegmentView, TimelineTurnView } from "@/lib/types";

const markdownRender = vi.hoisted(() => vi.fn());
vi.mock("@/components/conversation", () => ({
  Markdown: ({ content }: { content: string }) => {
    markdownRender(content);
    return <div data-answer-md>{content}</div>;
  },
  WorkMarkdown: ({ content }: { content: string }) => <div data-work-md>{content}</div>,
  LiveElapsed: ({ startedAt }: { startedAt: string }) => <span data-live-elapsed>{startedAt}</span>,
}));

import { SessionTimeline, TimelineSegment } from "./session-timeline.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function segment(id: string, content: string, sealed = true): TimelineSegmentView {
  return {
    segment_id: id,
    segment_index: 0,
    content,
    byte_length: new TextEncoder().encode(content).byteLength,
    sealed,
  };
}

function turns(count: number): TimelineTurnView[] {
  return Array.from({ length: count }, (_, index) => ({
    timeline_index: index,
    turn_id: `turn-${index}`,
    run_id: `run-${index}`,
    status: "succeeded",
    blocks: [],
  }));
}

const timelineProps = {
  activeRunId: null as string | null,
  hasEarlier: false,
  loadingBlockId: null,
  loadingEarlier: false,
  onLoadEarlier: vi.fn(),
  onLoadSegments: vi.fn(),
};

function timelineTurn(kind: TimelineBlockView["kind"], segments: TimelineSegmentView[]): TimelineTurnView[] {
  const running = segments.some((value) => !value.sealed);
  return [{
    timeline_index: 0,
    turn_id: "turn-1",
    run_id: "run-1",
    status: running ? "running" : "succeeded",
    blocks: [{
      block_id: `${kind}-1`,
      block_index: 0,
      kind,
      status: running ? "running" : "succeeded",
      metadata: {},
      segments,
      next_segment_cursor: null,
    }],
  }];
}

describe("SessionTimeline", () => {
  it("mounts only the server-provided Turn window", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<SessionTimeline
      activeRunId={null}
      hasEarlier
      loadingBlockId={null}
      loadingEarlier={false}
      onLoadEarlier={vi.fn()}
      onLoadSegments={vi.fn()}
      turns={turns(50)}
    />));
    expect(host.querySelectorAll("[data-timeline-turn]")).toHaveLength(50);
    expect(host.querySelector("[data-load-earlier]")).not.toBeNull();
    act(() => root.unmount());
    host.remove();
  });

  it("does not rerender an unchanged completed Segment", () => {
    markdownRender.mockClear();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<TimelineSegment segment={segment("stable", "完成内容")} />));
    act(() => root.render(<TimelineSegment segment={segment("stable", "完成内容")} />));
    expect(markdownRender).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    host.remove();
  });

  it("parses at most one sixteen-KiB active tail", () => {
    const active = segment("active", "x".repeat(16_384), false);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<TimelineSegment segment={active} />));
    expect(host.querySelector("[data-active-segment]")?.textContent).toHaveLength(16_384);
    act(() => root.unmount());
    host.remove();
  });

  it("does not replay reveal motion for initially hydrated Assistant segments", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<SessionTimeline
      {...timelineProps}
      activeRunId="run-1"
      turns={timelineTurn("assistant", [segment("already-present", "已有内容", false)])}
    />));

    const hydrated = host.querySelector('[data-segment-id="already-present"]');
    expect(hydrated?.classList.contains("assistant-reveal")).toBe(false);
    expect(hydrated?.hasAttribute("data-streaming-caret")).toBe(true);
    act(() => root.unmount());
    host.remove();
  });

  it("reveals only a newly appended unsealed Assistant segment", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<SessionTimeline
      {...timelineProps}
      activeRunId="run-1"
      turns={timelineTurn("assistant", [segment("stable", "第一段")])}
    />));
    act(() => root.render(<SessionTimeline
      {...timelineProps}
      activeRunId="run-1"
      turns={timelineTurn("assistant", [
        segment("stable", "第一段"),
        segment("live", "第二段", false),
      ])}
    />));

    expect(host.querySelector('[data-segment-id="stable"]')?.classList.contains("assistant-reveal")).toBe(false);
    expect(host.querySelector('[data-segment-id="live"]')?.classList.contains("assistant-reveal")).toBe(true);
    expect(host.querySelectorAll("[data-streaming-caret]")).toHaveLength(1);
    act(() => root.unmount());
    host.remove();
  });

  it("does not animate a stale running thought without an active Run", () => {
    const stale = timelineTurn("thought", [segment("stale-thought", "已经完成", false)]);
    stale[0]!.status = "succeeded";
    stale[0]!.blocks[0]!.status = "running";
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);

    act(() => root.render(<SessionTimeline {...timelineProps} turns={stale} />));

    expect(host.querySelector(".animate-spin")).toBeNull();
    expect(host.querySelector("details")?.hasAttribute("open")).toBe(true);
    expect(host.querySelector("[data-streaming-caret]")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });

  it("animates thought only when its Run is active", () => {
    const active = timelineTurn("thought", [segment("live-thought", "正在推理", false)]);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);

    act(() => root.render(<SessionTimeline
      {...timelineProps}
      activeRunId="run-1"
      turns={active}
    />));

    expect(host.querySelector(".animate-spin")).not.toBeNull();
    expect(host.querySelector("details")?.hasAttribute("open")).toBe(true);
    expect(host.textContent).toContain("工作中");
    expect(host.querySelector("[data-live-elapsed]")).not.toBeNull();
    expect(host.querySelector("[data-work-md]")?.textContent).toBe("正在推理");
    expect(host.querySelector("[data-answer-md]")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });

  it("shows live work elapsed without mixing process copy into the Agent body", async () => {
    const active = timelineTurn("work", [segment("live-work", "执行中", false)]);
    active[0]!.blocks[0]!.metadata = { started_at: "2026-08-18T06:00:00.000Z" };
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);

    act(() => root.render(<SessionTimeline
      {...timelineProps}
      activeRunId="run-1"
      turns={active}
    />));

    expect(host.textContent).toContain("工作中");
    expect(host.querySelector("[data-live-elapsed]")?.textContent).toBe("2026-08-18T06:00:00.000Z");
    expect(host.querySelector("[data-work-md]")?.textContent).toBe("执行中");
    act(() => root.unmount());
    host.remove();
  });

  it("does not reveal sealed segments introduced by earlier-page loading", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<SessionTimeline
      {...timelineProps}
      turns={timelineTurn("assistant", [segment("recent", "最近内容")])}
    />));
    act(() => root.render(<SessionTimeline
      {...timelineProps}
      turns={timelineTurn("assistant", [
        segment("earlier", "更早内容"),
        segment("recent", "最近内容"),
      ])}
    />));

    expect(host.querySelector('[data-segment-id="earlier"]')?.classList.contains("assistant-reveal")).toBe(false);
    expect(host.querySelector('[data-segment-id="recent"]')?.classList.contains("assistant-reveal")).toBe(false);
    act(() => root.unmount());
    host.remove();
  });

  it("treats a remounted Session snapshot as hydrated history", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<SessionTimeline
      {...timelineProps}
      key="session-a"
      turns={timelineTurn("assistant", [segment("session-a-live", "A", false)])}
    />));
    act(() => root.render(<SessionTimeline
      {...timelineProps}
      key="session-b"
      turns={timelineTurn("assistant", [segment("session-b-live", "B", false)])}
    />));

    expect(host.querySelector('[data-segment-id="session-b-live"]')?.classList.contains("assistant-reveal")).toBe(false);
    act(() => root.unmount());
    host.remove();
  });

  it("shows only one live process spinner when thought and empty work are both running", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<SessionTimeline
      {...timelineProps}
      activeRunId="run-1"
      turns={[{
        timeline_index: 0,
        turn_id: "turn-1",
        run_id: "run-1",
        status: "running",
        blocks: [
          {
            block_id: "work-1",
            block_index: 0,
            kind: "work",
            status: "running",
            metadata: { started_at: "2026-08-18T06:00:00.000Z" },
            segments: [],
            next_segment_cursor: null,
          },
          {
            block_id: "thought-1",
            block_index: 1,
            kind: "thought",
            status: "running",
            metadata: { started_at: "2026-08-18T06:00:01.000Z" },
            segments: [segment("live-thought", "正在推理", false)],
            next_segment_cursor: 1,
          },
        ],
      }]}
    />));

    expect(host.querySelectorAll(".animate-spin")).toHaveLength(1);
    expect(host.querySelectorAll("details")).toHaveLength(1);
    expect(host.textContent).toContain("工作中");
    expect(host.textContent).not.toContain("加载更多输出");
    act(() => root.unmount());
    host.remove();
  });

  it("keeps earlier thought expanded while a later thought is still streaming", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<SessionTimeline
      {...timelineProps}
      activeRunId="run-1"
      turns={[{
        timeline_index: 0,
        turn_id: "turn-1",
        run_id: "run-1",
        status: "running",
        blocks: [
          {
            block_id: "thought-1",
            block_index: 0,
            kind: "thought",
            status: "completed",
            metadata: {
              started_at: "2026-08-18T06:00:00.000Z",
              ended_at: "2026-08-18T06:00:04.000Z",
            },
            segments: [segment("earlier-thought", "先看本机有没有 FlClash")],
            next_segment_cursor: null,
          },
          {
            block_id: "thought-2",
            block_index: 1,
            kind: "thought",
            status: "running",
            metadata: { started_at: "2026-08-18T06:00:05.000Z" },
            segments: [segment("later-thought", "接着搜配置文件", false)],
            next_segment_cursor: null,
          },
        ],
      }]}
    />));

    const details = [...host.querySelectorAll("details")];
    expect(details).toHaveLength(1);
    expect(details[0]?.hasAttribute("open")).toBe(true);
    expect(host.textContent).toContain("工作中");
    expect(host.textContent).toContain("推理 4s");
    expect(host.textContent).toContain("先看本机有没有 FlClash");
    expect(host.textContent).toContain("接着搜配置文件");
    expect(host.querySelectorAll(".animate-spin")).toHaveLength(1);
    act(() => root.unmount());
    host.remove();
  });

  it("keeps elapsed after a process block completes", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<SessionTimeline
      {...timelineProps}
      turns={[{
        timeline_index: 0,
        turn_id: "turn-1",
        run_id: "run-1",
        status: "succeeded",
        blocks: [{
          block_id: "work-1",
          block_index: 0,
          kind: "work",
          status: "completed",
          metadata: {
            started_at: "2026-08-18T06:00:00.000Z",
            ended_at: "2026-08-18T06:00:12.000Z",
          },
          segments: [segment("done-work", "已完成")],
          next_segment_cursor: null,
        }],
      }]}
    />));

    expect(host.querySelector(".animate-spin")).toBeNull();
    expect(host.textContent).toContain("耗时 12s");
    expect(host.querySelector("[data-live-elapsed]")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });

  it("folds consecutive thoughts into one worked-for summary", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<SessionTimeline
      {...timelineProps}
      turns={[{
        timeline_index: 0,
        turn_id: "turn-1",
        run_id: "run-1",
        status: "succeeded",
        blocks: [
          {
            block_id: "thought-1",
            block_index: 0,
            kind: "thought",
            status: "completed",
            metadata: {
              started_at: "2026-08-18T06:00:00.000Z",
              ended_at: "2026-08-18T06:00:01.000Z",
            },
            segments: [segment("thought-a", "第一轮")],
            next_segment_cursor: null,
          },
          {
            block_id: "thought-2",
            block_index: 1,
            kind: "thought",
            status: "completed",
            metadata: {
              started_at: "2026-08-18T06:00:01.000Z",
              ended_at: "2026-08-18T06:00:04.000Z",
            },
            segments: [segment("thought-b", "第二轮")],
            next_segment_cursor: null,
          },
        ],
      }]}
    />));

    expect(host.querySelectorAll("details")).toHaveLength(1);
    expect(host.textContent).toContain("耗时 4s");
    expect(host.textContent).toContain("推理 1s");
    expect(host.textContent).toContain("推理 3s");
    expect(host.textContent).toContain("第一轮");
    expect(host.textContent).toContain("第二轮");
    act(() => root.unmount());
    host.remove();
  });

  it("does not add the Assistant caret to active work blocks", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<SessionTimeline
      {...timelineProps}
      activeRunId="run-1"
      turns={timelineTurn("work", [segment("work-live", "执行中", false)])}
    />));

    expect(host.querySelector('[data-segment-id="work-live"]')?.hasAttribute("data-active-segment")).toBe(true);
    expect(host.querySelector("[data-streaming-caret]")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});
