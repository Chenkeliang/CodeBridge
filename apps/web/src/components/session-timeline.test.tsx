// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { TimelineSegmentView, TimelineTurnView } from "@/lib/types";

const markdownRender = vi.hoisted(() => vi.fn());
vi.mock("@/components/conversation", () => ({
  Markdown: ({ content }: { content: string }) => {
    markdownRender(content);
    return <div>{content}</div>;
  },
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

describe("SessionTimeline", () => {
  it("mounts only the server-provided Turn window", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<SessionTimeline
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
});
